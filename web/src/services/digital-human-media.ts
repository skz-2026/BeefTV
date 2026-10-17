import { audioMimeType } from "@/lib/audio-generation";
import { padWavTailBlob } from "@/lib/audio/wav-pad";
import { probeMediaDurationMs } from "@/lib/media-metadata";
import { createTimelineRenderTask, type TimelineRenderResult } from "@/services/api/timeline-tasks";
import { requestAudioGeneration } from "@/services/api/audio";
import { http } from "@/services/api/request";
import { resourceFileUrl, resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import { waitForGenerationTask } from "@/services/api/task-center";
import type { AiConfig } from "@/stores/use-config-store";
import { storybookLineHash } from "@/services/storybook-audio";
import { createDefaultTracks, DEFAULT_SUBTITLE_TRACK_ID, DEFAULT_VIDEO_TRACK_ID } from "@/lib/timeline/timeline-tracks";
import type { TimelineClip, TimelineProject } from "@/types/timeline";
import { DIGITAL_HUMAN_ASPECTS, DIGITAL_HUMAN_STYLES, type DigitalHumanAspect, type DigitalHumanStyleId, type SegmentAudio } from "./digital-human-doc";

// 数字人口播媒体链路：逐段配音（IndexTTS-2 + 尾静音填充 + 资源化落库）、
// 场景图/站位首帧（canvas_image 任务）、口播段视频（canvas_video 任务，首帧+人物稿+
// 配音口型驱动）、成片合成（服务端时间线渲染 = ffmpeg 拼接 + 字幕烧录）。
// 全部走后端任务体系（POST /tasks），GPU 侧由本机网关串行队列排队，页面只串行提交。

export type TaskSummary = { id: string; status: string; resultJson?: string | null; error?: string | null };

/** 段时长（秒）：按配音实测时长向上取整，下限 4 秒（H3 短段易糊） */
export function segmentSecondsFor(audioMs: number): number {
    return Math.max(4, Math.ceil(audioMs / 1000));
}

/** 渠道端点（任务 input.config 用）：从工作区模型配置解析 baseUrl/interfaceType，模块级缓存 */
export type ChannelEndpoint = { baseUrl: string; interfaceType?: string };
let channelEndpointCache: { at: number; channels: Array<{ id: string; baseUrl?: string; interfaceType?: string }> } | null = null;

export async function resolveChannelEndpoint(channelId: string): Promise<ChannelEndpoint | null> {
    if (!channelId) return null;
    if (!channelEndpointCache || Date.now() - channelEndpointCache.at > 30_000) {
        try {
            const cfg = await http.get<{ config: { channels?: Array<{ id: string; baseUrl?: string; interfaceType?: string }> } }>("/workspace/model-config");
            channelEndpointCache = { at: Date.now(), channels: cfg.config?.channels ?? [] };
        } catch {
            channelEndpointCache = { at: Date.now(), channels: [] };
        }
    }
    const channel = channelEndpointCache.channels.find((c) => c.id === channelId);
    if (!channel?.baseUrl) return null;
    // interfaceType 为空的渠道（本机网关常见）不兜底——后端内置目录按渠道/模型自动解析协议，
    // 显式传 "openai" 反而会压坏解析（真机实测：报「接口类型 openai 未安装」）。
    return { baseUrl: channel.baseUrl, ...(channel.interfaceType ? { interfaceType: channel.interfaceType } : {}) };
}

function taskConfig(endpoint: ChannelEndpoint | null, modelName: string, extra: Record<string, unknown>) {
    if (!endpoint) return {};
    const local = /127\.0\.0\.1|localhost|::1/i.test(endpoint.baseUrl);
    return { baseUrl: endpoint.baseUrl, apiKey: local ? "local-gateway" : "", ...(endpoint.interfaceType ? { interfaceType: endpoint.interfaceType } : {}), model: modelName, ...extra };
}

/** 轮询任务到终态（本地 GPU 视频一档 15-20 分钟，超时按场景传） */
export async function pollTaskUntilDone(taskId: string, opts: { isCancelled?: () => boolean; intervalMs?: number; timeoutMs?: number } = {}): Promise<TaskSummary> {
    const startedAt = Date.now();
    const intervalMs = opts.intervalMs ?? 4000;
    const timeoutMs = opts.timeoutMs ?? 40 * 60 * 1000;
    let pollErrors = 0;
    while (Date.now() - startedAt < timeoutMs) {
        await new Promise((r) => setTimeout(r, intervalMs));
        if (opts.isCancelled?.()) throw new Error("已取消");
        try {
            const t = await http.get<TaskSummary>(`/tasks/${encodeURIComponent(taskId)}`);
            pollErrors = 0;
            if (t.status === "succeeded" || t.status === "failed" || t.status === "cancelled") return t;
        } catch {
            pollErrors++;
            if (pollErrors >= 5) break;
        }
    }
    throw new Error("生成超时");
}

// ---------- 配音 ----------

/**
 * 合成一段口播配音：TTS → 探测时长 → 尾部补静音到 段时长+0.7s（lock_source 直通配音
 * 短于视频会外推出电流声）→ 资源化落库。返回带 textHash 的引用，台词/音色改动即过期。
 */
export async function synthesizeSegmentAudio(opts: {
    config: AiConfig;
    model: string;
    line: string;
    voice: string;
    instructions?: string;
    signal?: AbortSignal;
}): Promise<{ audio: SegmentAudio; seconds: number }> {
    const { config, model, line, voice, instructions, signal } = opts;
    if (!line.trim()) throw new Error("台词为空");
    const overrides: Partial<AiConfig> = {
        model,
        audioVoice: voice,
        audioInstructions: instructions ?? "",
        audioFormat: "wav",
    };
    const blob = await requestAudioGeneration({ ...config, ...overrides }, line, { signal });
    const audioBlob = blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType("wav") });
    let speechMs = 0;
    try {
        speechMs = (await probeMediaDurationMs(new File([audioBlob], "line", { type: audioBlob.type }))) ?? 0;
    } catch { /* 探测失败按 0，用字数预估兜底 */ }
    if (speechMs <= 0) speechMs = Math.max(4000, Math.round(line.replace(/\s/g, "").length / 4) * 1000);
    const seconds = segmentSecondsFor(speechMs);
    const { blob: padded, durationMs } = await padWavTailBlob(audioBlob, seconds * 1000 + 700);
    const resource = await uploadResourceFile(padded, "audio", {
        fileName: `dh-segment.${audioBlob.type.includes("wav") ? "wav" : "audio"}`,
        durationMs: Math.round(durationMs || speechMs),
    });
    return {
        audio: {
            storageKey: resourceStorageKey(resource.id),
            url: resource.publicUrl || resourceFileUrl(resource.id),
            durationMs: Math.round(durationMs || speechMs),
            speechMs: Math.round(speechMs),
            textHash: storybookLineHash(line, voice),
            voice,
            mimeType: resource.mimeType || audioBlob.type,
            bytes: resource.size,
        },
        seconds,
    };
}

