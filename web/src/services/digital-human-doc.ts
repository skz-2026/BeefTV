import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { http } from "@/services/api/request";
import { storybookLineHash } from "@/services/storybook-audio";

// 数字人口播：画布文档合同（与绘本成书同一模式——数据全在画布节点 metadata）。
// 口播画布 = digitalhuman-config 文本节点 + scene-* 场景图片节点 + seg-P* 口播段视频节点；
// 数字人画布 = digitalhuman-persona 文本节点 + portrait 人物图节点（跨期复用的 IP 资产）。
// 音频/站位首帧等嵌套引用放在 metadata 内层，顶层媒体字段（content/storageKey）只承载
// 节点本体媒体（场景图/段视频），写回走 generated-assets 原子通道。

export type DigitalHumanAspect = "9:16" | "16:9" | "1:1";

export const DIGITAL_HUMAN_ASPECTS: Record<DigitalHumanAspect, { label: string; width: number; height: number }> = {
    "9:16": { label: "竖屏 9:16", width: 704, height: 1280 },
    "16:9": { label: "横屏 16:9", width: 1280, height: 704 },
    "1:1": { label: "方形 1:1", width: 960, height: 960 },
};

/** 数字人画风：人物图与场景图共用同一后缀，跨期保持一致 */
export const DIGITAL_HUMAN_STYLES = {
    realistic: {
        label: "真人写实",
        portraitSuffix: "photorealistic, natural skin texture with visible pores, soft key lighting, 50mm lens, shallow depth of field",
        sceneSuffix: "photorealistic, cinematic lighting, natural environment",
    },
    cartoon3d: {
        label: "三维卡通",
        portraitSuffix: "stylized 3d character render, soft global illumination, appealing proportions, pixar-like",
        sceneSuffix: "stylized 3d environment render, soft global illumination",
    },
    anime: {
        label: "二次元",
        portraitSuffix: "high-quality anime illustration, clean line art, cel shading",
        sceneSuffix: "anime background illustration, clean line art, cel shading",
    },
} as const;
export type DigitalHumanStyleId = keyof typeof DIGITAL_HUMAN_STYLES;

export type SegmentAudio = {
    storageKey: string;
    url: string;
    /** 落库 wav 时长（含尾部安全静音） */
    durationMs: number;
    /** 实际说话时长（补静音前探测），字幕时间轴用 */
    speechMs: number;
    textHash: string;
    voice: string;
    mimeType?: string;
    bytes?: number;
};

/** 建册时从数字人画布快照的人物+音色档案；后续改数字人不影响已建期 */
export type PersonaSnapshot = {
    canvasId: string;
    name: string;
    appearanceEn: string;
    portraitStorageKey: string;
    voice: string;
    /** TTS 模型（channelId::model，如本机 indextts2） */
    voiceModel?: string;
    voiceInstructions?: string;
    style?: DigitalHumanStyleId;
};

export type DigitalHumanConfig = {
    kind: "digitalhuman-config";
    title: string;
    topic: string;
    aspect: DigitalHumanAspect;
    /** 拆分用的文本模型（channelId::model），生产页重生成提示词时复用 */
    textModel: string;
    /** 生图渠道 id（场景图/站位首帧挂 qwen 车道） */
    imageChannel: string;
    videoChannel: string;
    videoModel: string;
    persona: PersonaSnapshot;
    /** 段顺序（seg-P* 节点 id）；重排只改这里 */
    segmentOrder: string[];
};

export type PersonaConfig = {
    kind: "digitalhuman-persona";
    name: string;
    note?: string;
    appearanceEn: string;
    style: DigitalHumanStyleId;
    voice: string;
    /** channelId::model，建册时快照进 persona.voiceModel 语义由口播册 tts 链路沿用 */
    voiceModel: string;
    voiceInstructions?: string;
};

export type SceneNodeInfo = {
    key: string;
    name: string;
    promptEn: string;
    imageStorageKey: string | null;
    /** 站位首帧（人物放入场景）：嵌套引用，普通 PUT 写回 */
    frameStorageKey: string | null;
    nodeIndex: number;
};

/** 段视频候选（抽卡）：同一分镜渲染多张，点选换用，量产择优 */
export type SegmentTake = {
    resourceId: string;
    durationMs?: number;
    /** 渲染时的台词指纹：切回旧候选时若台词已改仍能正确标记过期 */
    lineHash?: string;
    createdAt?: string;
};

