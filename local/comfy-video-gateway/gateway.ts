// ComfyUI 视频网关：把 BeefTV 的 OpenAI Videos 协议请求翻译成本地 ComfyUI 工作流。
//
// 零第三方依赖。运行：node gateway.ts 或 bun gateway.ts（Node >= 22）。
// 协议契约（与 BeefTV web/src/services/api/video-provider-openai.ts 对齐）：
//   POST   {base}/videos            multipart/form-data，字段 model/prompt/seconds/size/input_reference[]
//   GET    {base}/videos/{id}       状态轮询，status: queued|in_progress|completed|failed
//   GET    {base}/videos/{id}/content  下载成片（video/mp4）
// 路径同时接受带 /v1 前缀和不带前缀两种形式。

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

type ExecutorKind = "comfyui" | "mock";

type GatewayConfig = {
    port: number;
    host: string;
    apiKey: string;
    executor: ExecutorKind;
    comfyuiUrl: string;
    pollIntervalMs: number;
    timeoutMinutes: number;
    mockDelayMs: number;
    mockVideoPath: string;
    defaultNegativePrompt: string;
    defaultWidth: number;
    defaultHeight: number;
    defaultModel: string;
    imageModels: string[];
    // H3 视频模板的文本编码器：默认官方权重，modelTextEncoders 按模型名切换（如无审查版编码器）。
    defaultTextEncoder: string;
    modelTextEncoders: Record<string, string>;
    workflows: { text: string; image: string; imageGen: string };
    modelWorkflows: Record<string, string>;
    jobsDir: string;
    jobTtlHours: number;
};

type JobStatus = "queued" | "in_progress" | "completed" | "failed";

type Job = {
    id: string;
    status: JobStatus;
    error?: string;
    filePath?: string;
    createdAt: number;
    model: string;
    prompt: string;
    mode: "text" | "image";
    workflowPath: string;
};

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function log(message: string) {
    process.stdout.write(`[${new Date().toISOString()}] ${message}\n`);
}

function resolveConfigPath(): string {
    const fromArg = process.argv.find((arg) => arg.startsWith("--config="));
    if (fromArg) return path.resolve(fromArg.slice("--config=".length));
    if (process.env.GATEWAY_CONFIG) return path.resolve(process.env.GATEWAY_CONFIG);
    return path.join(scriptDir, "config.json");
}

async function loadConfig(): Promise<GatewayConfig> {
    const configPath = resolveConfigPath();
    let raw: string;
    try {
        raw = await fs.readFile(configPath, "utf8");
    } catch {
        throw new Error(
            `找不到配置文件 ${configPath}\n` +
            "请复制 config.example.json 为 config.json 并按需修改。",
        );
    }
    const parsed = JSON.parse(raw) as Partial<GatewayConfig>;
    const config: GatewayConfig = {
        port: Number(parsed.port ?? 8765),
        host: String(parsed.host ?? "127.0.0.1"),
        apiKey: String(parsed.apiKey ?? "").trim(),
        executor: (parsed.executor === "comfyui" ? "comfyui" : "mock") as ExecutorKind,
        comfyuiUrl: String(parsed.comfyuiUrl ?? "http://127.0.0.1:8188").replace(/\/+$/, ""),
        pollIntervalMs: Math.max(250, Number(parsed.pollIntervalMs ?? 1000)),
        timeoutMinutes: Math.max(1, Number(parsed.timeoutMinutes ?? 30)),
        mockDelayMs: Math.max(0, Number(parsed.mockDelayMs ?? 3000)),
        mockVideoPath: String(parsed.mockVideoPath ?? "").trim(),
        defaultNegativePrompt: String(parsed.defaultNegativePrompt ?? ""),
        defaultWidth: Number(parsed.defaultWidth ?? 1280),
        defaultHeight: Number(parsed.defaultHeight ?? 720),
        defaultModel: String(parsed.defaultModel ?? "local-video"),
        imageModels: Array.isArray(parsed.imageModels) ? parsed.imageModels.map(String) : ["qwen-image-2.1"],
        defaultTextEncoder: String(parsed.defaultTextEncoder ?? "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"),
        modelTextEncoders: parsed.modelTextEncoders ?? {},
        workflows: {
            text: String(parsed.workflows?.text ?? "workflows/text-to-video.template.json"),
            image: String(parsed.workflows?.image ?? "workflows/ref-to-video.template.json"),
            imageGen: String(parsed.workflows?.imageGen ?? "workflows/qwen-t2i.template.json"),
        },
        modelWorkflows: parsed.modelWorkflows ?? {},
        jobsDir: path.resolve(scriptDir, String(parsed.jobsDir ?? "jobs")),
        jobTtlHours: Math.max(1, Number(parsed.jobTtlHours ?? 24)),
    };
    if (!Number.isFinite(config.port) || config.port <= 0) throw new Error("config.port 无效");
    return config;
}

const jobs = new Map<string, Job>();

// ---------- GPU 显存按需调度 ----------
// 16GB 显存放不下 H3 和 Qwen-Image 两套权重：所有生成任务串行执行；
// 连续同类任务复用已加载模型，任务类型（模板）切换时先 /free 卸载显存。
// 96GB 内存下 free_memory 保持 false：权重缓存留在内存，切回时免磁盘重读
//（官方/无审查两套编码器 + DiT 合计约 68GB，内存缓存得住）。
let gpuQueue: Promise<void> = Promise.resolve();
let lastWorkload: string | null = null;