// ---------- 图片任务（场景图 / 站位首帧 / 人物图） ----------

export type DhImageResult = { resourceId: string; url: string; width?: number; height?: number; bytes?: number };

/** 场景图提示词：无人物 + 画风后缀程序化拼装 */
export function sceneImagePrompt(promptEn: string, style: DigitalHumanStyleId | undefined, aspect: DigitalHumanAspect): { prompt: string; size: string } {
    const suffix = DIGITAL_HUMAN_STYLES[style ?? "realistic"].sceneSuffix;
    const geo = DIGITAL_HUMAN_ASPECTS[aspect];
    return { prompt: `${promptEn}, no people, no human figures, empty scene ready for a presenter, ${suffix}`, size: `${geo.width}x${geo.height}` };
}

/** 站位首帧提示词：把人物图放入场景（qwen 编辑参考顺序：场景第 1、人物第 2） */
export function placementFramePrompt(style: DigitalHumanStyleId | undefined, aspect: DigitalHumanAspect): { prompt: string; size: string } {
    const suffix = DIGITAL_HUMAN_STYLES[style ?? "realistic"].sceneSuffix;
    const geo = DIGITAL_HUMAN_ASPECTS[aspect];
    return {
        prompt: [
            "Place the presenter from the second reference image into the scene of the first reference image.",
            "Keep the scene environment, camera angle and lighting exactly as the first reference image;",
            "keep the presenter's face, hairstyle and outfit exactly as the second reference image.",
            "The presenter stands or sits facing the camera at a natural medium distance, relaxed and ready to speak, with scene-consistent lighting on the body.",
            `No other people, no text. ${suffix}`,
        ].join(" "),
        size: `${geo.width}x${geo.height}`,
    };
}

