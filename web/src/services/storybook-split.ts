import { requestStreamingChatCompletion } from "@/services/api/image-streaming";
import { http } from "@/services/api/request";
import type { AiConfig } from "@/stores/use-config-store";

// 绘本拆分器：想法或既有文本 → 逐页图文（旁白+角色对白） → 英文画面提示词 → 建册。
// 与 comic-split.ts 同构（两段式 LLM + 风格后缀程序化拼装防漂移）；本文件自包含，
// 共享 helper 的抽取等漫画侧未提交改动落地后再统一。

export const STORYBOOK_STYLES = {
    watercolor: {
        label: "水彩童话",
        suffix: "children's picture book illustration, soft watercolor painting, gentle pastel palette, warm dreamy atmosphere, hand-painted texture, rounded friendly shapes, full-page storybook composition",
        negative: "photorealistic, 3d render, dark horror, gore, scary, gloomy, text, watermark, signature, extra fingers, deformed hands, bad anatomy",
    },
    crayon: {
        label: "蜡笔童趣",
        suffix: "children's picture book illustration, crayon and colored pencil texture, bright cheerful colors, playful rounded shapes, childlike hand-drawn style, cozy storybook composition",
        negative: "photorealistic, 3d render, dark tones, scary, gloomy, text, watermark, signature, extra fingers, deformed hands, bad anatomy",
    },
    flat: {
        label: "温暖扁平",
        suffix: "children's picture book illustration, flat vector style with soft gradients, warm earthy palette, simple rounded geometry, clean shapes, cozy storybook composition",
        negative: "photorealistic, 3d render, complex realistic details, dark tones, scary, text, watermark, signature, extra fingers, deformed hands, bad anatomy",
    },
} as const;
export type StorybookStyleId = keyof typeof STORYBOOK_STYLES;

export const STORYBOOK_SIZES = { portrait: "1152x1536", square: "1344x1344" } as const;
export type StorybookOrientation = keyof typeof STORYBOOK_SIZES;

export type SplitDialogue = { speaker: string; name: string; text: string };
export type SplitPanel = { id: string; title: string; scene: string; size: string; chars: string[]; narration: string; dialogue: SplitDialogue[]; prompt: string };
export type SplitCast = { key: string; name: string; anchor: string; pilot?: boolean };
export type SplitPage = { type: "cover" | "full" | "end"; panel?: string };
export type SplitStoryBook = {
    id: string;
    title: string;
    subtitle: string;
    style: StorybookStyleId;
    cast: Array<SplitCast & { prompt: string }>;
    panels: SplitPanel[];
    pages: SplitPage[];
};

type OutlinePage = { scene?: string; narration?: string; cover?: boolean; chars?: string[]; dialogue?: Array<{ speaker?: string; text?: string }> };
type Outline = {
    title?: string;
    subtitle?: string;
    cast?: Array<{ key?: string; name?: string; anchor?: string; pilot?: boolean }>;
    pages?: OutlinePage[];
};

const FEW_SHOT = [
    { scene: "小兔子站在家门口，望着外面淅淅沥沥的雨", narration: "下雨了，小兔子嘟嘟不能出去玩。", dialogue: [{ speaker: "tuzi", text: "好无聊呀……" }] },
    { scene: "小刺猬撑着蘑菇伞来敲门", narration: "咚咚咚，有人敲门。", dialogue: [{ speaker: "ciwei", text: "嘟嘟，我们一起搭积木吧！" }] },
];

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

