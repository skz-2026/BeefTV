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
    workflows: { text: string; image: string };
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
        workflows: {
            text: String(parsed.workflows?.text ?? "workflows/text-to-video.template.json"),
            image: String(parsed.workflows?.image ?? "workflows/image-to-video.template.json"),
        },
        modelWorkflows: parsed.modelWorkflows ?? {},
        jobsDir: path.resolve(scriptDir, String(parsed.jobsDir ?? "jobs")),
        jobTtlHours: Math.max(1, Number(parsed.jobTtlHours ?? 24)),
    };
    if (!Number.isFinite(config.port) || config.port <= 0) throw new Error("config.port 无效");
    return config;
}

const jobs = new Map<string, Job>();

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

function assertNoLeftoverPlaceholders(workflow: unknown) {
    const leftovers = new Set<string>();
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
    const context: PlaceholderContext = {
        prompt,
        negative: config.defaultNegativePrompt,
        seconds,
        // H3 官方换算：24fps 下 帧数 = 秒×24+4（示例工作流 5s→124 帧），生成范围 2–15 秒。
        frames: Math.max(52, Math.min(15, seconds) * 24 + 4),
        width,
        height,
        size,
        seed: Math.floor(Math.random() * 2_147_483_647),
        images: [],
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
    try {
        assertNoLeftoverPlaceholders(substituted);
    } catch (error) {
        return json(res, 400, { error: { message: error instanceof Error ? error.message : String(error) } });
    }

    jobs.set(job.id, job);
    await fs.mkdir(path.join(config.jobsDir, job.id), { recursive: true });
    log(`任务 ${job.id} 已创建：model=${model} mode=${mode} seconds=${seconds} size=${size}`);
    void runJob(config, job, substituted).catch((error) => {
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

async function jobGC(config: GatewayConfig) {
    const cutoff = Date.now() - config.jobTtlHours * 3_600_000;
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
        const models = [...Object.keys(config.modelWorkflows), config.defaultModel];
        return json(res, 200, { object: "list", data: [...new Set(models)].map((id) => ({ id, object: "model" })) });
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
