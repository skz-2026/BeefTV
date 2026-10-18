import type { CanvasNodeData } from "@/types/canvas";
import { http } from "@/services/api/request";
import type { SegmentAudio, SegmentCard } from "@/services/digital-human-doc";
import { storybookLineHash } from "@/services/storybook-audio";

// 段画布 → 册画布的反向回写。
//
// 段画布不只是"展示同步结果"，它同时是这条镜头的生产台：用户在上面用 qwen image
// 重出场景图、用 qwen-edit 合成首帧、用 IndexTTS 重配配音、用 H3 重出段视频。
// 这些产物的落点是画布节点（通用画布引擎天然把上游连线当参考素材），但成片、字幕、
// 导出读的仍是册画布的 seg-* / scene-* 节点——不回写就等于"画布上白干"。
//
// 判定"这个产物是用户在画布上产的"靠 `dhPull`：同步时把册里的产物指纹写进节点，
// 之后节点产物与指纹不一致 = 画布侧改过。没有 dhPull 的老画布一律跳过（宁可不同步，
// 也不能用陈旧画布覆盖生产数据）。

/** 同步时册侧产物指纹，存在节点 metadata 上 */
export const PULL_KEY = "dhPull";

export type SegmentCanvasProducts = {
    /** 台词（wf-script 文本节点） */
    line?: string;
    /** 配音（wf-voice：storageKey + 时长 + 音色） */
    voice?: SegmentAudio;
    /** 场景底图（scene-Sx 顶层媒体） */
    scene?: { storageKey: string; assetId?: string };
    /** 站位首帧（scene-Sx.metadata.frameStorageKey） */
    frame?: { storageKey: string };
    /** 信息卡（wf-cards 文本节点，画布上按人类可读的行格式编辑） */
    cards?: SegmentCard[];
    /** 段视频（seg-Px 顶层媒体） */
    video?: { storageKey: string; resourceId: string; assetId?: string };
};

/**
 * 信息卡 → 画布文本。一行一张卡：
 *   `标题｜金色强调词`
 *   缩进两格 = 这张卡的附注行，前缀 `*` 表示金色附注。
 * 用人类可读的格式而不是 JSON：画布文本节点是直接双击改的，
 * 塞 JSON 进去既难改也容易被一次回车毁掉。
 */
export function formatSegmentCards(cards: SegmentCard[]): string {
    return cards
        .map((card) => {
            const head = [card.title, card.highlight ?? ""].filter(Boolean).join("｜");
            const lines = (card.lines ?? []).map((l) => `    ${l.gold ? "*" : ""}${l.text}`);
            return [head, ...lines].join("\n");
        })
        .filter((block) => block.trim())
        .join("\n");
}

/** 画布文本 → 信息卡（formatSegmentCards 的逆运算；空文本返回空数组） */
export function parseSegmentCardText(text: string): SegmentCard[] {
    const cards: SegmentCard[] = [];
    for (const raw of text.split("\n")) {
        const line = raw.replace(/\s+$/, "");
        if (!line.trim()) continue;
        const indented = /^\s/.test(line);
        if (indented && cards.length) {
            const body = line.trim().replace(/^[-·•]\s*/, "");
            const gold = body.startsWith("*");
            const value = (gold ? body.slice(1) : body).trim();
            if (!value) continue;
            const card = cards[cards.length - 1];
            card.lines = [...(card.lines ?? []), { text: value, ...(gold ? { gold: true } : {}) }];
            continue;
        }
        if (indented) continue;
        const [title, highlight = ""] = line.split(/[｜|]/).map((part) => part.trim());
        if (!title && !highlight) continue;
        cards.push({ id: `card-${cards.length + 1}`, title: title ?? "", ...(highlight ? { highlight } : {}) });
    }
    return cards;
}

function meta(node: CanvasNodeData | undefined): Record<string, unknown> {
    return (node?.metadata ?? {}) as Record<string, unknown>;
}

/** 节点当前产物标识（媒体引用优先 storageKey，其次 content） */
function productKey(node: CanvasNodeData | undefined): string {
    const md = meta(node);
    return String(md.storageKey ?? md.content ?? "");
}

/** 上次同步时册里的产物标识 */
function pulledKey(node: CanvasNodeData | undefined): string {
    return String(meta(node)[PULL_KEY] ?? "");
}

/**
 * 画布侧是否真的产出了新东西：
 * 有产物，且与上次同步时的值不同。老画布（无 dhPull）一律视为不可信。
 *
 * `allowEmpty` 给信息卡这类"清空也是一种编辑"的节点用：内容被删成空串
 * 同样是用户动作，不能当成"没动过"。
 */