const outlineSystem = (pages: number, mode: "idea" | "text") => `你是一位资深儿童绘本作家。${mode === "idea" ? "根据用户的想法，原创一个完整的儿童绘本故事" : "把用户给定的故事文本改编为儿童绘本"}。创作铁律：
1. 语言面向 3-8 岁儿童：句子短、用词简单温暖；每页旁白（narration）1-2 句，合计不超过 40 字；${mode === "text" ? "忠于原文情节，可做低龄化精简，不得虚构主线；" : ""}
2. 每页 = 一幅整页插画 + 旁白（画外音） + 0-2 条角色对白（dialogue，谁说的写 speaker=cast 的 key）；
3. cast 角色最多 3 个，每个给英文外貌锚点（物种/年龄/样貌/服装/气质），全册形象一致；非人形角色（月亮/太阳/精灵物）的锚点必须写明 "the object itself is the character, no human body"；
4. 第一页为封面（cover:true，主角亮相的封面构图，不推进情节）；共 ${pages} 个正文页；结局温暖圆满；
5. 内容安全：不出现恐怖、暴力、阴暗元素；
6. 只输出 JSON。

输出 JSON 结构：
{"title":"绘本名（10字内）","subtitle":"一句主题副题",
 "cast":[{"key":"拼音","name":"中文名","anchor":"英文外貌锚点","pilot":true}],
 "pages":[{"cover":false,"scene":"这一页画什么（一句话中文）","narration":"旁白","dialogue":[{"speaker":"cast的key","text":"说的话"}],"chars":["出场角色key"]}]}

参考成片页（风格基准）：
${JSON.stringify(FEW_SHOT)}`;

const FILL_SYS = `你是绘本画面提示词工程师。根据一页大纲，写出英文画面提示词。铁律：
1. prompt 用英文：构图与镜头 + 主体与动作 + 场景细节 + 光影氛围；整页插画构图（single full-page illustration），主体明确、画面留有呼吸感；
2. 不要写角色外貌锚点（由参考卡系统负责，多人画面用 the rabbit / the girl 等自然语言指认）；不要写画风后缀（系统统一追加）；不要要求画面出现文字或字样（文字由排版层渲染）；不要换行；
3. 封面页给 cover composition（主角居中亮相，构图适合上方叠加书名）；
4. 只输出 JSON。

输出：{"prompt":"英文提示词"}`;

export type SplitProgress = { stage: "outline" | "fill"; done: number; total: number; detail?: string };