function enqueueGpuWork<T>(workloadKey: string, task: () => Promise<T>, config: GatewayConfig): Promise<T> {
    const run = async () => {
        if (lastWorkload !== workloadKey) {
            log(`切换生成负载（${lastWorkload ?? "空"} -> ${workloadKey.split(/[\\/]/).pop()}），先卸载已加载模型…`);
            await fetch(`${config.comfyuiUrl}/free`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ unload_models: true, free_memory: false }),
            }).catch(() => undefined);
            lastWorkload = workloadKey;
        }
        return task();
    };
    const next = gpuQueue.then(run, run);
    gpuQueue = next.then(() => undefined, () => undefined);
    return next;
}

function templateAbsolutePath(config: GatewayConfig, workflowPath: string): string {
    return path.isAbsolute(workflowPath) ? workflowPath : path.resolve(scriptDir, workflowPath);
}

function normalizeRequestPath(url: string): string {
    const pathname = new URL(url, "http://localhost").pathname.replace(/\/+$/, "");
    return pathname === "/v1" ? "/" : pathname.startsWith("/v1/") ? pathname.slice(3) : pathname;
}

async function parseForm(req: IncomingMessage): Promise<FormData> {
    const contentType = String(req.headers["content-type"] ?? "");
    if (!/multipart\/form-data|application\/x-www-form-urlencoded/i.test(contentType)) return new FormData();
    const init = {
        method: req.method ?? "POST",
        headers: req.headers as Record<string, string>,
        body: Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>,
        duplex: "half",
    };
    const request = new Request(`http://localhost${req.url ?? "/"}`, init);
    return await request.formData();
}

function isFile(value: FormDataEntryValue | undefined): value is File {
    return typeof value === "object" && value !== null && "arrayBuffer" in value;
}

function collectReferenceFiles(form: FormData): File[] {
    const files: File[] = [];
    // h3-multiref 协议按序号命名（input_reference_0..5）；openai-videos 用 input_reference[]。
    for (let i = 0; i < 6; i += 1) {
        const entry = form.get(`input_reference_${i}`);
        if (isFile(entry)) files.push(entry);
    }
    if (files.length) return files;
    for (const key of ["input_reference[]", "input_reference"]) {
        for (const entry of form.getAll(key)) {
            if (isFile(entry)) files.push(entry);
        }
    }
    return files;
}

function text(form: FormData, key: string): string {
    const value = form.get(key);
    return typeof value === "string" ? value.trim() : "";
}

async function uploadReferenceToComfy(config: GatewayConfig, file: File, index: number): Promise<string> {
    const suffix = path.extname(file.name || "") || ".png";
    const uploadName = `beeftv-ref-${randomUUID()}${suffix}`;
    const form = new FormData();
    form.append("image", new File([await file.arrayBuffer()], uploadName, { type: file.type || "application/octet-stream" }));
    form.append("type", "input");
    form.append("overwrite", "true");
    const response = await fetch(`${config.comfyuiUrl}/upload/image`, { method: "POST", body: form });
    if (!response.ok) {
        throw new Error(`参考图上传到 ComfyUI 失败（${response.status}）：${(await response.text()).slice(0, 300)}`);
    }
    const result = (await response.json()) as { name?: string; subfolder?: string };
    if (!result.name) throw new Error("ComfyUI 上传接口没有返回文件名");
    log(`参考图 #${index + 1} 已上传：${result.subfolder ? `${result.subfolder}/` : ""}${result.name}`);
    return result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
}

type PlaceholderContext = {
    prompt: string;
    negative: string;
    seconds: number;
    frames: number;
    width: number;
    height: number;
    size: string;
    seed: number;
    images: string[];
    textEncoder: string;
};

function substitutePlaceholders(node: unknown, context: PlaceholderContext): unknown {
    if (typeof node === "string") {
        const exact = node.trim();
        if (exact === "{{PROMPT}}") return context.prompt;
        if (exact === "{{NEGATIVE_PROMPT}}") return context.negative;
        if (exact === "{{SECONDS}}") return context.seconds;
        if (exact === "{{FRAMES}}") return context.frames;
        if (exact === "{{WIDTH}}") return context.width;
        if (exact === "{{HEIGHT}}") return context.height;
        if (exact === "{{SIZE}}") return context.size;
        if (exact === "{{SEED}}") return context.seed;
        if (exact === "{{TEXT_ENCODER}}") return context.textEncoder;
        const imageMatch = exact.match(/^\{\{IMAGE(?:_(\d+))?\}\}$/);
        if (imageMatch) {
            const index = Number(imageMatch[1] ?? 1) - 1;
            return context.images[index] ?? "";
        }
        // 占位符嵌在更长字符串里时按子串替换（例如提示词拼接）。
        return node
            .replace(/\{\{PROMPT\}\}/g, context.prompt)
            .replace(/\{\{NEGATIVE_PROMPT\}\}/g, context.negative)
            .replace(/\{\{SIZE\}\}/g, context.size);
    }
    if (Array.isArray(node)) return node.map((item) => substitutePlaceholders(item, context));
    if (node && typeof node === "object") {
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(node)) result[key] = substitutePlaceholders(value, context);
        return result;
    }
    return node;
}