export function nodeProducedOnCanvas(node: CanvasNodeData | undefined, opts: { allowEmpty?: boolean } = {}): boolean {
    if (!node) return false;
    // 用"字段存在"而不是"值非空"判断：同步时产物本来为空（没配信息卡）的画布，
    // dhPull 就是空串，之后填了内容同样要算画布侧产出。
    if (!Object.prototype.hasOwnProperty.call(meta(node), PULL_KEY)) return false;
    const pull = pulledKey(node);
    const cur = productKey(node);
    if (!cur) return opts.allowEmpty ? cur !== pull : false;
    return cur !== pull;
}

/** 从资源定位符里取 resourceId（`resource:xxx` / `/api/resources/xxx/file`） */
export function resourceIdOf(storageKey: string): string {
    const raw = storageKey.trim();
    if (raw.startsWith("resource:")) return raw.slice("resource:".length);
    const match = raw.match(/\/api\/resources\/([^/?#]+)/);
    return match ? match[1] : "";
}

/** 读取段画布上"用户在画布侧产出"的字段（未变动的字段留空，交给册侧原值） */
export function readSegmentProducts(doc: { nodes: CanvasNodeData[] }, segId: string): SegmentCanvasProducts {
    const byId = new Map(doc.nodes.map((n) => [n.id, n]));
    const out: SegmentCanvasProducts = {};

    const script = byId.get("wf-script");
    if (script && nodeProducedOnCanvas(script)) {
        const text = String(meta(script).content ?? "").trim();
        // 占位文案（未写台词的提示语）不回写，避免把提示语当成台词存进册
        if (text && !text.startsWith("（")) out.line = text;
    }

    const voice = byId.get("wf-voice");
    if (voice && nodeProducedOnCanvas(voice)) {
        const md = meta(voice);
        const storageKey = String(md.storageKey ?? "");
        if (storageKey) {
            const line = out.line ?? String(md.prompt ?? "").trim();
            const voiceId = String(md.audioVoice ?? md.voice ?? "");
            const durationMs = Number(md.durationMs) || 0;
            out.voice = {
                storageKey,
                url: String(md.content ?? "") || `/api/resources/${resourceIdOf(storageKey)}/file`,
                durationMs,
                // 波形只到 durationMs（含尾部静音），字幕窗口按台词字数估一档，宁可略长
                speechMs: Math.max(1200, durationMs - 700),
                textHash: storybookLineHash(line, voiceId),
                voice: voiceId,
                ...(md.mimeType ? { mimeType: String(md.mimeType) } : {}),
                ...(Number(md.bytes) ? { bytes: Number(md.bytes) } : {}),
            };
        }
    }

    // 首帧是独立节点（wf-frame）而不是场景节点的正文，直接按它自己的 dhPull 判定
    const frame = byId.get("wf-frame");
    if (frame && nodeProducedOnCanvas(frame)) {
        const frameKey = String(meta(frame).storageKey ?? "");
        if (frameKey) out.frame = { storageKey: frameKey };
    }

    // 信息卡：允许清空（用户把卡片全删掉也是编辑）
    const cardNode = byId.get("wf-cards");
    if (cardNode && nodeProducedOnCanvas(cardNode, { allowEmpty: true })) {
        const text = String(meta(cardNode).content ?? "");
        if (!text.trim().startsWith("（")) out.cards = text.trim() ? parseSegmentCardText(text) : [];
    }

    for (const node of doc.nodes) {
        if (!node.id.startsWith("scene-")) continue;
        const md = meta(node);
        const storageKey = String(md.storageKey ?? "");
        if (storageKey && nodeProducedOnCanvas(node)) {
            out.scene = { storageKey, ...(md.assetId ? { assetId: String(md.assetId) } : {}) };
        }
    }

    const seg = byId.get(`seg-${segId}`);
    if (seg && nodeProducedOnCanvas(seg)) {
        const md = meta(seg);
        const storageKey = String(md.storageKey ?? "");
        const resourceId = String(md.videoResourceId ?? "") || resourceIdOf(storageKey);
        if (storageKey && resourceId) {
            out.video = { storageKey, resourceId, ...(md.assetId ? { assetId: String(md.assetId) } : {}) };
        }
    }

    return out;
}

function hasAny(p: SegmentCanvasProducts): boolean {
    // cards 用 in 判断：空数组代表"用户清空了卡片"，同样是有效产物
    return Boolean(p.line || p.voice || p.scene || p.frame || p.video) || "cards" in p;
}

/**
 * 把画布侧产物合并进册画布节点。
 * 返回新节点数组与"是否发生变化"；没有产物时原样返回（引用不变，方便调用方跳过写回）。
 */
export function mergeProductsIntoBook(
    nodes: CanvasNodeData[],
    opts: { segId: string; sceneKey: string; products: SegmentCanvasProducts },
): { nodes: CanvasNodeData[]; changed: boolean } {
    const { segId, sceneKey, products } = opts;
    if (!hasAny(products)) return { nodes, changed: false };

    let changed = false;
    const next = nodes.map((node) => {
        const md = { ...meta(node) };
        let touched = false;

        if (node.id === `seg-${segId}`) {
            if (products.line && products.line !== String(md.line ?? "")) {
                md.line = products.line;
                touched = true;
            }
            if (products.voice && products.voice.storageKey !== String((md.audio as SegmentAudio | undefined)?.storageKey ?? "")) {
                md.audio = products.voice;
                touched = true;
            }
            if (products.cards && JSON.stringify(products.cards) !== JSON.stringify(md.cards ?? [])) {
                // 信息卡是合成期叠加层，改它不影响段视频是否过期（视频不用重渲）
                if (products.cards.length) md.cards = products.cards;
                else delete md.cards;
                touched = true;
            }
            if (products.video && products.video.resourceId !== String(md.videoResourceId ?? "")) {
                md.content = `/api/resources/${products.video.resourceId}/file`;
                md.storageKey = products.video.storageKey;
                md.videoResourceId = products.video.resourceId;
                md.status = "success";
                if (products.video.assetId) md.assetId = products.video.assetId;
                // 画布上重出的段视频按当前台词/场景/首帧记指纹，否则会被标成过期
                md.videoLineHash = storybookLineHash(String(md.line ?? ""));
                md.videoSceneKey = String(md.sceneKey ?? "");
                const sceneNode = nodes.find((n) => n.id === `scene-${String(md.sceneKey ?? sceneKey)}`);
                const frameKeyNow = String(sceneNode ? meta(sceneNode).frameStorageKey ?? "" : "");
                if (frameKeyNow) md.videoFrameKey = frameKeyNow;
                touched = true;
            }
        }

        if (node.id === `scene-${sceneKey}`) {
            if (products.scene && products.scene.storageKey !== String(md.storageKey ?? "")) {
                md.content = `/api/resources/${resourceIdOf(products.scene.storageKey)}/file`;
                md.storageKey = products.scene.storageKey;
                md.status = "success";
                if (products.scene.assetId) md.assetId = products.scene.assetId;
                // 换场景图后旧首帧不再匹配（人物站位是按旧场景算的）
                md.frameStorageKey = "";
                touched = true;
            }
            if (products.frame && products.frame.storageKey !== String(md.frameStorageKey ?? "")) {
                md.frameStorageKey = products.frame.storageKey;
                touched = true;
            }
        }

        if (touched) changed = true;
        return touched ? { ...node, metadata: md as CanvasNodeData["metadata"] } : node;
    });

    return { nodes: changed ? next : nodes, changed };
}

/**
 * 生产页加载时把各段画布上的产物收回来。
 *
 * 段画布是用户在画布库里生产镜头的现场：他们在那里重出场景图、合成首帧、重配配音、
 * 重出段视频。回到生产页必须以画布为准——否则"画布上生成了但成片还是旧的"。
 *
 * 并发拉取每一段，任一份失败就跳过该段（不影响整册加载）。
 */
export type SegmentPull = { seg: { id: string; sceneKey: string }; products: SegmentCanvasProducts };

export async function collectSegmentPulls(
    bookId: string,
    segments: Array<{ id: string; sceneKey: string }>,
): Promise<SegmentPull[]> {
    if (!segments.length) return [];
    const docs = await Promise.all(segments.map(async (seg) => {
        try {
            const res = await http.get<{ project: { nodes?: CanvasNodeData[] } }>(`/canvas-projects/${encodeURIComponent(`${bookId}__${seg.id}`)}`);
            return { seg, nodes: res.project?.nodes ?? [] };
        } catch {
            return null;
        }
    }));
    return docs
        .filter((d): d is { seg: { id: string; sceneKey: string }; nodes: CanvasNodeData[] } => !!d && d.nodes.length > 0)
        .map((d) => ({ seg: d.seg, products: readSegmentProducts({ nodes: d.nodes }, d.seg.id) }))
        .filter((p) => Object.keys(p.products).length > 0);
}

/**
 * 把上面收集到的产物逐段合并进册节点（纯函数，便于单测）。
 */
export function applySegmentPulls(
    nodes: CanvasNodeData[],
    pulls: SegmentPull[],
    sceneKeyOf: (seg: { id: string; sceneKey: string }) => string,
): { nodes: CanvasNodeData[]; changed: boolean; touched: string[] } {
    let current = nodes;
    const touched: string[] = [];
    for (const pull of pulls) {
        const merged = mergeProductsIntoBook(current, {
            segId: pull.seg.id,
            sceneKey: sceneKeyOf(pull.seg),
            products: pull.products,
        });
        if (merged.changed) {
            current = merged.nodes;
            touched.push(pull.seg.id);
        }
    }
    return { nodes: current, changed: touched.length > 0, touched };
}
