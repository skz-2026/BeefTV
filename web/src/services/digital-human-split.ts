import { requestStreamingChatCompletion } from "@/services/api/image-streaming";
import { http } from "@/services/api/request";
import type { AiConfig } from "@/stores/use-config-store";
import { DIGITAL_HUMAN_ASPECTS, estimateSegmentSeconds, personaPortraitPrompt, type DigitalHumanAspect, type DigitalHumanStyleId, type PersonaSnapshot } from "./digital-human-doc";

// 数字人口播拆分器：主题或既有文稿 → 逐段口播分镜（台词/表情/微动作/景别/场景）
// → 英文表演提示词 → 建口播画布。与绘本拆分器（storybook-split.ts）同构：
// 两段式 LLM + 程序化拼装防漂移；表演提示词里的对白标签与 <Audio 1> 绑定由本文件
// 统一拼进 videoPrompt，LLM 不经手，保证与配音逐字一致。

export type SplitScene = { key: string; name: string; promptEn: string };
export type SplitSegment = {
    id: string;
    sceneKey: string;
    camera: string;
    line: string;
    expression: string;
    action: string;
    secondsHint: number;
    videoPrompt: string;
};
export type SplitEpisode = {
    id: string;
    title: string;
    hook: string;
    scenes: SplitScene[];
    segments: SplitSegment[];
};

type OutlineSegment = {
    sceneKey?: string;
    camera?: string;
    line?: string;
    expression?: string;
    action?: string;
    secondsHint?: number;
};
type Outline = {
    title?: string;
    hook?: string;
    scenes?: Array<{ key?: string; name?: string; promptEn?: string }>;
    segments?: OutlineSegment[];
};

async function llmJSON(config: AiConfig, model: string, system: string, user: string, signal?: AbortSignal): Promise<unknown> {
    let lastError = "";
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const result = await requestStreamingChatCompletion(config, {
                model,
                messages: [
                    { role: "system", content: system },
                    { role: "user", content: user },
                ],
                temperature: 0.7,
                max_tokens: 24576,
                response_format: { type: "json_object" },
            }, undefined, { signal });
            const content = (result.content || "").replace(/^```json\s*|\s*```$/g, "").trim();
            if (!content) throw new Error("模型返回为空");
            return JSON.parse(content);
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            if (signal?.aborted) throw error;
        }
    }
    throw new Error(`LLM 连续失败：${lastError.slice(0, 160)}`);
}

const outlineSystem = (mode: "idea" | "text", durationSec: number) => `你是一位短视频口播编剧兼分镜师，为固定的数字人主播写一期口播视频。${mode === "idea" ? "根据用户的主题原创完整口播稿" : "把用户给定的文稿改编为口播稿，忠于原意，不得虚构主线"}。创作铁律：
1. 每段是一句完整的口播台词（line）：口语化、有情绪、直接对观众说话；6-48 个汉字（约 1.5-12 秒），一段一镜；
2. 结构：前 2 段强钩子（提问/反常识/冲突），中段递进讲透，最后 1-2 段结论或行动号召；台词总量约 ${Math.round(durationSec * 4)} 字（对应约 ${durationSec} 秒）；
3. 场景 1-3 个（scenes）：每场给英文场景描述 promptEn（环境/机位视角/光线/氛围，禁止出现任何人物），分镜时用 sceneKey 指定每段场景；
4. 表演只做微动作（点头、挑眉、轻微手势、身体前倾），禁止走动/转身/大动作；camera 只从 close-up / medium close-up / medium shot 里选；
5. 只输出 JSON。

输出 JSON 结构：
{"title":"标题(15字内)","hook":"一句话开场钩子",
 "scenes":[{"key":"S1","name":"中文场景名","promptEn":"english scene prompt, no people"}],
 "segments":[{"sceneKey":"S1","camera":"medium close-up","line":"台词","expression":"表情","action":"微动作","secondsHint":9}]}`;