export async function splitStorybook(opts: {
    config: AiConfig;
    model: string;
    source: { mode: "idea" | "text"; content: string };
    bookId: string;
    pages: number;
    style: StorybookStyleId;
    orientation: StorybookOrientation;
    signal?: AbortSignal;
    onProgress?: (p: SplitProgress) => void;
}): Promise<SplitStoryBook> {
    const { config, model, source, bookId, pages, style, orientation, signal, onProgress } = opts;
    onProgress?.({ stage: "outline", done: 0, total: 1 });
    const outline = (await llmJSON(config, model, outlineSystem(pages, source.mode),
        source.mode === "idea"
            ? `用户的想法：\n${source.content}`
            : `故事文本：\n${source.content}`, signal)) as Outline;
    const rawPages = (outline.pages ?? []).filter((p) => (p.scene?.trim() || p.narration?.trim()));
    if (rawPages.length < 3) throw new Error("大纲没有产出足够的页面，请重试或换模型");
    const cast = (outline.cast ?? []).filter((c) => c.key && c.name && c.anchor);
    const castKeys = new Set(cast.map((c) => String(c.key)));
    const nameByKey = new Map(cast.map((c) => [String(c.key), String(c.name)]));
    // 页序：cover 页置首；无 cover 则把第一页升格为封面
    const coverIdx = rawPages.findIndex((p) => p.cover);
    if (coverIdx < 0) rawPages[0] = { ...rawPages[0], cover: true };
    else if (coverIdx > 0) {
        const [coverPage] = rawPages.splice(coverIdx, 1);
        rawPages.unshift(coverPage);
    }

    // Pass2 逐页并发 3，产出英文画面提示词
    const filled: Array<{ prompt?: string }> = new Array(rawPages.length);
    let cursor = 0;
    const worker = async () => {
        while (cursor < rawPages.length) {
            const pi = cursor++;
            const page = rawPages[pi];
            try {
                filled[pi] = (await llmJSON(config, model, FILL_SYS,
                    `大纲第 ${pi + 1} 页${page.cover ? "（封面页）" : ""}：\n${JSON.stringify({ scene: page.scene, narration: page.narration, chars: page.chars })}\n\n角色锚点（供指认，不要写进 prompt）：\n${JSON.stringify(cast)}`, signal)) as { prompt?: string };
            } catch (error) {
                if (signal?.aborted) throw error;
                filled[pi] = { prompt: page.scene ?? "" };
            }
            onProgress?.({ stage: "fill", done: cursor, total: rawPages.length, detail: `第 ${pi + 1} 页` });
        }
    };
    await Promise.all([worker(), worker(), worker()]);

    // 组装：封面帧 P00，正文帧 P01 起；风格后缀程序化追加
    const size = STORYBOOK_SIZES[orientation];
    const stylePreset = STORYBOOK_STYLES[style];
    const panels: SplitPanel[] = rawPages.map((page, pi) => {
        const id = page.cover ? "P00" : `P${String(pi).padStart(2, "0")}`;
        const rawPrompt = String(filled[pi]?.prompt || page.scene || "").replace(/\s*\n+\s*/g, " ").trim().replace(/[，。]$/, "");
        return {
            id,
            title: page.cover ? "封面" : `第${pi}页`,
            scene: page.scene || "未命名场景",
            size,
            chars: (page.chars ?? []).filter((k) => castKeys.has(k)),
            narration: String(page.narration ?? "").slice(0, 120),
            dialogue: (page.dialogue ?? []).slice(0, 2).map((d) => ({
                speaker: String(d.speaker ?? ""),
                name: nameByKey.get(String(d.speaker ?? "")) ?? "",
                text: String(d.text ?? "").slice(0, 60),
            })).filter((d) => d.speaker && castKeys.has(d.speaker) && d.text),
            prompt: `${rawPrompt}, single continuous scene, no panel grid, no text in image, ${stylePreset.suffix}`,
        };
    });
    const pages2: SplitPage[] = panels.map((p) => p.id === "P00" ? { type: "cover", panel: p.id } : { type: "full", panel: p.id });
    pages2.push({ type: "end" });

    return {
        id: bookId,
        title: outline.title || "我的绘本",
        subtitle: outline.subtitle || "",
        style,
        cast: cast.map((c) => ({
            key: String(c.key), name: String(c.name), anchor: String(c.anchor), pilot: !!c.pilot,
            // "multiple views" 而非硬性三视图:人形角色照常出多视角,月亮/太阳等拟人物体不会被画成人体
            prompt: `character reference sheet, multiple views of the same character, plain lighting, ${c.anchor}, ${stylePreset.suffix}`,
        })),
        panels,
        pages: pages2,
    };
}

// ---------- 建册：把拆分结果落成画布（结构与 comic-split 建册同一合同） ----------

type CanvasDoc = {
    id: string; title: string; nodes: Array<Record<string, unknown>>; connections: Array<Record<string, unknown>>;
    createdAt: string; updatedAt: string; revision: number;
};

function genMeta(model: string, prompt: string, size: string, extra: Record<string, unknown> = {}) {
    return { prompt, composerContent: prompt, count: 1, generationMode: "image", generationType: "generation", model, nodeRole: "generator", quality: "auto", references: [], size, status: "idle", transparentBackground: "false", workflowProvider: "model", ...extra };
}

/** 参考档包装：自然语言锚定（"reference sheet"字眼会诱导模型画出参考表/分格，实测翻车） */
function promptRef(panel: SplitPanel, castByKey: Map<string, SplitCast & { prompt: string }>) {
    const refs = panel.chars.map((k) => {
        const c = castByKey.get(k);
        if (!c) return "";
        return `${c.name}: ${c.anchor}. (looks exactly like the provided reference image)`;
    }).filter(Boolean).join(" ");
    return `Soft children's picture book illustration, one single continuous scene. Characters must look exactly as in the provided reference images.\n${refs}\nNo panel grid, no multiple frames, no text or labels in the image, no extra characters, do not repeat the reference layout.\n${panel.prompt}`;
}