export async function runCanvasImageTask(opts: {
    projectId: string;
    /** channelId::model；编辑模式挂 qwen-edit-plus */
    model: string;
    prompt: string;
    size: string;
    referenceImages?: Array<{ storageKey: string; name?: string }>;
    nodeId: string;
    isCancelled?: () => boolean;
}): Promise<DhImageResult> {
    const [channelId, modelName] = opts.model.includes("::") ? opts.model.split("::") : ["", opts.model];
    const endpoint = await resolveChannelEndpoint(channelId);
    const refs = opts.referenceImages ?? [];
    const created = await http.post<{ id?: string }>("/tasks", {
        projectId: opts.projectId,
        type: "canvas_image",
        operation: "image",
        prompt: opts.prompt,
        model: opts.model,
        input: {
            mode: "image",
            ...(endpoint ? { config: taskConfig(endpoint, modelName, { size: opts.size }) } : {}),
            referenceImages: refs.map((r, i) => ({ storageKey: r.storageKey, name: r.name ?? `ref-${i + 1}.png` })),
            referenceVideos: [],
            referenceAudios: [],
            metadata: { nodeId: opts.nodeId, sourceNodeId: opts.nodeId, resolvedCharacterVersions: [] },
        },
    });
    const taskId = created.id;
    if (!taskId) throw new Error("任务创建失败");
    const done = await pollTaskUntilDone(taskId, { isCancelled: opts.isCancelled, timeoutMs: 10 * 60 * 1000 });
    if (done.status !== "succeeded") {
        throw new Error(done.status === "cancelled" ? "任务已取消" : (done.error?.slice(0, 160) || "生成失败"));
    }
    const images = JSON.parse(done.resultJson ?? "{}").images as Array<{ resourceId?: string; width?: number; height?: number; bytes?: number }> | undefined;
    const rid = images?.[0]?.resourceId;
    if (!rid) throw new Error("任务成功但没有图片");
    return { resourceId: rid, url: resourceFileUrl(rid), width: images?.[0]?.width, height: images?.[0]?.height, bytes: images?.[0]?.bytes };
}

// ---------- 口播段视频任务 ----------

export type DhVideoResult = { resourceId: string; url: string; durationMs?: number };

export async function runSegmentVideoTask(opts: {
    projectId: string;
    /** channelId::model；口播模板必须是 dub-flf 家族（真机验证：普通 hybrid-dub 的 native 音频模式会拒绝 <Audio 1>） */
    model: string;
    prompt: string;
    seconds: number;
    aspect: DigitalHumanAspect;
    /** [站位首帧, 人物参考图]；内部按 dub-flf 契约补尾帧槽（真机+2026-10-16 E01 铁律：顺序=[首帧, 尾帧, 参考1]） */
    referenceImages: Array<{ storageKey: string; name?: string }>;
    /** 本段自定义参考素材（上传），追加在人物稿之后（IMAGE_4+ → Picture 4+） */
    extraRefs?: Array<{ storageKey: string; name?: string }>;
    referenceAudios: Array<{ storageKey: string; name?: string; durationMs?: number }>;
    nodeId: string;
    isCancelled?: () => boolean;
}): Promise<DhVideoResult> {
    const [channelId, modelName] = opts.model.includes("::") ? opts.model.split("::") : ["", opts.model];
    const endpoint = await resolveChannelEndpoint(channelId);
    // dub-flf 契约：input_reference 顺序=[首帧(IMAGE), 尾帧(IMAGE_2→last_frame), 身份参考(IMAGE_3→Picture 3)]
    const [first, portrait] = opts.referenceImages;
    if (!first || !portrait) throw new Error("段视频需要 [站位首帧, 人物参考图] 两张参考图");
    const flfRefs = [
        first,
        { ...first, name: "last-frame.png" },
        portrait,
        ...(opts.extraRefs ?? []).map((r, i) => ({ storageKey: r.storageKey, name: r.name ?? `ref-extra-${i + 1}.png` })),
    ];
    const created = await http.post<{ id?: string }>("/tasks", {
        projectId: opts.projectId,
        type: "canvas_video",
        // 3 张参考图 + 1 段配音：图生视频主模式（音频作口型驱动附加参考）
        operation: "image_to_video",
        prompt: opts.prompt,
        model: opts.model,
        input: {
            mode: "video",
            ...(endpoint ? { config: taskConfig(endpoint, modelName, { size: opts.aspect, videoSeconds: opts.seconds }) } : {}),
            referenceImages: flfRefs.map((r, i) => ({ storageKey: r.storageKey, name: r.name ?? `ref-${i + 1}.png` })),
            referenceAudios: opts.referenceAudios.map((r, i) => ({ storageKey: r.storageKey, name: r.name ?? `drive-${i + 1}.wav`, ...(r.durationMs ? { durationMs: r.durationMs } : {}) })),
            referenceVideos: [],
            metadata: { nodeId: opts.nodeId, sourceNodeId: opts.nodeId },
        },
    });
    const taskId = created.id;
    if (!taskId) throw new Error("任务创建失败");
    const done = await pollTaskUntilDone(taskId, { isCancelled: opts.isCancelled, timeoutMs: 45 * 60 * 1000, intervalMs: 5000 });
    if (done.status !== "succeeded") {
        throw new Error(done.status === "cancelled" ? "任务已取消" : (done.error?.slice(0, 160) || "生成失败"));
    }
    const video = JSON.parse(done.resultJson ?? "{}").video as { resourceId?: string; durationMs?: number } | undefined;
    const rid = video?.resourceId;
    if (!rid) throw new Error("任务成功但没有视频");
    return { resourceId: rid, url: resourceFileUrl(rid), ...(video?.durationMs ? { durationMs: video.durationMs } : {}) };
}