const FILL_SYS = `你是 AI 视频表演提示词工程师。为一段数字人口播视频（图生视频 + 音频驱动口型）写英文表演提示词。铁律：
1. 只写这一段内的表演与镜头：景别、人物状态、表情变化、微动作节拍（按 0-100% 进度给 2-3 个简短节拍）；
2. 禁止描述人物外貌与服装（由参考图锁定）、禁止描述场景环境与光线（由首帧锁定）、禁止大动作与走位；
3. 台词由 <Audio 1> 驱动：写明口型与语音同步、说话中自然的眼神/手势，结尾回到放松姿态；
4. 不要输出对白标签 <d>、不要 <Picture>/<Audio> 引用、不要画风后缀（系统统一拼装）；不要换行；
5. 只输出 JSON。输出：{"prompt":"英文表演提示词"}`;

const CARDS_SYS = `你给一段中文口播台词提取"信息卡"——主播讲话时浮在画面上的重点文字。铁律：
1. 每张卡一个信息点：title 是白色大标题（≤10 汉字），highlight 是金色强调词（≤8 汉字，可空），lines 是 0-3 条补充行（每条 ≤16 汉字，关键数字/结论用 gold=true）；
2. 台词里有几个不同重点就出几张卡（1-3 张），顺序与台词出现顺序一致；没有明确重点时只出 1 张概括卡；
3. 不要复述整句台词，提炼关键词与数字；不要编造台词里没有的信息；
4. 只输出 JSON。输出：{"cards":[{"title":"...","highlight":"...","lines":[{"text":"...","gold":true}]}]}`;

/**
 * 段视频提示词：按 H3 dub-flf 模板的媒体标签契约程序化拼装（真机验证 2026-10-16）。
 * flf 的 <Picture N> 编号 = [首帧, 尾帧, 参考1...]，尾帧=首帧（口播结束回静息），
 * <Audio 1> 由模板 prompt_primary_audio_ordinal=1 注册——口播模板必须是 dub-flf 家族，
 * 普通 hybrid-dub 是 native 音频模式且 ordinal=0，<Audio 1> 会被严格校验直接拒绝。
 */
export function buildSegmentVideoPrompt(segment: Pick<SplitSegment, "line" | "camera">, performance: string, personaName: string): string {
    return [
        "<subject_definitions>",
        "<Picture 1> is the first frame of this shot: start from it exactly — keep its composition, camera angle, scene and lighting unchanged.",
        "<Picture 2> is the last frame of this shot: end on it, the presenter back at rest in the same pose and framing.",
        `<Picture 3> is the character reference: the presenter (${personaName}) keeps the exact same face, hairstyle and outfit as this reference throughout.`,
        "</subject_definitions>",
        performance.replace(/\s*\n+\s*/g, " ").trim(),
        `The presenter speaks to camera in ${segment.camera} framing: <d>[Mandarin]${segment.line}</d>`,
        "Lip movements and performance are driven by <Audio 1>: synchronize mouth shapes exactly to the Mandarin speech, with natural eye contact, subtle head nods and hand gestures while talking.",
    ].join(" ");
}

/** 改台词后同步 videoPrompt 内嵌的 <d> 台词段（表演与镜头描述保持不动）；非本管线拼装的提示词原样返回 */
export function syncLineIntoVideoPrompt(prompt: string, line: string): string {
    if (!/<d>\[Mandarin\]/.test(prompt)) return prompt;
    return prompt.replace(/<d>\[Mandarin\][\s\S]*?<\/d>/, () => `<d>[Mandarin]${line}</d>`);
}

export type SplitProgress = { stage: "outline" | "fill"; done: number; total: number; detail?: string };

/** 单段重生成表演提示词（生产页「重写表演」按钮）：Pass2 同款 system，程序化拼装绑定 */
export async function fillSegmentVideoPrompt(opts: {
    config: AiConfig;
    model: string;
    line: string;
    expression: string;
    action: string;
    camera: string;
    signal?: AbortSignal;
}): Promise<string> {
    const filled = (await llmJSON(opts.config, opts.model, FILL_SYS,
        `分镜：\n${JSON.stringify({ line: opts.line, expression: opts.expression, action: opts.action, camera: opts.camera })}`, opts.signal)) as { prompt?: string };
    const performance = String(filled.prompt || "").trim()
        || `The presenter talks to camera with a ${opts.expression || "focused"} expression, ${opts.action || "subtle hand gestures emphasizing key words"}.`;
    return buildSegmentVideoPrompt({ line: opts.line, camera: opts.camera }, performance, "the presenter");
}