export type SegmentNodeInfo = {
    id: string;
    line: string;
    expression: string;
    action: string;
    camera: string;
    sceneKey: string;
    secondsHint: number;
    videoPrompt: string;
    /** 本段自定义参考图（上传素材，生成时追加在人物稿之后） */
    extraRefs?: Array<{ storageKey: string; name: string }>;
    audio?: SegmentAudio;
    videoStorageKey: string | null;
    videoResourceId: string | null;
    videoDurationMs?: number;
    /** 生成视频时的台词指纹；台词改动后标记成片过期 */
    videoLineHash?: string;
    /** 本段全部候选（含当前选中张），供切换/对比/重抽 */
    takes?: SegmentTake[];
    nodeIndex: number;
};

export type DigitalHumanEpisode = {
    config: DigitalHumanConfig | null;
    scenes: Map<string, SceneNodeInfo>;
    /** 按 config.segmentOrder 排序 */
    segments: SegmentNodeInfo[];
};

export function segmentAudioStale(audio: SegmentAudio | undefined, line: string, voice?: string): boolean {
    return !audio || !audio.storageKey || audio.textHash !== storybookLineHash(line, audio.voice || voice);
}

export function segmentVideoStale(segment: SegmentNodeInfo): boolean {
    if (!segment.videoStorageKey || !segment.videoResourceId) return true;
    return segment.videoLineHash !== storybookLineHash(segment.line);
}

/** 台词字数 → 预估口播秒数（≈4字/秒），下限 4 秒避免超短段 */
export function estimateSegmentSeconds(line: string): number {
    const chars = line.replace(/\s/g, "").length;
    return Math.max(4, Math.ceil(chars / 4));
}

function parseConfigNode<T>(node: { metadata?: unknown }, kind: string): T | null {
    try {
        const parsed = JSON.parse(String((node.metadata as Record<string, unknown> | undefined)?.content ?? "{}"));
        return parsed?.kind === kind ? (parsed as T) : null;
    } catch {
        return null;
    }
}

export function parseDigitalHumanCanvas(canvas: CanvasProject): DigitalHumanEpisode {
    const scenes = new Map<string, SceneNodeInfo>();
    const segmentNodes = new Map<string, SegmentNodeInfo>();
    let config: DigitalHumanConfig | null = null;
    let index = 0;
    for (const node of canvas.nodes) {
        const nodeIndex = index++;
        const md = (node.metadata ?? {}) as Record<string, unknown>;
        if (node.type === "text" && node.id === "digitalhuman-config") {
            config = parseConfigNode<DigitalHumanConfig>(node, "digitalhuman-config");
            continue;
        }
        if (node.type === "image" && node.id.startsWith("scene-")) {
            const key = node.id.slice("scene-".length);
            scenes.set(key, {
                key,
                name: String(md.sceneName ?? node.title ?? key),
                promptEn: String(md.promptEn ?? ""),
                imageStorageKey: typeof md.storageKey === "string" ? md.storageKey : null,
                frameStorageKey: typeof md.frameStorageKey === "string" && md.frameStorageKey ? md.frameStorageKey : null,
                nodeIndex,
            });
            continue;
        }
        if (node.type === "video" && node.id.startsWith("seg-")) {
            const audio = md.audio as SegmentAudio | undefined;
            segmentNodes.set(node.id.slice("seg-".length), {
                id: node.id.slice("seg-".length),
                line: String(md.line ?? ""),
                expression: String(md.expression ?? ""),
                action: String(md.action ?? ""),
                camera: String(md.camera ?? "medium close-up"),
                sceneKey: String(md.sceneKey ?? ""),
                secondsHint: Number(md.secondsHint) > 0 ? Number(md.secondsHint) : estimateSegmentSeconds(String(md.line ?? "")),
                videoPrompt: String(md.videoPrompt ?? ""),
                ...(Array.isArray(md.extraRefs) ? { extraRefs: (md.extraRefs as Array<{ storageKey?: unknown; name?: unknown }>).filter((r) => typeof r?.storageKey === "string").map((r) => ({ storageKey: String(r.storageKey), name: String(r.name ?? "ref.png") })) } : {}),
                ...(audio?.storageKey ? { audio } : {}),
                videoStorageKey: typeof md.storageKey === "string" ? md.storageKey : null,
                videoResourceId: typeof md.videoResourceId === "string" ? md.videoResourceId : null,
                ...(Number(md.videoDurationMs) > 0 ? { videoDurationMs: Number(md.videoDurationMs) } : {}),
                ...(typeof md.videoLineHash === "string" ? { videoLineHash: md.videoLineHash } : {}),
                ...(Array.isArray(md.takes) ? {
                    takes: (md.takes as Array<{ resourceId?: unknown; durationMs?: unknown; lineHash?: unknown; createdAt?: unknown }>)
                        .filter((t) => typeof t?.resourceId === "string")
                        .map((t) => ({
                            resourceId: String(t.resourceId),
                            ...(Number(t.durationMs) > 0 ? { durationMs: Number(t.durationMs) } : {}),
                            ...(typeof t.lineHash === "string" ? { lineHash: t.lineHash } : {}),
                            ...(typeof t.createdAt === "string" ? { createdAt: t.createdAt } : {}),
                        })),
                } : {}),
                nodeIndex,
            });
        }
    }
    const ordered = config?.segmentOrder?.length
        ? config.segmentOrder.map((id) => segmentNodes.get(id)).filter((s): s is SegmentNodeInfo => !!s)
        : [...segmentNodes.values()].sort((a, b) => a.id.localeCompare(b.id));
    return { config, scenes, segments: ordered };
}