// 多参考模板：删除没有实际图片的 LoadImage 节点和对应 ref_images.ref_image_N 槽位。
function pruneEmptyRefSlots(workflow: Record<string, unknown>) {
    const droppedNodes = new Set<string>();
    for (const [id, node] of Object.entries(workflow)) {
        if (!node || typeof node !== "object") continue;
        const typed = node as { class_type?: string; inputs?: Record<string, unknown> };
        if (typed.class_type !== "MiniMaxH3AudioConditioningT8" || !typed.inputs) continue;
        for (const key of Object.keys(typed.inputs)) {
            const match = key.match(/^ref_images\.ref_image_(\d+)$/);
            if (!match) continue;
            const link = typed.inputs[key];
            if (!Array.isArray(link)) continue;
            const sourceId = String(link[0]);
            const source = workflow[sourceId] as { class_type?: string; inputs?: { image?: unknown } } | undefined;
            if (source && source.class_type === "LoadImage" && typeof source.inputs?.image === "string" && !source.inputs.image.trim()) {
                delete typed.inputs[key];
                droppedNodes.add(sourceId);
            }
        }
    }
    for (const id of droppedNodes) delete workflow[id];
    if (droppedNodes.size) log(`多参考模板：剪除 ${droppedNodes.size} 个空参考槽位`);
}

function assertNoLeftoverPlaceholders(workflow: unknown) {    const leftovers = new Set<string>();
    const walk = (node: unknown) => {
        if (typeof node === "string") {
            for (const match of node.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)) leftovers.add(match[0]);
        } else if (Array.isArray(node)) {
            node.forEach(walk);
        } else if (node && typeof node === "object") {
            Object.values(node).forEach(walk);
        }
    };
    walk(workflow);
    if (leftovers.size > 0) {
        throw new Error(`工作流模板中存在未识别或缺少输入的占位符：${[...leftovers].join("、")}。请检查请求参数或模板字段。`);
    }
}

// 模板里的 `_` 开头键是给人看的说明（如 _README），不属于 ComfyUI 工作流，提交前必须剥掉。
function stripDocKeys(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(stripDocKeys);
    if (node && typeof node === "object") {
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(node)) {
            if (key.startsWith("_")) continue;
            result[key] = stripDocKeys(value);
        }
        return result;
    }
    return node;
}

