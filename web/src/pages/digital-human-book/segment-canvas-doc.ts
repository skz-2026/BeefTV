import { bindCanvasNodeResourceAsset, bindMissingCanvasResourceAssets, canvasNodeResourceId } from "@/lib/canvas/canvas-node-asset";
import { http } from "@/services/api/request";
import { ensureCanvasNodeAsset } from "@/services/project-asset-sync";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";
import { DIGITAL_HUMAN_ASPECTS, type DigitalHumanAspect, type PersonaSnapshot, type SceneNodeInfo, type SegmentNodeInfo } from "@/services/digital-human-doc";
import { placementFramePrompt, sceneImagePrompt } from "@/services/digital-human-media";
import { formatSegmentCards, PULL_KEY } from "./segment-canvas-merge";

// 段画布：一个镜头一份真实画布文档（id = `{册画布id}__{段id}`）。
//
// 为什么不是"一本册一张画布"：16 段平铺在一张画布里既挤又难管，镜头之间还会互相干扰。
// 这里把每个镜头的要素（台词/配音/场景图/站位首帧/人物稿/信息卡/段视频）落成一份独立
// 画布，画布库里能单独打开、单独命名、单独清理。
//
// 事实来源仍是册画布里的 seg-* 节点与 config（生成、合成、导出都读那边），段画布是
// **同步出来的镜头工作台**：内容变化时按指纹刷新，用户自己调过的排版位置（position）
// 保留不动。锁死节点会让"自由排版"失效，所以不设置 locked；内容以生产页为准。

const SYNC_HASH = "dhSegmentSyncHash";
/** 版面版本：改版面时 +1，老画布会按新版面重排一次（之后保留用户自己拖的位置） */
const LAYOUT_VERSION = 8;