// ---------- 成片合成（服务端时间线渲染） ----------

export type ComposeSegment = {
    id: string;
    line: string;
    resourceId: string;
    /** 段视频时长（任务结果探测，缺省按秒数估算） */
    durationMs: number;
    /** 说话时长（去尾静音），字幕显示窗口 */
    speechMs: number;
    /** 信息卡（本段讲话时浮出的文字卡，合成时渲染叠加） */
    cards?: import("./digital-human-doc").SegmentCard[];
};

/** 段序列 → 时间线：视频轨顺序拼接 + 字幕轨逐段一句话（directMedia 引用资源） */
export function buildEpisodeTimeline(segments: ComposeSegment[], aspect: DigitalHumanAspect): TimelineProject {
    const geo = DIGITAL_HUMAN_ASPECTS[aspect];
    const clips: TimelineClip[] = [];
    let cursorMs = 0;
    segments.forEach((seg, index) => {
        const durationMs = Math.max(500, Math.round(seg.durationMs));
        clips.push({
            id: `dh-clip-${seg.id}`,
            kind: "video",
            nodeId: "",
            trackId: DEFAULT_VIDEO_TRACK_ID,
            startMs: cursorMs,
            durationMs,
            title: `${seg.id}`,
            sourceStartMs: 0,
            sourceDurationMs: durationMs,
            directMedia: { id: seg.resourceId, kind: "video", title: `${seg.id} 口播段`, storageKey: `resource:${seg.resourceId}`, durationMs },
        });
        const startOffsetMs = 150;
        const subtitleMs = Math.max(300, Math.min(Math.round(seg.speechMs), durationMs - startOffsetMs));
        // 空台词不出字幕条（服务端编译对空文本字幕报 ErrInvalidClip）
        if (seg.line.trim()) {
            clips.push({
                id: `dh-sub-${seg.id}`,
                kind: "subtitle",
                nodeId: "",
                trackId: DEFAULT_SUBTITLE_TRACK_ID,
                startMs: cursorMs + startOffsetMs,
                durationMs: subtitleMs,
                title: seg.line,
                sourceStartMs: startOffsetMs,
                sourceDurationMs: subtitleMs,
                subtitleEntryIndex: index,
                text: seg.line,
            });
        }
        cursorMs += durationMs;
    });
    return {
        version: 2,
        tracks: createDefaultTracks(),
        clips,
        durationMs: cursorMs,
        updatedAt: new Date().toISOString(),
    };
}

export async function composeEpisodeVideo(opts: {
    projectId: string;
    segments: ComposeSegment[];
    aspect: DigitalHumanAspect;
    /** 图片叠加层（信息卡 PNG 资源，前端渲染后上传）；时间与坐标为成片绝对值/归一化 */
    overlays?: NonNullable<Parameters<typeof createTimelineRenderTask>[0]["options"]>["overlays"];
    signal?: AbortSignal;
    onTaskUpdate?: (task: { id: string; status: string; progress?: number }) => void;
}): Promise<TimelineRenderResult> {
    const timeline = buildEpisodeTimeline(opts.segments, opts.aspect);
    const geo = DIGITAL_HUMAN_ASPECTS[opts.aspect];
    const created = await createTimelineRenderTask(
        { projectId: opts.projectId, timeline, options: { width: geo.width, height: geo.height, fps: 24, burnSubtitles: true, ...(opts.overlays?.length ? { overlays: opts.overlays } : {}) } },
        { signal: opts.signal },
    );
    const done = await waitForGenerationTask(created.id, {
        initialTask: created,
        intervalMs: 4000,
        timeoutMs: 62 * 60 * 1000,
        signal: opts.signal,
        onTaskUpdate: opts.onTaskUpdate as never,
    });
    const result = JSON.parse(done.resultJson ?? "{}") as TimelineRenderResult;
    if (!result.resourceId) throw new Error("渲染任务未返回产物");
    return result;
}