async function loadTemplate(config: GatewayConfig, job: Job) {
    const templatePath = templateAbsolutePath(config, job.workflowPath);
    let parsed: unknown;
    try {
        parsed = stripDocKeys(JSON.parse(await fs.readFile(templatePath, "utf8")));
    } catch (error) {
        throw new Error(`读取工作流模板失败 ${templatePath}：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!parsed || typeof parsed !== "object" || !JSON.stringify(parsed).includes("class_type")) {
        throw new Error(
            `工作流模板 ${job.workflowPath} 还是脚手架文件。请在 ComfyUI 中跑通工作流后，` +
            "用「工作流 → 导出（API）」导出的 JSON 替换模板内容，并把提示词/图片/尺寸字段改成占位符（见 README）。",
        );
    }
    return { templatePath, workflow: parsed };
}

async function parseSize(form: FormData, config: GatewayConfig): Promise<{ width: number; height: number; size: string }> {
    const raw = text(form, "size");
    // H3 等本地模型要求宽高被 32 整除；对请求尺寸向下取整对齐，保持画幅且不放大显存需求。
    const snap32 = (value: number) => Math.max(32, Math.floor(value / 32) * 32);
    const match = raw.match(/^(\d+)x(\d+)$/i);
    if (match) {
        const width = snap32(Number(match[1]));
        const height = snap32(Number(match[2]));
        return { width, height, size: `${width}x${height}` };
    }
    if (raw) log(`无法识别的 size 值 "${raw}"，使用默认 ${config.defaultWidth}x${config.defaultHeight}`);
    return { width: config.defaultWidth, height: config.defaultHeight, size: `${config.defaultWidth}x${config.defaultHeight}` };
}

async function createVideoJob(req: IncomingMessage, res: ServerResponse, config: GatewayConfig) {
    const form = await parseForm(req);
    const prompt = text(form, "prompt");
    if (!prompt) return json(res, 400, { error: { message: "prompt 不能为空" } });
    const model = text(form, "model") || config.defaultModel;
    const seconds = Math.max(1, Math.floor(Number(text(form, "seconds")) || 5));
    const references = collectReferenceFiles(form);
    const mode: Job["mode"] = references.length > 0 ? "image" : "text";
    const override = config.modelWorkflows[model];
    const workflowPath = override || (mode === "image" ? config.workflows.image : config.workflows.text);

    const job: Job = {
        id: randomUUID(),
        status: "queued",
        createdAt: Date.now(),
        model,
        prompt,
        mode,
        workflowPath,
    };

    const { workflow } = await loadTemplate(config, job);
    const { width, height, size } = await parseSize(form, config);
    // 可选 seed 表单参数：A/B 对比/复现实验用同一种子；缺省仍随机，不影响现有调用方。
    const seedParam = Number(text(form, "seed"));
    const seed = Number.isFinite(seedParam) && seedParam >= 0 && seedParam <= 2_147_483_647
        ? Math.floor(seedParam)
        : Math.floor(Math.random() * 2_147_483_647);
    const context: PlaceholderContext = {
        prompt,
        negative: config.defaultNegativePrompt,
        seconds,
        // H3 官方换算：24fps 下 帧数 = 秒×24+4（示例工作流 5s→124 帧），生成范围 2–15 秒。
        frames: Math.max(52, Math.min(15, seconds) * 24 + 4),
        width,
        height,
        size,
        seed,
        images: [],
        textEncoder: config.modelTextEncoders[model] ?? config.defaultTextEncoder,
    };

    if (mode === "image") {
        if (config.executor === "comfyui") {
            for (let index = 0; index < references.length; index += 1) {
                context.images.push(await uploadReferenceToComfy(config, references[index], index));
            }
        } else {
            context.images.push("mock-reference.png");
        }
        if (!context.images[0]) {
            return json(res, 400, { error: { message: "图生视频工作流模板包含 {{IMAGE}} 占位符，但请求没有携带参考图" } });
        }
    }

    const substituted = substitutePlaceholders(workflow, context);
    if (substituted && typeof substituted === "object") pruneEmptyRefSlots(substituted as Record<string, unknown>);
    try {
        assertNoLeftoverPlaceholders(substituted);
    } catch (error) {
        return json(res, 400, { error: { message: error instanceof Error ? error.message : String(error) } });
    }

    jobs.set(job.id, job);
    await fs.mkdir(path.join(config.jobsDir, job.id), { recursive: true });
    log(`任务 ${job.id} 已创建：model=${model} mode=${mode} seconds=${seconds} size=${size} seed=${seed}`);

    // 动漫场景模型：多参考图自动走两步流程（合成→编辑首帧→I2VA）
    const animeSceneModels = ["h3-anime-scene"];
    if (animeSceneModels.includes(model) && references.length > 0) {
        void enqueueGpuWork(`anime-scene-${job.id}`, async () => {
            try {
                const target = config.executor === "mock" ? await mockRun(config, job) : await runAnimeSceneJob(config, job, references, prompt, seconds, width, height);
                job.status = "completed";
                job.filePath = target;
                log(`任务 ${job.id} [动漫场景] 完成`);
            } catch (error) {
                job.status = "failed";
                job.error = error instanceof Error ? error.message : String(error);
                log(`任务 ${job.id} [动漫场景] 失败：${job.error}`);
            }
        }, config);
        return json(res, 200, { id: job.id, status: job.status, model });
    }

    void enqueueGpuWork(job.workflowPath, () => runJob(config, job, substituted), config).catch((error) => {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        log(`任务 ${job.id} 失败：${job.error}`);
    });
    return json(res, 200, { id: job.id, status: job.status, model });
}

async function mockRun(config: GatewayConfig, job: Job): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, config.mockDelayMs));
    const target = path.join(config.jobsDir, job.id, "output.mp4");
    if (config.mockVideoPath) {
        await fs.copyFile(path.resolve(config.mockVideoPath), target);
    } else {
        // 没有样例视频时写入占位字节：只用于验证 BeefTV -> 网关链路，不代表可播放成片。
        const dummy = Buffer.alloc(128 * 1024, 0);
        Buffer.from("MOCK VIDEO - configure mockVideoPath for a playable sample").copy(dummy, 0);
        await fs.writeFile(target, dummy);
        log("提示：mock 模式未配置 mockVideoPath，返回的是占位字节，不能播放。");
    }
    return target;
}

function findVideoOutput(outputs: Record<string, unknown>): { filename: string; subfolder?: string; type?: string } | undefined {
    const videoExtensions = [".mp4", ".webm", ".mov", ".mkv", ".gif"];
    const fallbacks: Array<{ filename: string; subfolder?: string; type?: string }> = [];
    const collect = (value: unknown) => {
        if (Array.isArray(value)) {
            for (const item of value) {
                if (item && typeof item === "object" && typeof (item as Record<string, unknown>).filename === "string") {
                    const entry = item as { filename: string; subfolder?: string; type?: string };
                    if (videoExtensions.some((ext) => entry.filename.toLowerCase().endsWith(ext))) return entry;
                    fallbacks.push(entry);
                }
            }
            return undefined;
        }
        if (value && typeof value === "object" && typeof (value as Record<string, unknown>).filename === "string") {
            const entry = value as { filename: string; subfolder?: string; type?: string };
            if (videoExtensions.some((ext) => entry.filename.toLowerCase().endsWith(ext))) return entry;
            fallbacks.push(entry);
        }
        return undefined;
    };
    for (const nodeOutput of Object.values(outputs)) {
        if (!nodeOutput || typeof nodeOutput !== "object") continue;
        for (const key of ["gifs", "videos", "video", "images"]) {
            const found = collect((nodeOutput as Record<string, unknown>)[key]);
            if (found) return found;
        }
    }
    return fallbacks.at(-1);
}

async function comfyRun(config: GatewayConfig, job: Job, workflow: unknown): Promise<string> {
    job.status = "in_progress";
    const clientId = `beeftv-gateway-${randomUUID()}`;
    const submit = await fetch(`${config.comfyuiUrl}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    });
    const submitBody = await submit.json().catch(() => ({}));
    if (!submit.ok) {
        const detail = JSON.stringify(submitBody).slice(0, 800);
        throw new Error(`ComfyUI /prompt 提交失败（${submit.status}）：${detail}`);
    }
    const promptId = (submitBody as { prompt_id?: string }).prompt_id;
    if (!promptId) throw new Error(`ComfyUI 没有返回 prompt_id：${JSON.stringify(submitBody).slice(0, 300)}`);
    log(`任务 ${job.id} 已提交 ComfyUI：prompt_id=${promptId}`);

    const deadline = Date.now() + config.timeoutMinutes * 60_000;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
        const historyResponse = await fetch(`${config.comfyuiUrl}/history/${promptId}`);
        if (!historyResponse.ok) continue;
        const history = (await historyResponse.json()) as Record<string, Record<string, unknown>>;
        const entry = history[promptId];
        if (!entry) continue;
        const status = entry.status as { status_str?: string; messages?: unknown[] } | undefined;
        if (status?.status_str === "error") {
            throw new Error(`ComfyUI 执行出错：${JSON.stringify(status.messages ?? status).slice(0, 800)}`);
        }
        const outputs = (entry.outputs ?? {}) as Record<string, unknown>;
        const file = findVideoOutput(outputs);
        if (!file) continue;
        const query = new URLSearchParams({
            filename: file.filename,
            subfolder: file.subfolder ?? "",
            type: file.type ?? "output",
        });
        const view = await fetch(`${config.comfyuiUrl}/view?${query.toString()}`);
        if (!view.ok) throw new Error(`从 ComfyUI 下载成片失败（${view.status}）`);
        const extension = path.extname(file.filename) || ".mp4";
        const target = path.join(config.jobsDir, job.id, `output${extension}`);
        await fs.writeFile(target, Buffer.from(await view.arrayBuffer()));
        log(`任务 ${job.id} 成片已下载：${file.filename}`);
        return target;
    }
    throw new Error(`等待 ComfyUI 生成超时（${config.timeoutMinutes} 分钟）`);
}

