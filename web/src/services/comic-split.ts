import { requestStreamingChatCompletion } from "@/services/api/image-streaming";
import { http } from "@/services/api/request";
import type { AiConfig } from "@/stores/use-config-store";

// 小说→漫画分镜的前端拆分器：两段式 LLM（大纲→逐页填充）+ 同构组装 + 建册，
// 与 .local/manhua-split.js 同一套合同（台词坐标/风格后缀/帧编号程序化拼装防漂移）。

export const COMIC_STYLE_SUFFIX = "chinese xianxia fantasy anime style, soft ink-wash texture, muted color palette with cyan and amber accents, volumetric light, detailed illustration, cinematic composition";
export const COMIC_NEGATIVE = "photorealistic, 3d render, western cartoon, modern clothes, extra fingers, deformed hands, bad anatomy, text, watermark, blurry";
export const COMIC_SIZES = { portrait: "1152x1536", wide: "2016x864", square: "1344x1344", expr: "1792x992" } as const;

export type SplitBubble = { type: "speech" | "caption" | "thought" | "note"; text: string; x?: number; y?: number; w?: number; tail?: "tl" | "tr" | "bl" | "br"; pos?: "top" | "bottom"; vertical?: boolean };
export type SplitPanel = { id: string; scene: string; title: string; size: string; chars: string[]; dialogue: SplitBubble[]; prompt: string };
export type SplitCast = { key: string; name: string; anchor: string; pilot?: boolean };
export type SplitPage = { type: string; layout?: string; panels?: string[] };
export type SplitBook = {
    id: string; subtitle: string; chapter: string; chapterEnd: string;
    cast: Array<SplitCast & { prompt: string }>; panels: SplitPanel[]; pages: SplitPage[];
};

type OutlineFrame = { title?: string; scene?: string; caption?: string; chars?: string[]; wide?: boolean };
type Outline = {
    subtitle?: string; chapter?: string; chapterEnd?: string;
    cast?: Array<{ key?: string; name?: string; anchor?: string; pilot?: boolean }>;
    pages?: Array<{ type?: string; layout?: string; frames?: OutlineFrame[] }>;
};