/** 从台词提取信息卡（生产页「AI 提取字卡」按钮）：返回可空数组，调用方决定是否覆盖 */
export async function extractSegmentCards(opts: {
    config: AiConfig;
    model: string;
    line: string;
    signal?: AbortSignal;
}): Promise<Array<{ title: string; highlight?: string; lines?: Array<{ text: string; gold?: boolean }> }>> {
    const result = (await llmJSON(opts.config, opts.model, CARDS_SYS, `台词：\n${opts.line}`, opts.signal)) as {
        cards?: Array<{ title?: unknown; highlight?: unknown; lines?: unknown }>;
    };
    return (result.cards ?? [])
        .map((c) => ({
            title: String(c.title ?? "").trim().slice(0, 12),
            ...(typeof c.highlight === "string" && c.highlight.trim() ? { highlight: c.highlight.trim().slice(0, 10) } : {}),
            ...(Array.isArray(c.lines) ? {
                lines: (c.lines as Array<{ text?: unknown; gold?: unknown }>)
                    .filter((l) => typeof l?.text === "string" && l.text.trim())
                    .slice(0, 3)
                    .map((l) => ({ text: String(l.text).trim().slice(0, 18), ...(l.gold === true ? { gold: true } : {}) })),
            } : {}),
        }))
        .filter((c) => c.title);
}

export async function splitDigitalHumanEpisode(opts: {
    config: AiConfig;
    model: string;
    source: { mode: "idea" | "text"; content: string };
    episodeId: string;
    durationSec: number;
    signal?: AbortSignal;
    onProgress?: (p: SplitProgress) => void;
}): Promise<SplitEpisode> {
    const { config, model, source, episodeId, durationSec, signal, onProgress } = opts;
    onProgress?.({ stage: "outline", done: 0, total: 1 });
    const outline = (await llmJSON(config, model, outlineSystem(source.mode, durationSec),
        source.mode === "idea"
            ? `用户的主题：\n${source.content}`
            : `口播文稿：\n${source.content}`, signal)) as Outline;

    const scenes = (outline.scenes ?? [])
        .map((s, i) => ({ key: String(s.key ?? `S${i + 1}`), name: String(s.name ?? `场景${i + 1}`), promptEn: String(s.promptEn ?? "").trim() }))
        .filter((s) => s.promptEn);
    if (!scenes.length) scenes.push({ key: "S1", name: "演播室", promptEn: "minimal modern studio room with soft ambient lighting, clean background, no people" });
    const sceneKeys = new Set(scenes.map((s) => s.key));
    const rawSegments = (outline.segments ?? []).filter((s) => (s.line ?? "").trim());
    if (rawSegments.length < 2) throw new Error("分镜没有产出足够的段落，请重试或换模型");

    // Pass2 逐段并发 3，产出英文表演提示词
    const filled: Array<{ prompt?: string }> = new Array(rawSegments.length);
    let cursor = 0;
    const worker = async () => {
        while (cursor < rawSegments.length) {
            const si = cursor++;
            const seg = rawSegments[si];
            try {
                filled[si] = (await llmJSON(config, model, FILL_SYS,
                    `分镜第 ${si + 1} 段：\n${JSON.stringify({ line: seg.line, expression: seg.expression, action: seg.action, camera: seg.camera })}`, signal)) as { prompt?: string };
            } catch (error) {
                if (signal?.aborted) throw error;
                filled[si] = { prompt: "" };
            }
            onProgress?.({ stage: "fill", done: cursor, total: rawSegments.length, detail: `第 ${si + 1} 段` });
        }
    };
    await Promise.all([worker(), worker(), worker()]);

    const personaName = "the presenter";
    const segments: SplitSegment[] = rawSegments.map((seg, si) => {
        const line = String(seg.line ?? "").trim();
        const camera = String(seg.camera ?? "medium close-up");
        const performance = String(filled[si]?.prompt || "").trim()
            || `The presenter talks to camera with a ${String(seg.expression ?? "focused")} expression, ${String(seg.action ?? "subtle hand gestures emphasizing key words")}.`;
        return {
            id: `P${String(si + 1).padStart(2, "0")}`,
            sceneKey: sceneKeys.has(String(seg.sceneKey)) ? String(seg.sceneKey) : scenes[0].key,
            camera,
            line,
            expression: String(seg.expression ?? ""),
            action: String(seg.action ?? ""),
            secondsHint: Number(seg.secondsHint) > 0 ? Number(seg.secondsHint) : estimateSegmentSeconds(line),
            videoPrompt: buildSegmentVideoPrompt({ line, camera }, performance, personaName),
        };
    });

    return {
        id: episodeId,
        title: outline.title || "未命名口播",
        hook: outline.hook || "",
        scenes,
        segments,
    };
}