async function runJob(config: GatewayConfig, job: Job, workflow: unknown) {
    try {
        const target = config.executor === "mock" ? await mockRun(config, job) : await comfyRun(config, job, workflow);
        job.status = "completed";
        job.filePath = target;
        log(`任务 ${job.id} 完成`);
    } catch (error) {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        log(`任务 ${job.id} 失败：${job.error}`);
    }
}

// ---------- 动漫场景模型：多参考图 → 合成 → Qwen-Edit 首帧 → H3 I2VA ----------

async function uploadFileToComfyUI(config: GatewayConfig, buffer: Buffer, name: string): Promise<string> {
    const form = new FormData();
    form.append("image", new File([buffer], name, { type: "image/png" }));
    form.append("type", "input");
    form.append("overwrite", "true");
    const response = await fetch(`${config.comfyuiUrl}/upload/image`, { method: "POST", body: form });
    if (!response.ok) throw new Error(`上传 ComfyUI 失败（${response.status}）`);
    const result = await response.json() as { name?: string; subfolder?: string };
    if (!result.name) throw new Error("ComfyUI 上传未返回文件名");
    return result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
}

async function compositeImagesOnComfy(config: GatewayConfig, imageNames: string[]): Promise<string> {
    if (imageNames.length === 1) return imageNames[0];
    const nodes: Record<string, unknown> = {};
    const loadIds: string[] = [];
    for (let i = 0; i < imageNames.length; i++) {
        const id = String(i + 1);
        nodes[id] = { class_type: "LoadImage", inputs: { image: imageNames[i], upload: "image" } };
        loadIds.push(id);
    }
    let prevId = loadIds[0];
    for (let i = 1; i < imageNames.length; i++) {
        const concatId = `cat-${i}`;
        nodes[concatId] = { class_type: "ImageBatch", inputs: { image1: [prevId, 0], image2: [loadIds[i], 0],  } };
        prevId = concatId;
    }
    nodes["save"] = { class_type: "SaveImage", inputs: { images: [prevId, 0], filename_prefix: "beeftv/scene-composite" } };
    const clientId = `beeftv-gateway-${randomUUID()}`;
    const submit = await fetch(`${config.comfyuiUrl}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: nodes, client_id: clientId }) });
    const body = await submit.json();
    if (!submit.ok) throw new Error(`合成提交失败: ${JSON.stringify(body).slice(0, 300)}`);
    const promptId = body.prompt_id;
    if (!promptId) throw new Error("合成未返回 prompt_id");
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, config.pollIntervalMs));
        const h = await (await fetch(`${config.comfyuiUrl}/history/${promptId}`)).json();
        const e = h[promptId];
        if (!e) continue;
        if (e.status?.status_str === "error") throw new Error(`合成执行失败: ${JSON.stringify(e.status.messages ?? {}).slice(0, 400)}`);
        for (const out of Object.values(e.outputs ?? {})) {
            const imgs = (out as Record<string, unknown>)?.images;
            if (Array.isArray(imgs) && imgs.length > 0) {
                const f = imgs[0] as { filename: string; subfolder?: string; type?: string };
                const q = new URLSearchParams({ filename: f.filename, subfolder: f.subfolder ?? "", type: f.type ?? "output" });
                const view = await fetch(`${config.comfyuiUrl}/view?${q}`);
                if (!view.ok) throw new Error(`下载合成图失败 ${view.status}`);
                const buf = Buffer.from(await view.arrayBuffer());
                return await uploadFileToComfyUI(config, buf, `beeftv-composited-${Date.now()}.png`);
            }
        }
    }
    throw new Error("合成等待超时");
}

async function runAnimeSceneJob(
    config: GatewayConfig, job: Job,
    references: File[], prompt: string, seconds: number, width: number, height: number,
): Promise<string> {
    job.status = "in_progress";
    log(`任务 ${job.id} [动漫场景] 1/3 上传 ${references.length} 张参考图…`);
    const imageNames: string[] = [];
    for (let i = 0; i < references.length; i++) {
        imageNames.push(await uploadFileToComfyUI(config, Buffer.from(await references[i].arrayBuffer()), `beeftv-scene-${i}-${Date.now()}.png`));
    }
    log(`任务 ${job.id} [动漫场景] 2/3 合成 + Qwen-Edit 首帧…`);
    const composited = await compositeImagesOnComfy(config, imageNames);
    const n = references.length;
    const editPrompt = `2D anime style illustration. The reference shows ${n} character design sheets side by side. Create a single scene using ALL ${n} characters, keeping each character's EXACT face design, costume, animal features (monkey face, pig ears, etc.) and accessories exactly as in the reference. Do NOT humanize any character. Scene: ${prompt}. Exactly ${n} characters, one each, no duplicates. 2D anime production art.`;
    // 用 Qwen-Edit 模板生成首帧
    const editPath = templateAbsolutePath(config, config.modelWorkflows["qwen-edit"] || "workflows/qwen-edit.template.json");
    const editWorkflow = stripDocKeys(JSON.parse(await fs.readFile(editPath, "utf8")));
    const editSub = substitutePlaceholders(editWorkflow, {
        prompt: editPrompt, negative: "", seconds: 0, frames: 0, width, height,
        size: `${width}x${height}`, seed: Math.floor(Math.random() * 2_147_483_647), images: [composited],
    });
    const firstFrameBufs = await comfyRunImages(config, editSub);
    const firstFrameBuf = firstFrameBufs[0];
    const firstFrameName = await uploadFileToComfyUI(config, firstFrameBuf, `beeftv-firstframe-${job.id}.png`);
    log(`任务 ${job.id} [动漫场景] 首帧完成，3/3 H3 I2VA 动化…`);
    // 用 I2VA 模板跑视频
    const i2vaPath = templateAbsolutePath(config, config.modelWorkflows["h3-i2v"] || "workflows/image-to-video.template.json");
    const i2vaWorkflow = stripDocKeys(JSON.parse(await fs.readFile(i2vaPath, "utf8")));
    const i2vaSub = substitutePlaceholders(i2vaWorkflow, {
        prompt, negative: config.defaultNegativePrompt, seconds,
        frames: Math.max(52, Math.min(15, seconds) * 24 + 4),
        width, height, size: `${width}x${height}`,
        seed: Math.floor(Math.random() * 2_147_483_647), images: [firstFrameName],
    });
    // 直接调 comfyRun 拿视频
    return await comfyRun(config, job, i2vaSub);
}

// ---------- 图片编辑协议：POST /v1/images/edits（multipart，输入图+指令 → 编辑后图片） ----------

async function handleImageEdit(req: IncomingMessage, res: ServerResponse, config: GatewayConfig) {
    const form = await parseForm(req);
    const prompt = text(form, "prompt");
    if (!prompt) return json(res, 400, { error: { message: "prompt 不能为空" } });
    const model = text(form, "model") || "qwen-edit";
    const sizeRaw = text(form, "size");
    const match = sizeRaw.match(/^(\d+)x(\d+)$/i);
    const width = match ? Number(match[1]) : 1280;
    const height = match ? Number(match[2]) : 704;

    // 收集输入图片（input_reference[] / input_reference / image）
    const inputFiles: File[] = [];
    for (const key of ["input_reference[]", "input_reference", "image", "image[]"]) {
        for (const entry of form.getAll(key)) {
            if (isFile(entry)) inputFiles.push(entry);
        }
    }
    if (!inputFiles.length) return json(res, 400, { error: { message: "图片编辑需要至少一张输入图片（input_reference）" } });

    if (config.executor === "mock") {
        return json(res, 500, { error: { message: "mock 模式不支持图片编辑" } });
    }

    log(`图片编辑任务开始：model=${model} 输入图=${inputFiles.length} 张 ${width}x${height} prompt=${prompt.slice(0, 60)}`);
    try {
        // 1. 上传所有输入图到 ComfyUI（每张独立，不拼接——保持各参考图身份完整）
        const imageNames: string[] = [];
        for (let i = 0; i < inputFiles.length; i++) {
            imageNames.push(await uploadFileToComfyUI(config, Buffer.from(await inputFiles[i].arrayBuffer()), `beeftv-edit-${i}-${Date.now()}.png`));
        }
        // 2. 选择编辑模板：qwen-edit-plus（多参考独立输入，身份保真）或 qwen-edit（单图拼接）
        const editTemplatePath = imageNames.length > 1
            ? (config.modelWorkflows["qwen-edit-plus"] || "workflows/qwen-edit-plus.template.json")
            : (config.modelWorkflows["qwen-edit"] || "workflows/qwen-edit.template.json");
        const editPath = templateAbsolutePath(config, editTemplatePath);
        const editWorkflow = stripDocKeys(JSON.parse(await fs.readFile(editPath, "utf8")));
        // images[0] = 主参考（第一张），images[1..] = 附加参考（EditPlus 的 image2/image3）
        const substituted = substitutePlaceholders(editWorkflow, {
            prompt, negative: "", seconds: 0, frames: 0, width, height,
            size: `${width}x${height}`, seed: Math.floor(Math.random() * 2_147_483_647),
            images: imageNames,
        });
        // 多参考 Plus 模板要求恰好 3 个图槽：不足时补第一张，超出时截断
        if (editWorkflow["22"] && imageNames.length < 2) (substituted as Record<string, any>)["22"].inputs.image = imageNames[0];
        if (editWorkflow["23"] && imageNames.length < 3) (substituted as Record<string, any>)["23"].inputs.image = imageNames[0];
        const buffers = await comfyRunImages(config, substituted);
        log(`图片编辑完成：${buffers.length} 张输出`);
        return json(res, 200, {
            created: Math.floor(Date.now() / 1000),
            data: buffers.map(b => ({ b64_json: b.toString("base64") })),
        });
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log(`图片编辑失败：${msg}`);
        return json(res, 500, { error: { message: msg, type: "generation_error" } });
    }
}

// ---------- OpenAI Images 协议（同步返回 b64_json） ----------

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (!chunks.length) return {};
    try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
        throw new Error("请求体不是合法 JSON");
    }
}