const LAYOUTS = ["quad", "hero-top", "hero-bottom", "hero-left", "1+2", "top2+1"];
const FEW_SHOT = [
    { id: "S01", title: "开篇定场·晨光档案库", chars: [], prompt: "wide establishing shot, interior of an ancient chinese imperial archive hall, three stories of tall dusty wooden shelves filled with yellowed scrolls, morning sunbeams through high glazed lattice windows, floating dust in light columns, a tiny lone figure of a girl copying at a low desk by the window", dialogue: [{ type: "caption", text: "晨光如薄纱，透过栖光司档案库高处的琉璃窗棂。" }] },
    { id: "S02", title: "女主登场·抄录侧影", chars: ["shen"], prompt: "medium side view, a slim chinese girl sitting at a low wooden desk copying old archives with a brush, steady wrist, lowered serene eyes, diamond-shaped light patterns of lattice window falling on her face, inkstone and stacked scrolls on desk", dialogue: [{ type: "caption", text: "抄录书吏沈映书。这是她今日抄录的第七份卷宗。" }] },
    { id: "S03", title: "卷宗特写·禁忌之句", chars: [], prompt: "close-up top-down shot, aged yellowed paper scroll with neat chinese brush calligraphy, a girl's pale fingertips gently touching the page, faint cyan ripple of light hidden under the paper surface, inkstone corner visible", dialogue: [{ type: "note", text: "梦墟——这两个字在栖光司，是禁忌。", vertical: true }] },
];
const REF_CAST = [
    { key: "shen", name: "沈映书", anchor: "18 years old slim chinese girl, pale oval face, calm clear eyes, dark hair in a low bun with a single plain wooden hairpin, faded grey-blue commoner hanfu ruqun, quiet resilient temperament" },
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

const OUTLINE_SYS = (frames: number) => `你是一位资深漫画分镜师，把小说章节改编为漫画分镜大纲。改编铁律：
1. 忠于原文剧情与台词（台词优先取原文对白，可轻度口语化润色，不得虚构主线情节）；
2. 版式库只有 6 种 grid：quad(四等分)/hero-top(通栏大格上)/hero-bottom(通栏大格下)/hero-left(左侧大格)/"1+2"(上大下二)/top2+1(上二下大)，另有 wide2(上下两条横幅)与 twoV(双竖并排+章末)；
3. 每页 grid 2-4 帧；开场/闪回/高潮/情绪帧给大格版式（hero-* 或 1+2），叙事推进用 top2+1/quad；最后一页用 twoV 收束章末；
4. caption（旁白）承担时间/地点/氛围转场，speech 台词承担对话，一帧台词 1-3 条为宜；
5. 只输出 JSON。

输出 JSON 结构：
{"subtitle":"作品名","chapter":"章名（含「第X章」）","chapterEnd":"章末语（如「第二章 完」）",
 "cast":[{"key":"拼音","name":"中文名","anchor":"英文外貌锚点（年龄/脸型/发式/服装/气质）","pilot":是否第一主角}],
 "pages":[{"type":"grid","layout":"1+2","frames":[{"title":"四字内小标题·动作","scene":"场次名 地点(时辰)","caption":"这一格画什么（一句话中文）","chars":["cast.key"],"wide":false}]}]}
注意：pages 不含扉页（程序自动添加）；frames 总数控制在 ${frames}±4 帧；空镜/特写帧 chars 为空数组；wide:true 仅用于横向构图帧（极少）。`;

const FILL_SYS = `你是漫画画面提示词工程师。根据分镜大纲的一帧，写出英文画面提示词与中文台词。铁律：
1. prompt 用英文：镜头（wide establishing shot / medium side view / close-up top-down shot / over-the-shoulder 等）+ 主体与动作 + 场景细节 + 光影氛围；不要写角色外貌锚点（角色锚定由参考卡系统负责，画多人时用 the girl / the elder 等自然语言指认）；不要写画风后缀（系统统一追加）；不要换行；
2. dialogue 台词忠于原文对白：type 只能是 speech(对白气泡)/caption(旁白条,pos=top|bottom)/thought(内心独白)/note(卷宗字,vertical=true)；一帧 0-3 条；caption 承担转场，speech 承担对话；
3. title 沿用大纲；只输出 JSON。

参考同作成片帧（风格基准）：
${JSON.stringify(FEW_SHOT)}

输出：{"frames":[{"i":帧在大纲中的序号,"prompt":"英文提示词","dialogue":[{"type":"speech","text":"…"}]}]}`;

function bubbleDefaults(type: string, idx: number): Partial<SplitBubble> {
    if (type === "caption") return { pos: "bottom" as const };
    if (type === "thought") return { x: 0.35, y: 0.06, w: 0.5 };
    if (type === "note") return { x: 0.6, y: 0.12, vertical: true };
    return { x: 0.1, y: 0.08 + idx * 0.42, w: 0.45, tail: "bl" as const };
}

export type SplitProgress = { stage: "outline" | "fill"; done: number; total: number; detail?: string };

export async function splitNovel(opts: {
    config: AiConfig;
    model: string;
    chapterText: string;
    bookId: string;
    frames: number;
    signal?: AbortSignal;
    onProgress?: (p: SplitProgress) => void;
}): Promise<SplitBook> {
    const { config, model, chapterText, bookId, frames, signal, onProgress } = opts;
    onProgress?.({ stage: "outline", done: 0, total: 1 });
    const outline = (await llmJSON(config, model, OUTLINE_SYS(frames),
        `参考作品角色锚点风格示例：\n${JSON.stringify(REF_CAST)}\n\n小说章节：\n${chapterText}`, signal)) as Outline;
    const pages = (outline.pages ?? []).filter((p) => (p.frames?.length ?? 0) > 0);
    if (!pages.length) throw new Error("大纲没有产出任何分镜页，请重试或换模型");
    const cast = (outline.cast ?? []).filter((c) => c.key && c.name && c.anchor);
    if (!cast.length) throw new Error("大纲没有产出角色锚点，请重试");
    const totalFrames = pages.reduce((n, p) => n + (p.frames?.length ?? 0), 0);

    // Pass2 逐页并发 3
    const filled: Array<Array<{ i?: number; prompt?: string; dialogue?: Array<{ type?: string; text?: string; pos?: string; vertical?: boolean }> }>> = new Array(pages.length);
    let cursor = 0;
    const worker = async () => {
        while (cursor < pages.length) {
            const pi = cursor++;
            const page = pages[pi];
            try {
                const out = (await llmJSON(config, model, FILL_SYS,
                    `大纲第 ${pi + 1} 页（版式 ${page.layout}）：\n${JSON.stringify((page.frames ?? []).map((f, i) => ({ i, ...f })))}\n\n角色锚点（供指认，不要写进 prompt）：\n${JSON.stringify(cast)}`, signal)) as { frames?: Array<{ i?: number; prompt?: string; dialogue?: Array<{ type?: string; text?: string; pos?: string; vertical?: boolean }> }> };
                filled[pi] = out.frames ?? [];
            } catch (error) {
                if (signal?.aborted) throw error;
                filled[pi] = (page.frames ?? []).map((f, i) => ({ i, prompt: f.caption ?? "", dialogue: [] }));
            }
            onProgress?.({ stage: "fill", done: cursor, total: pages.length, detail: `第 ${pi + 1} 页` });
        }
    };
    await Promise.all([worker(), worker(), worker()]);

    // 组装（风格后缀/坐标/编号程序化）
    const panels: SplitPanel[] = [];
    const bookPages: SplitPage[] = [{ type: "title" }];
    let counter = 0;
    pages.forEach((page, pi) => {
        const detail = filled[pi] ?? [];
        const ids: string[] = [];
        (page.frames ?? []).forEach((frame, i) => {
            counter += 1;
            const id = `S${String(counter).padStart(2, "0")}`;
            ids.push(id);
            const d = detail.find((x) => Number(x.i) === i) ?? {};
            const rawPrompt = String(d.prompt || frame.caption || "").replace(/\s*\n+\s*/g, " ").trim().replace(/[，。]$/, "");
            panels.push({
                id,
                scene: frame.scene || "未命名场次",
                title: frame.title || `分镜${counter}`,
                size: frame.wide ? "wide" : "portrait",
                chars: (frame.chars ?? []).filter((k) => cast.some((c) => c.key === k)),
                dialogue: (d.dialogue ?? []).slice(0, 3).map((b, bi) => {
                    const type = (["speech", "caption", "thought", "note"] as const).includes(b.type as never) ? (b.type as SplitBubble["type"]) : "speech";
                    const extra: Partial<SplitBubble> = {};
                    if (b.pos === "top" || b.pos === "bottom") extra.pos = b.pos;
                    if (b.vertical) extra.vertical = true;
                    return { type, text: String(b.text ?? "").slice(0, 60), ...bubbleDefaults(type, bi), ...extra };
                }),
                prompt: `${rawPrompt.replace(/chinese xianxia.*$/i, "").trim()}, ${COMIC_STYLE_SUFFIX}`,
            });
        });
        bookPages.push(page.type === "grid" ? { type: "grid", layout: LAYOUTS.includes(page.layout ?? "") ? page.layout : "quad", panels: ids } : { type: page.type ?? "grid", panels: ids });
    });

    return {
        id: bookId,
        subtitle: outline.subtitle || "梦有遗言",
        chapter: outline.chapter || bookId,
        chapterEnd: outline.chapterEnd || "本章 完",
        cast: cast.map((c) => ({
            key: String(c.key), name: String(c.name), anchor: String(c.anchor), pilot: !!c.pilot,
            prompt: `character reference sheet, front view, side view and back view, full body standing, neutral expression, plain lighting, ${c.anchor}, ${COMIC_STYLE_SUFFIX}`,
        })),
        panels,
        pages: bookPages,
    };
}

// ---------- 建册：把拆分结果落成画布（结构与 .local/manhua-pipeline.js canvas 命令一致） ----------

type CanvasDoc = {
    id: string; title: string; nodes: Array<Record<string, unknown>>; connections: Array<Record<string, unknown>>;
    createdAt: string; updatedAt: string; revision: number;
};

function genMeta(model: string, prompt: string, size: string, extra: Record<string, unknown> = {}) {
    return { prompt, composerContent: prompt, count: 1, generationMode: "image", generationType: "generation", model, nodeRole: "generator", quality: "auto", references: [], size, status: "idle", transparentBackground: "false", workflowProvider: "model", ...extra };
}

/** 参考档包装：角色身份走参考图，铁律禁止复刻参考表排版（对齐 E01 教训） */
function promptRef(panel: SplitPanel, castByKey: Map<string, SplitCast & { prompt: string }>) {
    const refs = panel.chars.map((k, i) => {
        const c = castByKey.get(k);
        if (!c) return "";
        const ordinal = ["first", "second", "third"][i] ?? `number ${i + 1}`;
        return `The ${ordinal} reference image is the character reference sheet of ${c.name} (${c.anchor}).`;
    }).filter(Boolean).join(" ");
    return `Create a NEW standalone manga comic panel as a fresh scene. The reference images are CHARACTER IDENTITY anchors only.\n${refs}\nKeep each referenced character's face, hairstyle, outfit and proportions strictly identical to their sheet. Do NOT copy the plain background or the multi-view reference-sheet layout, and do NOT draw multiple copies of the same character.\n${panel.prompt}`;
}

export async function createComicCanvas(book: SplitBook, imageChannelId: string): Promise<string> {
    const canvasId = `manhua-${book.id}`;
    const now = new Date().toISOString();
    const doc: CanvasDoc = { id: canvasId, title: `${book.subtitle} ${book.chapter}`, nodes: [], connections: [], createdAt: now, updatedAt: now, revision: 0 };
    const node = (nid: string, type: string, title: string, x: number, y: number, w: number, h: number, md: Record<string, unknown>) =>
        doc.nodes.push({ id: nid, type, title, position: { x, y }, width: w, height: h, createdAt: now, updatedAt: now, metadata: md });
    const conn = (nid: string, a: string, b: string) => doc.connections.push({ id: nid, fromNodeId: a, toNodeId: b });
    const T2I = `${imageChannelId}::qwen-image-2.1`, EDIT = `${imageChannelId}::qwen-edit-plus`, HD = `${imageChannelId}::comic-hd`;
    const castByKey = new Map(book.cast.map((c) => [c.key, c]));
    const sizeOf = (p: SplitPanel) => COMIC_SIZES[p.size as keyof typeof COMIC_SIZES] ?? p.size;

    const usage = [
        `【${book.subtitle} ${book.chapter}】`, "",
        "用法：① 先点角色卡节点生成（每张点几次重摇挑一张满意）；",
        "② 带角色的帧=qwen-edit-plus 并连好角色卡（参考身份锁），空镜/特写=qwen-image-2.1 直出；",
        "③ 分镜重摇：直接再点生成（seed 真随机）；满意帧连 comic-hd 出 2x 超分定稿。",
    ].join("\n");
    node("script", "text", "剧本·用法", 100, 100, 560, 560, { content: usage, nodeRole: "resource" });

    let cy = 100;
    const castNodeId: Record<string, string> = {};
    for (const c of book.cast) {
        castNodeId[c.key] = `cast-${c.key}`;
        node(`cast-${c.key}`, "image", `角色卡·${c.name}`, 720, cy, 405, 720, genMeta(T2I, c.prompt, "portrait"));
        cy += 820;
    }

    const LAYOUT_LABELS: Record<string, string> = { quad: "四等分", "hero-top": "通栏大格上", "hero-bottom": "通栏大格下", "hero-left": "左侧大格", "1+2": "上大下二", "top2+1": "上二下大" };
    let px = 1400;
    book.pages.forEach((page, pi) => {
        if (page.type === "title") return;
        const pageNo = pi + 1;
        const layoutLabel = page.type === "wide2" ? "双横幅" : page.type === "twoV" ? "双竖并排" : LAYOUT_LABELS[page.layout ?? ""] ?? page.layout ?? "";
        node(`page-${pageNo}`, "text", `第 ${pageNo} 页`, px, 100, 460, 200, { content: `P${pageNo} · ${layoutLabel}\n${(page.panels ?? []).join(" ")}`, nodeRole: "resource" });
        let py = 340;
        for (const pid of page.panels ?? []) {
            const p = book.panels.find((x) => x.id === pid);
            if (!p) continue;
            const ref = p.chars.length > 0;
            node(`panel-${p.id}`, "image", `${p.id} ${p.title}`, px, py, 405, 720,
                genMeta(ref ? EDIT : T2I, ref ? promptRef(p, castByKey) : p.prompt, sizeOf(p),
                    { ...(ref ? { generationType: "edit" } : {}), ...(p.dialogue.length ? { dialogue: p.dialogue, panelTitle: p.title, panelScene: p.scene } : {}) }));
            if (ref) for (const k of p.chars) conn(`pe-${p.id}-${k}`, castNodeId[k], `panel-${p.id}`);
            node(`hd-${p.id}`, "image", `HD·${p.id}`, px + 460, py, 405, 720, genMeta(HD, "2x AnimeSharp 超分定稿", sizeOf(p), { generationType: "edit" }));
            conn(`he-${p.id}`, `panel-${p.id}`, `hd-${p.id}`);
            py += 820;
        }
        px += 1360;
    });

    node("comic-config", "text", "漫画集·页面配置", 100, 720, 560, 560, {
        nodeRole: "resource",
        content: JSON.stringify({
            kind: "comic-config",
            subtitle: book.subtitle,
            chapter: book.chapter,
            chapterEnd: book.chapterEnd,
            pages: book.pages,
        }, null, 1),
    });

    // upsert 合同：已存在非空画布拒绝覆盖（对齐 pipeline 脚本行为）
    try {
        const cur = await http.get<{ project: CanvasDoc }>(`/canvas-projects/${encodeURIComponent(canvasId)}`);
        if (cur.project && cur.project.nodes?.length) {
            throw new Error(`画布 ${canvasId} 已存在 ${cur.project.nodes.length} 个节点，请换书 ID 或先删除旧册`);
        }
        doc.revision = cur.project?.revision ?? 0;
    } catch (error) {
        if (error instanceof Error && error.message.includes("已存在")) throw error;
        // 404 = 不存在，走创建
    }
    await http.put(`/canvas-projects/${encodeURIComponent(canvasId)}`, { project: doc, assets: [] });
    return canvasId;
}