export type PersonaDoc = {
    config: PersonaConfig;
    portraitStorageKey: string | null;
    portraitPrompt: string;
    nodeIndex: number;
};

export function parsePersonaCanvas(canvas: CanvasProject): PersonaDoc | null {
    let personaNode: { metadata?: unknown } | null = null;
    let portraitStorageKey: string | null = null;
    let portraitPrompt = "";
    let nodeIndex = 0;
    let index = 0;
    for (const node of canvas.nodes) {
        const i = index++;
        const md = (node.metadata ?? {}) as Record<string, unknown>;
        if (node.type === "text" && node.id === "digitalhuman-persona") {
            personaNode = node;
            nodeIndex = i;
        } else if (node.type === "image" && node.id === "portrait") {
            portraitStorageKey = typeof md.storageKey === "string" ? md.storageKey : null;
            portraitPrompt = String(md.prompt ?? "");
        }
    }
    if (!personaNode) return null;
    const config = parseConfigNode<PersonaConfig>(personaNode, "digitalhuman-persona");
    if (!config) return null;
    return { config, portraitStorageKey, portraitPrompt, nodeIndex };
}

/** 人物参考图提示词：正面半身、素背景，身份锚点 + 画风后缀程序化拼装 */
export function personaPortraitPrompt(config: Pick<PersonaConfig, "appearanceEn" | "style">): string {
    const style = DIGITAL_HUMAN_STYLES[config.style] ?? DIGITAL_HUMAN_STYLES.realistic;
    return `character reference portrait, front-facing head-and-shoulders, neutral friendly expression, looking straight at the camera, plain gradient studio background, even soft lighting, ${config.appearanceEn}, ${style.portraitSuffix}`;
}

export type DigitalHumanPersonaCard = PersonaSnapshot & { ready: boolean };

/** 数字人就绪 = 人物图 + 音色齐备（才可建口播）；探测全部 persona 画布 */
export async function listDigitalHumanPersonas(): Promise<DigitalHumanPersonaCard[]> {
    const list = await http.get<{ projects: Array<{ id: string }> }>("/canvas-projects", { params: { page: 1, pageSize: 100 } });
    const results = await Promise.allSettled((list.projects ?? []).map(async (p) => {
        const { project } = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(p.id)}`);
        const doc = parsePersonaCanvas(project);
        if (!doc) return null;
        return {
            canvasId: project.id,
            name: doc.config.name,
            appearanceEn: doc.config.appearanceEn,
            portraitStorageKey: doc.portraitStorageKey ?? "",
            voice: doc.config.voice,
            ...(doc.config.voiceModel ? { voiceModel: doc.config.voiceModel } : {}),
            ...(doc.config.voiceInstructions ? { voiceInstructions: doc.config.voiceInstructions } : {}),
            ...(doc.config.style ? { style: doc.config.style } : {}),
            ready: Boolean(doc.portraitStorageKey && doc.config.voice),
        } as DigitalHumanPersonaCard;
    }));
    return results.filter((r): r is PromiseFulfilledResult<DigitalHumanPersonaCard> => r.status === "fulfilled").map((r) => r.value).filter(Boolean);
}