async function comfyRunImages(config: GatewayConfig, workflow: unknown): Promise<Buffer[]> {
    const clientId = `beeftv-gateway-${randomUUID()}`;
    const submit = await fetch(`${config.comfyuiUrl}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: workflow, client_id: clientId }),
    });
    const submitBody = await submit.json().catch(() => ({}));
    if (!submit.ok) throw new Error(`ComfyUI /prompt 提交失败（${submit.status}）：${JSON.stringify(submitBody).slice(0, 800)}`);
    const promptId = (submitBody as { prompt_id?: string }).prompt_id;
    if (!promptId) throw new Error(`ComfyUI 没有返回 prompt_id：${JSON.stringify(submitBody).slice(0, 300)}`);
    log(`图片任务已提交 ComfyUI：prompt_id=${promptId}`);

    const deadline = Date.now() + config.timeoutMinutes * 60_000;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
        const historyResponse = await fetch(`${config.comfyuiUrl}/history/${promptId}`);
        if (!historyResponse.ok) continue;
        const history = (await historyResponse.json()) as Record<string, Record<string, unknown>>;
        const entry = history[promptId];
        if (!entry) continue;
        const status = entry.status as { status_str?: string; messages?: unknown[] } | undefined;
        if (status?.status_str === "error") {
            throw new Error(`ComfyUI 执行出错：${JSON.stringify(status.messages ?? status).slice(0, 800)}`);
        }
        const files: Array<{ filename: string; subfolder?: string; type?: string }> = [];
        for (const nodeOutput of Object.values((entry.outputs ?? {}) as Record<string, unknown>)) {
            const images = (nodeOutput as Record<string, unknown>)?.images;
            if (!Array.isArray(images)) continue;
            for (const item of images) {
                if (item && typeof item === "object" && typeof (item as Record<string, unknown>).filename === "string") {
                    files.push(item as { filename: string; subfolder?: string; type?: string });
                }
            }
        }
        if (!files.length) continue;
        const buffers: Buffer[] = [];
        for (const file of files) {
            const query = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder ?? "", type: file.type ?? "output" });
            const view = await fetch(`${config.comfyuiUrl}/view?${query.toString()}`);
            if (!view.ok) throw new Error(`从 ComfyUI 下载图片失败（${view.status}）`);
            buffers.push(Buffer.from(await view.arrayBuffer()));
        }
        log(`图片任务完成：${files.map((f) => f.filename).join(", ")}`);
        return buffers;
    }
    throw new Error(`等待 ComfyUI 生成超时（${config.timeoutMinutes} 分钟）`);
}

async function handleImageGeneration(req: IncomingMessage, res: ServerResponse, config: GatewayConfig) {
    const body = await readJsonBody(req);
    const prompt = String(body.prompt ?? "").trim();
    if (!prompt) return json(res, 400, { error: { message: "prompt 不能为空" } });
    const model = String(body.model ?? "") || config.imageModels[0] || "qwen-image-2.1";
    const sizeRaw = String(body.size ?? "").trim();
    const match = sizeRaw.match(/^(\d+)x(\d+)$/i);
    const width = match ? Number(match[1]) : 1024;
    const height = match ? Number(match[2]) : 1024;

    const job: Job = {
        id: randomUUID(),
        status: "in_progress",
        createdAt: Date.now(),
        model,
        prompt,
        mode: "text",
        workflowPath: config.workflows.imageGen,
    };
    jobs.set(job.id, job);
    const { workflow } = await loadTemplate(config, job);
    const substituted = substitutePlaceholders(workflow, {
        prompt,
        negative: config.defaultNegativePrompt,
        seconds: 0,
        frames: 0,
        width,
        height,
        size: `${width}x${height}`,
        seed: Math.floor(Math.random() * 2_147_483_647),
        images: [],
        textEncoder: config.defaultTextEncoder,
    });
    assertNoLeftoverPlaceholders(substituted);
    log(`图片任务 ${job.id} 开始：model=${model} ${width}x${height} prompt=${prompt.slice(0, 60)}`);

    try {
        if (config.executor === "mock") {
            throw new Error("mock 模式不支持生图；请把 executor 设为 comfyui");
        }
        const buffers = await enqueueGpuWork(job.workflowPath, () => comfyRunImages(config, substituted), config);
        job.status = "completed";
        return json(res, 200, {
            created: Math.floor(Date.now() / 1000),
            data: buffers.map((buffer) => ({ b64_json: buffer.toString("base64") })),
        });
    } catch (error) {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : String(error);
        log(`图片任务 ${job.id} 失败：${job.error}`);
        return json(res, 500, { error: { message: job.error, type: "generation_error" } });
    }
}

async function jobGC(config: GatewayConfig) {    const cutoff = Date.now() - config.jobTtlHours * 3_600_000;
    for (const [id, job] of jobs) {
        if (job.createdAt < cutoff) {
            jobs.delete(id);
            await fs.rm(path.join(config.jobsDir, id), { recursive: true, force: true }).catch(() => undefined);
        }
    }
}

function json(res: ServerResponse, status: number, payload: unknown) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(body);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, config: GatewayConfig) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
    }

    const pathname = normalizeRequestPath(req.url ?? "/");
    if (pathname === "/healthz") {
        return json(res, 200, { status: "ok", executor: config.executor, comfyuiUrl: config.comfyuiUrl });
    }

    if (config.apiKey) {
        const authorization = String(req.headers.authorization ?? "");
        if (authorization !== `Bearer ${config.apiKey}`) {
            return json(res, 401, { error: { message: "API Key 不正确；请在 BeefTV 渠道里填写与 gateway config.apiKey 一致的 Key" } });
        }
    }

    if (req.method === "GET" && (pathname === "/models" || pathname.endsWith("/models"))) {
        const models = [
            ...Object.keys(config.modelWorkflows),
            ...Object.keys(config.modelTextEncoders),
            config.defaultModel,
            ...config.imageModels,
        ];
        return json(res, 200, { object: "list", data: [...new Set(models)].map((id) => ({ id, object: "model" })) });
    }

    if (req.method === "POST" && (pathname === "/images/generations" || pathname === "/images")) {
        return await handleImageGeneration(req, res, config);
    }

    if (req.method === "POST" && (pathname === "/images/edits")) {
        return await handleImageEdit(req, res, config);
    }

    if (req.method === "POST" && (pathname === "/videos" || pathname === "/videos/generations")) {
        return await createVideoJob(req, res, config);
    }

    const taskMatch = pathname.match(/^\/videos\/([^/]+)$/);
    if (req.method === "GET" && taskMatch) {
        const job = jobs.get(taskMatch[1]);
        if (!job) return json(res, 404, { error: { message: `任务 ${taskMatch[1]} 不存在或已被清理` } });
        return json(res, 200, {
            id: job.id,
            status: job.status,
            model: job.model,
            ...(job.status === "failed" ? { error: { message: job.error ?? "视频生成失败" } } : {}),
        });
    }

    const contentMatch = pathname.match(/^\/videos\/([^/]+)\/content$/);
    if (req.method === "GET" && contentMatch) {
        const job = jobs.get(contentMatch[1]);
        if (!job?.filePath) return json(res, 404, { error: { message: `任务 ${contentMatch[1]} 尚无成片` } });
        res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": (await fs.stat(job.filePath)).size });
        return createReadStream(job.filePath).pipe(res);
    }

    return json(res, 404, { error: { message: `未知接口 ${req.method} ${pathname}；本网关只实现 OpenAI Videos 协议` } });
}

async function main() {
    const config = await loadConfig();
    await fs.mkdir(config.jobsDir, { recursive: true });
    await jobGC(config);
    setInterval(() => void jobGC(config), 3_600_000).unref();

    const server = createServer((req, res) => {
        handleRequest(req, res, config).catch((error) => {
            log(`请求处理异常：${error instanceof Error ? error.stack : String(error)}`);
            if (!res.headersSent) json(res, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
        });
    });
    server.listen(config.port, config.host, () => {
        log(`ComfyUI 视频网关已启动：http://${config.host}:${config.port}  executor=${config.executor}`);
        if (config.executor === "mock") log("当前为 mock 模式，只回样例文件；联调 ComfyUI 请把 executor 改为 comfyui。");
        log(`BeefTV 渠道 Base URL 填：http://${config.host}:${config.port}/v1`);
    });

    const shutdown = () => {
        log("收到退出信号，正在关闭……");
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main().catch((error) => {
    log(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