export type SegmentCanvasDoc = {
    id: string;
    title: string;
    /** 归属的册画布 id：画布库把它折叠成一张卡，画布顶栏用它列子画布 */
    workspaceProjectId: string;
    /** 子画布在册里的名字（顶栏切换器显示，比 title 短） */
    canvasTitle: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

type BuildInput = {
    bookId: string;
    bookTitle: string;
    seg: SegmentNodeInfo;
    scene?: SceneNodeInfo;
    persona?: PersonaSnapshot;
    aspect?: string;
    /** 册画布配置的生图模型，必须带 `channel::model`（通用画布读 metadata.model 预填） */
    imageModel?: string;
    /** 首帧是两图合成，挂 qwen-edit-plus 这类图生图模型；缺省回落 imageModel */
    frameModel?: string;
    /** 段视频模型（`channel::model`），缺省时节点仍是生成节点但需在面板里选模型 */
    videoModel?: string;
    /** 册画布的节点：段画布里的场景图/段视频直接复用它们的素材归属（assetId），
     *  这样落库时不用再为同一份资源重复建素材。 */
    sourceNodes?: CanvasNodeData[];
};

export function segmentCanvasId(bookId: string, segId: string) {
    return `${bookId}__${segId}`;
}

/** 节点标题里显示的短音色名：让"用的是谁的声音"在画布上直接可读 */
function voiceLabel(voice?: string) {
    const raw = (voice ?? "").trim();
    if (!raw) return "未绑定音色";
    return VOICE_LABELS[raw] ?? raw;
}

const VOICE_LABELS: Record<string, string> = {
    "xiaozhi-girl": "小智女孩",
    "ameng": "阿猛",
    "alloy": "alloy",
};

function fileUrl(storageKey?: string | null) {
    return storageKey ? `/api/resources/${storageKey.replace(/^resource:/, "")}/file` : undefined;
}

function resourceUrl(resourceId?: string | null) {
    return resourceId ? `/api/resources/${resourceId}/file` : undefined;
}

/**
 * 版面：两行三列的因果链
 *   上排（画面）：场景 → 站位首帧 → 段视频
 *   下排（声音）：台词 → 配音生成 → 配音结果
 *   右列（素材）：人物稿、信息卡、说明
 * 尺寸按画布编辑器的真实渲染尺寸给（图/视频 420×764 竖屏），否则落库后在编辑器里
 * 会被自动撑开、挤成一团。
 *
 * 语义字段很关键：画布靠 `nodeRole` / `resultOrigin` / `prompt` 判断一个媒体节点
 * 是"结果"还是"能生成的节点"。缺了这些字段，节点就只是个死图片/死播放器——
 * 既打不开生成面板，也看不到台词和音色。
 */
const MEDIA_W = 420;
const MEDIA_H = 764;
const COL = [0, 480, 960, 1440];
const ROW_TOP = 0;
const ROW_BOTTOM = 820;

/** 段画布的节点图：上排画面链路，下排声音链路，右列素材 */
export function buildSegmentCanvasDoc(input: BuildInput): SegmentCanvasDoc & { hash: string } {
    const { bookId, bookTitle, seg, scene, persona, imageModel, frameModel, videoModel, aspect } = input;
    const id = segmentCanvasId(bookId, seg.id);
    const now = new Date().toISOString();
    const cards = (seg.cards ?? []).filter((c) => c.title.trim() || c.highlight?.trim() || c.lines?.length);
    const geo = DIGITAL_HUMAN_ASPECTS[(aspect ?? "9:16") as DigitalHumanAspect] ?? DIGITAL_HUMAN_ASPECTS["9:16"];
    const size = `${geo.width}x${geo.height}`;

    const node = (
        nid: string,
        type: string,
        title: string,
        position: { x: number; y: number },
        width: number,
        height: number,
        metadata: Record<string, unknown>,
    ): CanvasNodeData => ({ id: nid, type: type as CanvasNodeData["type"], title, position, width, height, createdAt: now, updatedAt: now, metadata: metadata as CanvasNodeData["metadata"] });

    // 图片节点：都按「AI 生成结果」登记（resultOrigin=generated + prompt），
    // 这样工具条会给出生成设置、双击能改提示词重新生成；素材归属仍照旧。
    // `dhModel` 落到 metadata.model（通用画布读这个字段预填模型），`dhPull` 记同步时
    // 册里的产物——画布侧产物与它不同即视为用户重出了，由 segment-canvas-merge 回写册。
    const imageNode = (
        nid: string,
        title: string,
        position: { x: number; y: number },
        storageKey: string | null | undefined,
        prompt: string,
        extra: Record<string, unknown> = {},
    ) => {
        const { dhModel, ...rest } = extra;
        return node(nid, "image", title, position, MEDIA_W, MEDIA_H, {
            ...(fileUrl(storageKey) ? { content: fileUrl(storageKey) } : {}),
            ...(storageKey ? { storageKey } : {}),
            status: storageKey ? "success" : "idle",
            nodeRole: "result",
            resultOrigin: "generated",
            // 没有 generationType 的图片节点会被当成"素材源图"（isCanvasImageSourceNode），
            // 画布就不给它开生成面板——主画布的真实生成图都带这个标记。
            generationType: "generation",
            prompt: prompt || "",
            ...(typeof dhModel === "string" && dhModel ? { model: dhModel } : {}),
            size,
            [PULL_KEY]: storageKey ?? "",
            ...rest,
        });
    };

    // 首帧节点的默认提示词就是"合成"语义：把主播放进场景里。
    // 与生产页 generatePlacementFrame 用同一份文案，画布上直接点生成不走样。
    const framePrompt = placementFramePrompt(persona?.style, (aspect ?? "9:16") as DigitalHumanAspect).prompt;

    const nodes: CanvasNodeData[] = [
        node("wf-script", "text", seg.line.trim() ? "① 台词" : "① 台词 · 未写", { x: COL[0], y: ROW_BOTTOM }, 420, 200, {
            content: seg.line || "（未写台词，双击编辑后再去配音节点生成）",
            nodeRole: "resource",
            [PULL_KEY]: seg.line || "",
        }),
        // 配音节点同时是「生成节点」和「结果」：带着台词、音色、模型，
        // 双击就出音频生成面板；已经有音频时节点本身显示波形波形可播放。
        // 这样"制作过程"和"成片"在同一个节点上，重新生成会原地替换。
        node("wf-voice", "audio", seg.audio ? `② 配音 · ${voiceLabel(persona?.voice)}` : "② 配音 · 未生成", { x: COL[1], y: ROW_BOTTOM }, 420, 240, {
            ...(seg.audio?.url ? { content: seg.audio.url } : {}),
            ...(seg.audio?.storageKey ? { storageKey: seg.audio.storageKey } : {}),
            status: seg.audio ? "success" : "idle",
            nodeRole: "generator",
            resultOrigin: "generated",
            prompt: seg.line || "",
            ...(persona?.voice ? { audioVoice: persona.voice } : {}),
            ...(persona?.voiceModel ? { audioModel: persona.voiceModel, model: persona.voiceModel } : {}),
            ...(persona?.voiceInstructions ? { audioInstructions: persona.voiceInstructions } : {}),
            audioFormat: "wav",
            audioSpeed: "1.0",
            ...(seg.audio ? { durationMs: seg.audio.durationMs, voice: seg.audio.voice } : {}),
            // 回写比对锚点：画布侧重配的配音与这个值不同即视为用户产物
            [PULL_KEY]: seg.audio?.storageKey ?? "",
        }),
    ];

    if (scene) {
        // 场景提示词也走生产页同一个函数：画布上直接点生成，必须和页内生成写出同一句话
        // （多了"前景留空地"这句，首帧合成才不会多造一把椅子）。
        nodes.push(imageNode(`scene-${scene.key}`, `① 场景底图 · ${scene.name}`, { x: COL[0], y: ROW_TOP }, scene.imageStorageKey, sceneImagePrompt(scene.promptEn, persona?.style, (aspect ?? "9:16") as DigitalHumanAspect).prompt, {
            promptEn: scene.promptEn,
            sceneKey: scene.key,
            sceneName: scene.name,
            dhModel: imageModel,
            // 首帧没有顶层 storageKey，回写时单独比对
            framePull: scene.frameStorageKey ?? "",
        }));
    }

    nodes.push(imageNode(
        "wf-frame",
        scene?.frameStorageKey ? "② 站位首帧" : scene?.imageStorageKey ? "② 站位首帧 · 未生成" : "② 站位首帧 · 待场景图",
        { x: COL[1], y: ROW_TOP },
        scene?.frameStorageKey,
        framePrompt,
        {
            // 首帧 = 主播形象 + 场景底图 两图合成，必须挂支持多图参考的图生图模型
            dhModel: frameModel ?? imageModel,
            promptTemplateOperation: "compose",
        },
    ));

    nodes.push(node("wf-persona", "image", `① 主播形象 · ${persona?.name ?? "未配置"}`, { x: COL[3], y: ROW_TOP }, MEDIA_W, MEDIA_H, {
        ...(fileUrl(persona?.portraitStorageKey) ? { content: fileUrl(persona?.portraitStorageKey) } : {}),
        ...(persona?.portraitStorageKey ? { storageKey: persona.portraitStorageKey } : {}),
        status: persona?.portraitStorageKey ? "success" : "idle",
        nodeRole: "result",
        resultOrigin: "generated",
        generationType: "generation",
        prompt: persona?.appearanceEn ?? "",
        ...(imageModel ? { model: imageModel } : {}),
        size,
        // 主播图属于数字人画布（跨期复用），段画布上只作参考图，不参与册回写
        dhGlobalPersona: true,
        [PULL_KEY]: persona?.portraitStorageKey ?? "",
    }));

    const cardsText = formatSegmentCards(cards);
    nodes.push(node("wf-cards", "text", cards.length ? `③ 信息卡 · ${cards.length} 张` : "③ 信息卡 · 未配置", { x: COL[3], y: ROW_BOTTOM }, 420, 200, {
        // 没有卡片时保持空文本：文本节点的内容会被拼进下游生成的提示词，
        // 占位提示语混进 H3 的提示词里会让它去"念"这句提示语。
        content: cardsText,
        nodeRole: "resource",
        // 信息卡是成片合成时叠加的图层，不是段视频的提示词素材
        dhOverlayText: true,
        [PULL_KEY]: cardsText,
    }));

    const trimLabel = seg.videoTrimStartMs || seg.videoTrimEndMs
        ? ` · 剪 ${((seg.videoTrimStartMs ?? 0) / 1000).toFixed(1)}–${((seg.videoTrimEndMs ?? seg.videoDurationMs ?? 0) / 1000).toFixed(1)}s`
        : "";
    nodes.push(node(`seg-${seg.id}`, "video", `${seg.id}${seg.videoResourceId ? " · 口播段" : " · 未生成"}${trimLabel}`, { x: COL[2], y: ROW_TOP }, MEDIA_W, MEDIA_H, {
        ...(resourceUrl(seg.videoResourceId) ? { content: resourceUrl(seg.videoResourceId) } : {}),
        ...(seg.videoStorageKey ? { storageKey: seg.videoStorageKey } : {}),
        status: seg.videoResourceId ? "success" : "idle",
        nodeRole: "result",
        resultOrigin: "generated",
        generationType: "generation",
        prompt: seg.videoPrompt || "",
        ...(videoModel ? { model: videoModel } : {}),
        size,
        // dub-flf 契约：提示词里的 <Picture 1/2/3> = 首帧 / 尾帧 / 身份参考。
        // 画布上只连了「站位首帧」「主播形象」两条线（缺尾帧槽），由生成上下文按这个
        // 标记把首帧复制到尾帧位——否则 H3 会把人物稿当尾帧，渲成"人像从画外飘进来"。
        dhVideoTemplate: "first-last-frame",
        dhFrameSourceNodeId: "wf-frame",
        ...(seg.videoResourceId ? { videoResourceId: seg.videoResourceId } : {}),
        ...(seg.videoDurationMs ? { durationMs: seg.videoDurationMs } : {}),
        [PULL_KEY]: seg.videoStorageKey ?? "",
    }));

    const hash = JSON.stringify([
        LAYOUT_VERSION, bookTitle, seg.id, seg.line, seg.videoResourceId ?? "", seg.audio?.storageKey ?? "", scene?.imageStorageKey ?? "",
        scene?.frameStorageKey ?? "", persona?.portraitStorageKey ?? "", persona?.name ?? "", persona?.voice ?? "",
        cards.map((c) => [c.title, c.highlight ?? "", (c.lines ?? []).map((l) => l.text)]),
    ]);

    nodes.push(node("dh-note", "text", "本画布说明", { x: COL[3], y: ROW_BOTTOM + 260 }, 420, 240, {
        content: [
            `《${bookTitle}》${seg.id} 的镜头画布 —— 这个镜头的生产台。`,
            "",
            "① 素材：台词、主播形象、场景底图、信息卡",
            "② 中间件：配音（台词 + 音色）、站位首帧（主播 + 场景 两张连线合成）",
            "③ 成片：段视频（首帧构图 + 人物身份 + 参考音频驱动口型），信息卡与字幕在合成时叠加",
            "",
            "连线就是参考关系：上游连过来的图/音频会自动成为生成时的参考素材。",
            "在这里重出的场景图/首帧/配音/段视频，回生产页会自动收回成片链路。",
        ].join("\n"),
        nodeRole: "resource",
        [SYNC_HASH]: hash,
        dhLayout: LAYOUT_VERSION,
        dhBookId: bookId,
        dhSegmentId: seg.id,
    }));

    const connections: CanvasConnection[] = [
        { id: "dh-c-line-voice", fromNodeId: "wf-script", toNodeId: "wf-voice" },
        { id: "dh-c-voice-video", fromNodeId: "wf-voice", toNodeId: `seg-${seg.id}` },
        // 顺序有意义：画布把入边按连接顺序翻成参考图槽位，首帧必须排第 1 位
        { id: "dh-c-frame-video", fromNodeId: "wf-frame", toNodeId: `seg-${seg.id}` },
        { id: "dh-c-persona-video", fromNodeId: "wf-persona", toNodeId: `seg-${seg.id}` },
        { id: "dh-c-cards-video", fromNodeId: "wf-cards", toNodeId: `seg-${seg.id}` },
        { id: "dh-c-persona-frame", fromNodeId: "wf-persona", toNodeId: "wf-frame" },
        ...(scene ? [{ id: "dh-c-scene-frame", fromNodeId: `scene-${scene.key}`, toNodeId: "wf-frame" }] : []),
    ];

    // workspaceProjectId 指回册画布：画布库按它把 16 份段画布折叠成一张卡，
    // 画布顶栏按它把子画布列成切换器——"一个项目 N 个子画布"，而不是 16 个散项目。
    return { id, title: segmentCanvasTitle(bookTitle, seg.id), workspaceProjectId: bookId, canvasTitle: `${seg.id} · 口播段`, nodes, connections, hash };
}

/** 画布库里的标题：段号在前（P01…P16 便于排序扫读），册名在后做区分 */
export function segmentCanvasTitle(bookTitle: string, segId: string) {
    const book = bookTitle.trim();
    const raw = book ? `${segId} · ${book}` : `${segId} · 镜头画布`;
    return raw.length > 28 ? `${raw.slice(0, 27)}…` : raw;
}

const docCache = new Map<string, SegmentCanvasDoc & { hash: string }>();

const MEDIA_TYPES = new Set(["image", "video", "audio"]);

function hasMediaRef(node: CanvasNodeData) {
    return MEDIA_TYPES.has(String(node.type)) && Boolean(node.metadata?.storageKey || node.metadata?.content);
}

/**
 * 素材归属：后端画布合同要求「画布引用的资源必须是一份本账号名下的素材」，
 * 所以资源型节点在落库前必须带上 metadata.assetId。顺序：
 *   1. 复用册画布里同一资源的 assetId（场景图、段视频天然有）
 *   2. 复用素材库中同一资源的资产（配音、首帧、人物稿）
 *   3. 都没有才登记一份新素材（ensureCanvasNodeAsset，写 /assets/:id）
 * 仍然绑不上的媒体节点降级成占位节点，绝不因为一个节点让整份画布存不进去。
 */
async function bindSegmentMediaAssets(nodes: CanvasNodeData[], sourceNodes: CanvasNodeData[], assets: Asset[], canvasId: string) {
    const inherited = nodes.map((node) => (hasMediaRef(node) ? bindCanvasNodeResourceAsset(node, sourceNodes, assets) : node));
    let bound = inherited;
    try {
        bound = await bindMissingCanvasResourceAssets(inherited, assets, async (node) => {
            try {
                const result = await ensureCanvasNodeAsset({ canvasId, node, source: "canvas-manual" });
                return { assetId: result.assetId };
            } catch {
                return { assetId: "" };
            }
        });
    } catch {
        bound = inherited;
    }
    let degraded = false;
    const safe = bound.map((node) => {
        if (!hasMediaRef(node) || node.metadata?.assetId) return node;
        // 兜底：去掉资源引用，保留节点作为占位（内容仍写在这份画布的说明里）
        degraded = true;
        const { storageKey: _storageKey, content: _content, videoResourceId: _videoResourceId, ...rest } = (node.metadata ?? {}) as Record<string, unknown>;
        return {
            ...node,
            title: node.title.includes("素材未入库") ? node.title : `${node.title} · 素材未入库`,
            metadata: { ...rest, status: "idle" } as CanvasNodeData["metadata"],
        };
    });
    return { nodes: safe, degraded };
}

/**
 * 读取/同步某段的画布文档：
 * - 不存在 → 用当前段数据建一份（PUT upsert，和建册同一通道）
 * - 已存在 → 指纹一致就直接用（一次 GET）；不一致只刷新内容并保留用户排版
 *
 * 同一份内容可能被同时触发多次（当前段 effect + 后台补齐、重挂载后的第二次补），
 * 并发时会各自登记一份「配音」素材、并把 PUT 打成 revision 冲突，所以按 id+指纹去重。
 */
const inflight = new Map<string, Promise<SegmentCanvasDoc | null>>();

export function loadSegmentCanvasDoc(input: BuildInput): Promise<SegmentCanvasDoc | null> {
    const built = buildSegmentCanvasDoc(input);
    const cached = docCache.get(built.id);
    if (cached && cached.hash === built.hash) return Promise.resolve(cached);
    const key = `${built.id}#${built.hash}`;
    const pending = inflight.get(key);
    if (pending) return pending;
    const request = syncSegmentCanvasDoc(built, input.sourceNodes ?? []).finally(() => inflight.delete(key));
    inflight.set(key, request);
    return request;
}

async function syncSegmentCanvasDoc(built: SegmentCanvasDoc & { hash: string }, sourceNodes: CanvasNodeData[]): Promise<SegmentCanvasDoc | null> {
    const cached = docCache.get(built.id);
    if (cached && cached.hash === built.hash) return cached;

    let existing: { nodes?: CanvasNodeData[]; connections?: CanvasConnection[]; revision?: number; workspaceProjectId?: string } | null = null;
    try {
        const res = await http.get<{ project: { nodes?: CanvasNodeData[]; connections?: CanvasConnection[]; revision?: number; workspaceProjectId?: string } }>(`/canvas-projects/${encodeURIComponent(built.id)}`);
        existing = res.project ?? null;
    } catch {
        existing = null; // 404 = 还没建
    }

    const existingNoteMeta = (existing?.nodes ?? []).find((n) => n.id === "dh-note")?.metadata as Record<string, unknown> | undefined;
    // 老版面的画布按新版面重排一次；之后用户自己拖的位置要保留
    const keepLayout = Number(existingNoteMeta?.dhLayout ?? 0) === LAYOUT_VERSION;

    const existingById = new Map((existing?.nodes ?? []).map((n) => [n.id, n]));
    const mergedNodes = built.nodes.map((n) => {
        const prev = existingById.get(n.id);
        const pos = prev?.position;
        const placed = keepLayout && pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) ? { ...n, position: pos } : n;
        // 素材归属跟着资源走：同一份资源重同步时沿用上次的 assetId，
        // 否则每次刷新内容都会再登记一份重复素材。
        const prevAsset = prev?.metadata?.assetId;
        const sameResource = prev && canvasNodeResourceId(prev) && canvasNodeResourceId(prev) === canvasNodeResourceId(placed);
        if (prevAsset && !placed.metadata?.assetId && sameResource) {
            return { ...placed, metadata: { ...placed.metadata, assetId: prevAsset } };
        }
        return placed;
    });
    const doc: SegmentCanvasDoc & { hash: string } = { id: built.id, title: built.title, workspaceProjectId: built.workspaceProjectId, canvasTitle: built.canvasTitle, nodes: mergedNodes, connections: built.connections, hash: built.hash };

    // 内容没变也要补写一次归属：老画布可能是在"子画布"概念之前建的，缺 workspaceProjectId，
    // 只靠指纹判断会永远跳过它，画布库就继续把它当独立项目。
    const ownershipMissing = Boolean(existing) && existing?.workspaceProjectId !== built.workspaceProjectId;
    if (existing && existingNoteMeta?.[SYNC_HASH] === built.hash && !ownershipMissing) {
        docCache.set(built.id, doc);
        return doc;
    }

    const { nodes: saveNodes } = await bindSegmentMediaAssets(mergedNodes, sourceNodes, useAssetStore.getState().assets, built.id);

    const save = (revision: number) => http.put(`/canvas-projects/${encodeURIComponent(built.id)}`, {
        project: {
            id: built.id,
            title: built.title,
            // 归属关系必须一起落库：只写 id/title 的话，下一次水合就退回"独立项目"，
            // 画布库又会散成 16 张卡。
            workspaceProjectId: built.workspaceProjectId,
            canvasTitle: built.canvasTitle,
            nodes: saveNodes,
            connections: built.connections,
            createdAt: saveNodes[0]?.createdAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            revision,
        },
        assets: [],
    });

    try {
        try {
            await save(existing?.revision ?? 0);
        } catch {
            // revision 冲突：同一个镜头可能同时被"当前段"和"后台补齐"写，
            // 重拉一次最新版本再写，避免整份画布因为一次 409 就停在旧版面。
            const fresh = await http.get<{ project: { revision?: number } }>(`/canvas-projects/${encodeURIComponent(built.id)}`).catch(() => null);
            await save(fresh?.project?.revision ?? 0);
        }
        const saved: SegmentCanvasDoc & { hash: string } = { ...doc, nodes: saveNodes };
        docCache.set(built.id, saved);
        return saved;
    } catch {
        // 落库失败就让调用方回落到派生视图，不影响生产
        return null;
    }
}