export async function createStorybookCanvas(book: SplitStoryBook, imageChannelId: string): Promise<string> {
    const canvasId = `storybook-${book.id}`;
    const now = new Date().toISOString();
    const doc: CanvasDoc = { id: canvasId, title: book.title, nodes: [], connections: [], createdAt: now, updatedAt: now, revision: 0 };
    const node = (nid: string, type: string, title: string, x: number, y: number, w: number, h: number, md: Record<string, unknown>) =>
        doc.nodes.push({ id: nid, type, title, position: { x, y }, width: w, height: h, createdAt: now, updatedAt: now, metadata: md });
    const conn = (nid: string, a: string, b: string) => doc.connections.push({ id: nid, fromNodeId: a, toNodeId: b });
    const T2I = `${imageChannelId}::qwen-image-2.1`, EDIT = `${imageChannelId}::qwen-edit-plus`;
    const castByKey = new Map(book.cast.map((c) => [c.key, c]));

    const usage = [
        `【${book.title}】`, "",
        "用法：① 先点角色卡节点生成（每张点几次重摇挑一张满意）；",
        "② 带角色的页=qwen-edit-plus 并连好角色卡（参考身份锁），无角色页=qwen-image-2.1 直出；",
        "③ 到绘本成书页批量生成缺帧、逐页配音（旁白+角色对白）、导出有声绘本视频。",
    ].join("\n");
    node("script", "text", "剧本·用法", 100, 100, 560, 560, { content: usage, nodeRole: "resource" });

    let cy = 100;
    const castNodeId: Record<string, string> = {};
    for (const c of book.cast) {
        castNodeId[c.key] = `cast-${c.key}`;
        node(`cast-${c.key}`, "image", `角色卡·${c.name}`, 720, cy, 405, 720, genMeta(T2I, c.prompt, "portrait"));
        cy += 820;
    }

    // 每页一帧，画布 4 行网格排布（画布结构=书结构）
    book.panels.forEach((p, i) => {
        const x = 1400 + Math.floor(i / 4) * 460;
        const y = 100 + (i % 4) * 820;
        const ref = p.chars.length > 0;
        node(`panel-${p.id}`, "image", `${p.id} ${p.title}`, x, y, 405, 720,
            genMeta(ref ? EDIT : T2I, ref ? promptRef(p, castByKey) : p.prompt, p.size, {
                ...(ref ? { generationType: "edit" } : {}),
                narration: { text: p.narration },
                dialogue: p.dialogue.map((d) => ({ speaker: d.speaker, name: d.name, text: d.text })),
            }));
        if (ref) for (const k of p.chars) conn(`pe-${p.id}-${k}`, castNodeId[k], `panel-${p.id}`);
    });

    node("storybook-config", "text", "绘本·成书配置", 100, 720, 560, 560, {
        nodeRole: "resource",
        content: JSON.stringify({
            kind: "storybook-config",
            title: book.title,
            subtitle: book.subtitle,
            style: book.style,
            pageEnd: "—— 完 ——",
            castVoices: {},
            pages: book.pages,
        }, null, 1),
    });

    // upsert 合同：已存在非空画布拒绝覆盖
    try {
        const cur = await http.get<{ project: CanvasDoc }>(`/canvas-projects/${encodeURIComponent(canvasId)}`);
        if (cur.project && cur.project.nodes?.length) {
            throw new Error(`画布 ${canvasId} 已存在 ${cur.project.nodes.length} 个节点，请换书 ID 或先删除旧绘本`);
        }
        doc.revision = cur.project?.revision ?? 0;
    } catch (error) {
        if (error instanceof Error && error.message.includes("已存在")) throw error;
        // 404 = 不存在，走创建
    }
    await http.put(`/canvas-projects/${encodeURIComponent(canvasId)}`, { project: doc, assets: [] });
    return canvasId;
}