// ---------- 建册：把拆分结果落成口播画布 ----------

type CanvasDoc = {
    id: string; title: string; nodes: Array<Record<string, unknown>>; connections: Array<Record<string, unknown>>;
    createdAt: string; updatedAt: string; revision: number;
};

export function imageGenMeta(model: string, prompt: string, size: string, extra: Record<string, unknown> = {}) {
    return { prompt, composerContent: prompt, count: 1, generationMode: "image", generationType: "generation", model, nodeRole: "generator", quality: "auto", references: [], size, status: "idle", transparentBackground: "false", workflowProvider: "model", ...extra };
}

export function videoGenMeta(model: string, prompt: string, size: string, extra: Record<string, unknown> = {}) {
    return { prompt, composerContent: prompt, count: 1, generationMode: "video", generationType: "generation", model, nodeRole: "generator", quality: "auto", references: [], size, status: "idle", workflowProvider: "model", ...extra };
}

export async function createDigitalHumanCanvas(opts: {
    episode: SplitEpisode;
    topic: string;
    aspect: DigitalHumanAspect;
    textModel: string;
    imageChannel: string;
    videoChannel: string;
    videoModel: string;
    persona: PersonaSnapshot;
}): Promise<string> {
    const { episode, aspect, persona } = opts;
    const canvasId = `digitalhuman-${episode.id}`;
    const now = new Date().toISOString();
    const doc: CanvasDoc = { id: canvasId, title: episode.title, nodes: [], connections: [], createdAt: now, updatedAt: now, revision: 0 };
    const node = (nid: string, type: string, title: string, x: number, y: number, w: number, h: number, md: Record<string, unknown>) =>
        doc.nodes.push({ id: nid, type, title, position: { x, y }, width: w, height: h, createdAt: now, updatedAt: now, metadata: md });
    const geo = DIGITAL_HUMAN_ASPECTS[aspect];
    const size = `${geo.width}x${geo.height}`;
    const T2I = `${opts.imageChannel}::qwen-image-2.1`;

    const usage = [
        `【${episode.title}】`, "",
        "用法：① 工具栏「生成缺音频」逐段配音（IndexTTS-2，数字人音色）；",
        "② 「生成缺视频」会自动补齐场景图与站位首帧，再逐段出 H3 口播视频（首帧+人物稿+配音，口型同步）；",
        "③ 「合成成片」服务端拼接全部段并烧录字幕。",
    ].join("\n");
    node("script", "text", "剧本·用法", 100, 100, 560, 480, { content: usage, nodeRole: "resource" });

    // 场景节点：场景图本体（t2i 直出，无人物）
    episode.scenes.forEach((scene, i) => {
        node(`scene-${scene.key}`, "image", `场景·${scene.name}`, 720, 100 + i * 560, 405, 540,
            imageGenMeta(T2I, `${scene.promptEn}, no people, no human figures, empty scene ready for a presenter`, size, {
                sceneKey: scene.key,
                sceneName: scene.name,
                promptEn: scene.promptEn,
            }));
    });

    // 段节点：seg-P01.. 视频节点，metadata 承载分镜与嵌套配音引用
    episode.segments.forEach((seg, i) => {
        const x = 1200 + Math.floor(i / 6) * 460;
        const y = 100 + (i % 6) * 460;
        node(`seg-${seg.id}`, "video", `${seg.id} ${seg.line.slice(0, 12)}`, x, y, 396, 396,
            videoGenMeta(`${opts.videoChannel}::${opts.videoModel}`, seg.videoPrompt, size, {
                line: seg.line,
                expression: seg.expression,
                action: seg.action,
                camera: seg.camera,
                sceneKey: seg.sceneKey,
                secondsHint: seg.secondsHint,
            }));
    });

    node("digitalhuman-config", "text", "口播·成片配置", 100, 640, 560, 480, {
        nodeRole: "resource",
        content: JSON.stringify({
            kind: "digitalhuman-config",
            title: episode.title,
            topic: opts.topic,
            hook: episode.hook,
            aspect,
            textModel: opts.textModel,
            imageChannel: opts.imageChannel,
            videoChannel: opts.videoChannel,
            videoModel: opts.videoModel,
            persona,
            segmentOrder: episode.segments.map((s) => s.id),
        }, null, 1),
    });

    // upsert 合同：已存在非空画布拒绝覆盖
    try {
        const cur = await http.get<{ project: CanvasDoc }>(`/canvas-projects/${encodeURIComponent(canvasId)}`);
        if (cur.project && cur.project.nodes?.length) {
            throw new Error(`画布 ${canvasId} 已存在 ${cur.project.nodes.length} 个节点，请换期 ID 或先删除旧口播`);
        }
        doc.revision = cur.project?.revision ?? 0;
    } catch (error) {
        if (error instanceof Error && error.message.includes("已存在")) throw error;
        // 404 = 不存在，走创建
    }
    await http.put(`/canvas-projects/${encodeURIComponent(canvasId)}`, { project: doc, assets: [] });
    return canvasId;
}

// ---------- 数字人画布（人物库） ----------

export async function createPersonaCanvas(opts: {
    personaId: string;
    name: string;
    note?: string;
    appearanceEn: string;
    style: DigitalHumanStyleId;
    voice: string;
    voiceModel: string;
    voiceInstructions?: string;
    imageChannel: string;
}): Promise<string> {
    const canvasId = `digitalhuman-persona-${opts.personaId}`;
    const now = new Date().toISOString();
    const doc: CanvasDoc = { id: canvasId, title: `数字人·${opts.name}`, nodes: [], connections: [], createdAt: now, updatedAt: now, revision: 0 };
    const node = (nid: string, type: string, title: string, x: number, y: number, w: number, h: number, md: Record<string, unknown>) =>
        doc.nodes.push({ id: nid, type, title, position: { x, y }, width: w, height: h, createdAt: now, updatedAt: now, metadata: md });
    node("portrait", "image", `人物图·${opts.name}`, 100, 100, 405, 540,
        imageGenMeta(`${opts.imageChannel}::qwen-image-2.1`, personaPortraitPrompt({ appearanceEn: opts.appearanceEn, style: opts.style }), "960x960"));
    node("digitalhuman-persona", "text", "数字人·档案", 580, 100, 480, 420, {
        nodeRole: "resource",
        content: JSON.stringify({
            kind: "digitalhuman-persona",
            name: opts.name,
            ...(opts.note ? { note: opts.note } : {}),
            appearanceEn: opts.appearanceEn,
            style: opts.style,
            voice: opts.voice,
            voiceModel: opts.voiceModel,
            ...(opts.voiceInstructions ? { voiceInstructions: opts.voiceInstructions } : {}),
        }, null, 1),
    });
    try {
        const cur = await http.get<{ project: CanvasDoc }>(`/canvas-projects/${encodeURIComponent(canvasId)}`);
        if (cur.project && cur.project.nodes?.length) {
            throw new Error(`画布 ${canvasId} 已存在，请换数字人 ID 或先删除旧档案`);
        }
        doc.revision = cur.project?.revision ?? 0;
    } catch (error) {
        if (error instanceof Error && error.message.includes("已存在")) throw error;
    }
    await http.put(`/canvas-projects/${encodeURIComponent(canvasId)}`, { project: doc, assets: [] });
    return canvasId;
}
