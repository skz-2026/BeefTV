// ComfyUI 视频网关：把 BeefTV 的 OpenAI Videos 协议请求翻译成本地 ComfyUI 工作流。
//
// 零第三方依赖。运行：node gateway.ts 或 bun gateway.ts（Node >= 22）。
// 协议契约（与 BeefTV web/src/services/api/video-provider-openai.ts 对齐）：
//   POST   {base}/videos            multipart/form-data，字段 model/prompt/seconds/size/input_reference[]
//   GET    {base}/videos/{id}       状态轮询，status: queued|in_progress|completed|failed
//   GET    {base}/videos/{id}/content  下载成片（video/mp4）
//   POST   {base}/audio/speech      TTS 配音（OpenAI 协议，代理到网关监督的按需 TTS 服务）
//   GET    {base}/voices            TTS 预置音色列表（读 voicesDir，不触发服务启动）
// 路径同时接受带 /v1 前缀和不带前缀两种形式。

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
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
    // Qwen-Image 图片模板（qwen-t2i/qwen-edit）的文本编码器，按模型名切换的规则与视频侧一致。
    defaultImageTextEncoder: string;
    workflows: { text: string; image: string; imageGen: string };
    modelWorkflows: Record<string, string>;
    // 图片模型按模型名切模板（如 UC 去审查 GGUF 用独立加载节点），未命中时回退 workflows.imageGen。
    modelImageWorkflows: Record<string, string>;
    jobsDir: string;
    jobTtlHours: number;
    tts: TTSConfig;
};

// TTS 声线服务（IndexTTS-2 voiceforge2）：网关监督的按需 GPU 负载。
// 请求时拉起（fastapi 就绪即回，模型在首次合成懒加载），闲置超时或被视频/生图
// 任务挤占时退出进程释放显存。ComfyUI 维持原有懒启动 + /free 卸载策略不变。
type TTSConfig = {
    enabled: boolean;
    url: string;
    models: string[];
    cwd: string;
    command: string[];
    voicesDir: string;
    startTimeoutMs: number;
    idleStopMs: number;
    stopBeforeGpuWorkload: boolean;
    design: TTSDesignConfig;
};

// 音色设计（Spark-TTS 受控生成：性别/音高/语速 → 新音色干声）。子进程即用即卸，
// 不常驻显存；产物 wav 命名后写入 voicesDir 即成预置音色，供 TTS 克隆复用。
type TTSDesignConfig = {
    enabled: boolean;
    cwd: string;
    command: string[];
    timeoutMs: number;
};

type JobStatus = "queued" | "in_progress" | "completed" | "failed" | "cancelled";

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
    // 取消链路：DELETE /v1/videos/{id} → 标记取消 + ComfyUI 队列删除/中断，排队任务轮到时跳过
    promptId?: string;
    cancelled?: boolean;
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
        defaultImageTextEncoder: String(parsed.defaultImageTextEncoder ?? "qwen3vl_8b_int8_convrot.safetensors"),
        workflows: {
            text: String(parsed.workflows?.text ?? "workflows/text-to-video.template.json"),
            image: String(parsed.workflows?.image ?? "workflows/ref-to-video.template.json"),
            imageGen: String(parsed.workflows?.imageGen ?? "workflows/qwen-t2i.template.json"),
        },
        modelWorkflows: parsed.modelWorkflows ?? {},
        modelImageWorkflows: parsed.modelImageWorkflows ?? {},
        jobsDir: path.resolve(scriptDir, String(parsed.jobsDir ?? "jobs")),
        jobTtlHours: Math.max(1, Number(parsed.jobTtlHours ?? 24)),
        tts: parseTTSConfig(parsed.tts),
    };
    if (!Number.isFinite(config.port) || config.port <= 0) throw new Error("config.port 无效");
    return config;
}

function parseTTSConfig(raw: unknown): TTSConfig {
    const parsed = (raw ?? {}) as Partial<TTSConfig> & { design?: Partial<TTSDesignConfig> };
    const design = (parsed.design ?? {}) as Partial<TTSDesignConfig>;
    return {
        enabled: Boolean(parsed.enabled),
        url: String(parsed.url ?? "http://127.0.0.1:9891").replace(/\/+$/, ""),
        models: Array.isArray(parsed.models) ? parsed.models.map(String) : [],
        cwd: path.resolve(String(parsed.cwd ?? "C:/AI/IndexTTS")),
        command: Array.isArray(parsed.command) && parsed.command.length ? parsed.command.map(String) : [".venv/Scripts/python.exe", "voice_forge2.py"],
        voicesDir: path.resolve(String(parsed.voicesDir ?? "C:/AI/CosyVoice/presets")),
        startTimeoutMs: Math.max(10_000, Number(parsed.startTimeoutMs ?? 90_000)),
        idleStopMs: Math.max(0, Number(parsed.idleStopMs ?? 600_000)),
        stopBeforeGpuWorkload: parsed.stopBeforeGpuWorkload !== false,
        design: {
            enabled: design.enabled !== false,
            cwd: path.resolve(String(design.cwd ?? "C:/AI/CosyVoice")),
            command: Array.isArray(design.command) && design.command.length ? design.command.map(String) : ["venv/Scripts/python.exe", "spark_design.py"],
            timeoutMs: Math.max(30_000, Number(design.timeoutMs ?? 180_000)),
        },
    };
}

const jobs = new Map<string, Job>();

// ---------- GPU 显存按需调度 ----------
// 16GB 显存放不下 H3 和 Qwen-Image 两套权重：所有生成任务串行执行；
// 连续同类任务复用已加载模型，任务类型（模板）切换时先 /free 卸载显存。
// 96GB 内存下 free_memory 保持 false：权重缓存留在内存，切回时免磁盘重读
//（官方/无审查两套编码器 + DiT 合计约 68GB，内存缓存得住）。
let gpuRunning = false;
let lastWorkload: string | null = null;

// 生图走优先车道：插到排队视频前面（正在执行的任务无法抢占），
// 避免视频连发时画布生图被堵到上游超时。同车道内保持 FIFO。
// tts 车道无优先级：配音单句秒级，排队等视频出片是预期行为（显存互斥）。
type GPULane = "image" | "video" | "tts";
type GPUPendingJob = {
    workloadKey: string;
    lane: GPULane;
    task: () => Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
};
const gpuPending: GPUPendingJob[] = [];

function enqueueGpuWork<T>(workloadKey: string, task: () => Promise<T>, config: GatewayConfig, lane: GPULane = "video"): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        gpuPending.push({ workloadKey, lane, task: task as () => Promise<unknown>, resolve: resolve as (value: unknown) => void, reject });
        pumpGpuQueue(config);
    });
}

function pumpGpuQueue(config: GatewayConfig): void {
    if (gpuRunning || gpuPending.length === 0) return;
    const index = gpuPending.some((job) => job.lane === "image")
        ? gpuPending.findIndex((job) => job.lane === "image")
        : 0;
    const [next] = gpuPending.splice(index, 1);
    gpuRunning = true;
    void (async () => {
        try {
            // 反向挤占：视频/生图任务需要整卡显存，TTS 常驻会吃掉 ~6.5GB，先回收再执行
            if (config.tts.enabled && config.tts.stopBeforeGpuWorkload && next.lane !== "tts") {
                await stopTTS(config, "为视频/生图任务让出显存");
            }
            if (lastWorkload !== next.workloadKey) {
                log(`切换生成负载（${lastWorkload ?? "空"} -> ${next.workloadKey.split(/[\\/]/).pop()}），先卸载已加载模型…`);
                await fetch(`${config.comfyuiUrl}/free`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ unload_models: true, free_memory: false }),
                }).catch(() => undefined);
                lastWorkload = next.workloadKey;
            }
            next.resolve(await next.task());
        } catch (error) {
            next.reject(error);
        } finally {
            gpuRunning = false;
            pumpGpuQueue(config);
        }
    })();
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
    // 主引用（openai-videos 插件 files[0]=input_reference 首图；浏览器直发路径 input_reference[] 多图）
    for (const key of ["input_reference[]", "input_reference"]) {
        for (const entry of form.getAll(key)) {
            if (isFile(entry)) files.push(entry);
        }
    }
    if (files.length) {
        // 插件追加参考图按序号命名（input_reference_1..6），拼在主引用之后；
        // 与纯序号协议（input_reference_0..5，h3-multiref）互斥使用。
        for (let i = 1; i <= 6; i += 1) {
            const entry = form.get(`input_reference_${i}`);
            if (isFile(entry)) files.push(entry);
        }
        return files;
    }
    for (let i = 0; i < 7; i += 1) {
        const entry = form.get(`input_reference_${i}`);
        if (isFile(entry)) files.push(entry);
    }
    return files;
}

// 音频参考（声线锚定 ref_audios / 台词驱动 drive_audio）：input_reference_audio[] 或按 MIME 判定的音频文件
function isAudioFile(file: File): boolean {
    return (file.type || "").startsWith("audio/") || /\.(mp3|wav|flac|ogg|m4a|aac)$/i.test(file.name || "");
}

function collectAudioReferences(form: FormData, imageRefs: File[]): File[] {
    const explicit: File[] = [];
    for (const key of ["input_reference_audio[]", "input_reference_audio", "drive_audio"]) {
        for (const entry of form.getAll(key)) {
            if (isFile(entry) && isAudioFile(entry)) explicit.push(entry);
        }
    }
    if (explicit.length) return explicit;
    return imageRefs.filter(isAudioFile);
}

function text(form: FormData, key: string): string {
    const value = form.get(key);
    return typeof value === "string" ? value.trim() : "";
}

// T8 口型绑定兜底：带了台词驱动音频但提示词没有任何 <Audio N> 引用时，按官方 lock_source
// 范式追加显式口型句。T8 的 prepare_prompt 只校验已有标签、从不自动注入；没有文本锚点时
// drive_audio 只是弱媒体参考，模型不做说话表演。仅在模板含 drive_audio 槽（台词驱动模板）时
// 生效，避免把声线锚定（ref_audios）误标成台词表演；调用方已写音频标签时不重复追加。
const AUDIO_TAG_RE = /\bAudio\s*#?\s*\d+\b/i;
function ensureAudioPerformanceBinding(prompt: string, workflow: unknown, audioCount: number): string {
    if (!audioCount || AUDIO_TAG_RE.test(prompt)) return prompt;
    if (!JSON.stringify(workflow).includes("drive_audio")) return prompt;
    return `${prompt}\n\nThe speaking character visibly performs the dialogue in precise synchronization with <Audio 1>. Preserve the source timing, phrasing, and rhythm of the audio with plausible mouth and body performance.`;
}

// ComfyUI 按需拉起：点击生成时若 ComfyUI 未运行，自动启动并等待就绪（无需定时检查）
let comfyRevival: Promise<boolean> | null = null;
let lastComfySpawn = 0;
async function probeComfy(config: GatewayConfig): Promise<boolean> {
    // 快速拒绝(<1.5s)=真死；超时=忙但活着（渲染中响应会变慢，不能误判）
    const t0 = Date.now();
    try {
        const r = await fetch(`${config.comfyuiUrl}/system_stats`, { signal: AbortSignal.timeout(15000) });
        return r.ok;
    } catch {
        return Date.now() - t0 < 1500;
    }
}
async function ensureComfy(config: GatewayConfig): Promise<void> {
    if (await probeComfy(config)) return;
    if (Date.now() - lastComfySpawn < 180_000) {
        log("拉起冷却中（180 秒内已拉起过），等待现有实例就绪");
        return;
    }
    if (!comfyRevival) {
        log("ComfyUI 不可达 - 按需自动拉起");
        lastComfySpawn = Date.now();
        comfyRevival = (async () => {
            try {
                spawn("schtasks", ["/Run", "/TN", "ComfyUI-Start"], { detached: true, stdio: "ignore" }).unref();
            } catch (e) {
                log(`拉起失败：${e instanceof Error ? e.message : String(e)}`);
            }
            const deadline = Date.now() + 150_000;
            while (Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 3000));
                if (await probeComfy(config)) {
                    log("ComfyUI 已按需恢复上线");
                    comfyRevival = null;
                    return;
                }
            }
            comfyRevival = null;
            log("ComfyUI 按需拉起超时（150 秒未上线）");
        })();
    }
    const ok = await comfyRevival;
    if (!ok) throw new Error("ComfyUI 按需拉起失败（150 秒未上线），请检查 start-comfy-detached.cmd");
}

// ---------- TTS（IndexTTS-2）按需生命周期 ----------
// 用时拉起、闲置/被挤占时退出。语音合成走独立进程，模型懒加载在首次请求
//（进程就绪 ~15s，首句合成再 +30~60s），由 canvas_audio 任务超时（分钟级）覆盖。
let ttsChild: ReturnType<typeof spawn> | null = null;
let ttsRevival: Promise<boolean> | null = null;
let ttsStopping: Promise<void> | null = null;
let lastTtsSpawn = 0;
let lastTtsJobAt = 0;

async function probeTTS(config: GatewayConfig): Promise<boolean> {
    try {
        const r = await fetch(`${config.tts.url}/health`, { signal: AbortSignal.timeout(3000) });
        return r.ok;
    } catch {
        return false;
    }
}

async function ensureTTS(config: GatewayConfig): Promise<void> {
    if (!config.tts.enabled) throw new Error("网关未启用 TTS（config.json tts.enabled）");
    if (await probeTTS(config)) return;
    if (Date.now() - lastTtsSpawn < 30_000 && !ttsRevival) throw new Error("TTS 拉起冷却中（30 秒内已尝试过），请稍后重试");
    if (!ttsRevival) {
        lastTtsSpawn = Date.now();
        log("TTS 服务不可达 - 按需自动拉起（进程就绪约 15 秒，首次合成含模型加载约 1 分钟）");
        ttsRevival = (async () => {
            try {
                const logDir = path.join(config.tts.cwd, "logs");
                await fs.mkdir(logDir, { recursive: true });
                const out = await fs.open(path.join(logDir, "forge2-gateway.log"), "a");
                try {
                    const child = spawn(config.tts.command[0], config.tts.command.slice(1), {
                        cwd: config.tts.cwd,
                        detached: true,
                        stdio: ["ignore", out.fd, out.fd],
                        windowsHide: true,
                    });
                    child.unref();
                    ttsChild = child;
                    child.on("exit", () => { if (ttsChild === child) ttsChild = null; });
                } finally {
                    await out.close();
                }
            } catch (e) {
                log(`TTS 拉起失败：${e instanceof Error ? e.message : String(e)}`);
            }
            const deadline = Date.now() + config.tts.startTimeoutMs;
            while (Date.now() < deadline) {
                await new Promise((r) => setTimeout(r, 2000));
                if (await probeTTS(config)) {
                    log("TTS 服务已按需上线");
                    ttsRevival = null;
                    return true;
                }
            }
            ttsRevival = null;
            log("TTS 按需拉起超时");
            return false;
        })();
    }
    if (!(await ttsRevival)) {
        throw new Error(`TTS 按需拉起失败（${Math.round(config.tts.startTimeoutMs / 1000)} 秒未就绪），请检查 ${path.join(config.tts.cwd, "logs", "forge2-gateway.log")}`);
    }
}

async function stopTTS(config: GatewayConfig, reason: string): Promise<void> {
    if (ttsStopping) return ttsStopping;
    ttsStopping = (async () => {
        if (!(await probeTTS(config))) {
            ttsChild = null;
            return;
        }
        log(`停止 TTS 服务（${reason}），释放显存`);
        const child = ttsChild;
        ttsChild = null;
        if (child?.pid) {
            await new Promise<void>((resolve) => {
                const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
                killer.on("close", () => resolve());
                killer.on("error", () => resolve());
            });
        } else {
            // 非网关拉起的实例（手动脚本/外部启动）：按端口找 PID 树杀，同样回收
            await ttsPortKill(config);
        }
        for (let i = 0; i < 20; i += 1) {
            if (!(await probeTTS(config))) return;
            await new Promise((r) => setTimeout(r, 500));
        }
        log("TTS 停止后端口仍被占用，请人工检查");
    })();
    try {
        await ttsStopping;
    } finally {
        ttsStopping = null;
    }
}

async function ttsPortKill(config: GatewayConfig): Promise<void> {
    const port = new URL(config.tts.url).port || "9891";
    const netstat = spawn("netstat", ["-ano", "-p", "TCP"], { windowsHide: true });
    let text = "";
    netstat.stdout?.on("data", (chunk) => { text += String(chunk); });
    await new Promise<void>((resolve) => {
        netstat.on("close", () => resolve());
        netstat.on("error", () => resolve());
    });
    const pids = new Set<string>();
    for (const line of text.split("\n")) {
        if (!line.includes("LISTENING")) continue;
        const columns = line.trim().split(/\s+/);
        if ((columns[1] ?? "").endsWith(`:${port}`)) {
            const pid = (columns[columns.length - 1] ?? "").trim();
            if (pid && pid !== "0") pids.add(pid);
        }
    }
    for (const pid of pids) {
        await new Promise<void>((resolve) => {
            const killer = spawn("taskkill", ["/PID", pid, "/T", "/F"]);
            killer.on("close", () => resolve());
            killer.on("error", () => resolve());
        });
        log(`已结束占用 TTS 端口 ${port} 的进程 PID ${pid}`);
    }
}

async function uploadReferenceToComfy(config: GatewayConfig, file: File, index: number): Promise<string> {
    await ensureComfy(config);
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
    audios: string[];
    textEncoder: string;
};

/** StoryDiffusion prompt 约定：`角色定义\n---\n分镜行1\n分镜行2…`（每行一格）；无 --- 分隔时整个 prompt 当单格 scene */
function splitRoleScene(prompt: string): { roleText: string; sceneText: string; batch: number } {
    const m = prompt.match(/^([\s\S]*?)\r?\n\s*-{3,}\s*\r?\n([\s\S]*)$/);
    const roleText = m ? m[1].trim() : "";
    const sceneText = (m ? m[2] : prompt).trim();
    const lines = sceneText.split(/\r?\n/).filter((line) => line.trim());
    return { roleText, sceneText, batch: Math.max(1, Math.min(8, lines.length)) };
}

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
        // 音频参考/台词驱动占位符：{{AUDIO}}=第一段，{{AUDIO_N}}=第 N 段（ref_audios 音色锚、drive_audio 台词驱动）
        const audioMatch = exact.match(/^\{\{AUDIO(?:_(\d+))?\}\}$/);
        if (audioMatch) {
            const index = Number(audioMatch[1] ?? 1) - 1;
            return context.audios[index] ?? "";
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

// 图片编辑模板：删除没有实际图片的 LoadImage 节点，并剪掉 TextEncodeQwenImage21 对应的 images.image_N 槽。
function pruneEmptyEditRefSlots(workflow: Record<string, unknown>) {
    const droppedNodes = new Set<string>();
    for (const [id, node] of Object.entries(workflow)) {
        if (!node || typeof node !== "object") continue;
        const typed = node as { class_type?: string; inputs?: Record<string, unknown> };
        if (typed.class_type !== "LoadImage" || !typed.inputs) continue;
        if (typeof typed.inputs.image === "string" && !typed.inputs.image.trim()) droppedNodes.add(id);
    }
    if (!droppedNodes.size) return;
    for (const [id, node] of Object.entries(workflow)) {
        if (!node || typeof node !== "object") continue;
        const typed = node as { class_type?: string; inputs?: Record<string, unknown> };
        if (typed.class_type !== "TextEncodeQwenImage21" || !typed.inputs) continue;
        for (const key of Object.keys(typed.inputs)) {
            if (!key.startsWith("images.image_")) continue;
            const link = typed.inputs[key];
            if (Array.isArray(link) && droppedNodes.has(String(link[0]))) delete typed.inputs[key];
        }
    }
    for (const id of droppedNodes) delete workflow[id];
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

// 音频模板：删除没有实际音频的 LoadAudio 节点和 ref_audios.ref_audio_N / drive_audio 槽位。
function pruneEmptyAudioSlots(workflow: Record<string, unknown>) {
    const dropped = new Set<string>();
    for (const [id, node] of Object.entries(workflow)) {
        if (!node || typeof node !== "object") continue;
        const typed = node as { class_type?: string; inputs?: Record<string, unknown> };
        if (typed.class_type !== "LoadAudio" || !typed.inputs) continue;
        if (typeof typed.inputs.audio === "string" && !typed.inputs.audio.trim()) dropped.add(id);
    }
    if (!dropped.size) return;
    for (const [id, node] of Object.entries(workflow)) {
        if (!node || typeof node !== "object") continue;
        const typed = node as { class_type?: string; inputs?: Record<string, unknown> };
        if (typed.class_type !== "MiniMaxH3AudioConditioningT8" || !typed.inputs) continue;
        for (const key of Object.keys(typed.inputs)) {
            if (key === "drive_audio" || /^ref_audios\.ref_audio_\d+$/.test(key)) {
                const link = typed.inputs[key];
                if (Array.isArray(link) && dropped.has(String(link[0]))) delete typed.inputs[key];
            }
        }
    }
    for (const id of dropped) delete workflow[id];
    if (dropped.size) log(`音频模板：剪除 ${dropped.size} 个空音频槽位`);
}

// 兜底剪枝：删除仍带空文件名的 LoadImage/LoadAudio（如只连 1 张图时 last_frame 落空），
// 并摘掉条件节点上指向已删节点的可选媒体槽（keyframe / ref / drive_audio / edit 槽）。
// 保证网关在任何请求形态下都不会把带空文件名加载器的图提交给 ComfyUI。
function pruneEmptyMediaNodes(workflow: Record<string, unknown>) {
    const dropped = new Set<string>();
    for (const [id, node] of Object.entries(workflow)) {
        if (!node || typeof node !== "object") continue;
        const typed = node as { class_type?: string; inputs?: { image?: unknown; audio?: unknown } };
        const emptyImage = typed.class_type === "LoadImage" && typeof typed.inputs?.image === "string" && !typed.inputs.image.trim();
        const emptyAudio = typed.class_type === "LoadAudio" && typeof typed.inputs?.audio === "string" && !typed.inputs.audio.trim();
        if (emptyImage || emptyAudio) dropped.add(id);
    }
    if (!dropped.size) return;
    for (const node of Object.values(workflow)) {
        if (!node || typeof node !== "object") continue;
        const typed = node as { class_type?: string; inputs?: Record<string, unknown> };
        if (typed.class_type !== "MiniMaxH3AudioConditioningT8" && typed.class_type !== "TextEncodeQwenImage21") continue;
        for (const key of Object.keys(typed.inputs ?? {})) {
            const optionalMediaSlot =
                key.startsWith("ref_images.") || key.startsWith("ref_audios.") || key.startsWith("images.image_") ||
                key === "drive_audio" || key === "first_frame" || key === "last_frame";
            if (!optionalMediaSlot) continue;
            const link = typed.inputs?.[key];
            if (Array.isArray(link) && dropped.has(String(link[0]))) delete typed.inputs?.[key];
        }
    }
    for (const id of dropped) delete workflow[id];
    if (dropped.size) log(`媒体槽兜底剪枝：删除 ${dropped.size} 个空加载节点（请求未提供对应素材）`);
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

// 图完整性防线：剪槽后若仍有链接指向不存在的节点（模板存在网关未覆盖的挂载形态），
// 宁可 400 报错也不把坏图提交给 ComfyUI——这是"任何请求形态都不会提交坏图"的结构性保证。
function assertNoDanglingLinks(workflow: unknown) {
    if (!workflow || typeof workflow !== "object") return;
    const ids = new Set(Object.keys(workflow as Record<string, unknown>));
    const dangling: string[] = [];
    for (const [id, node] of Object.entries(workflow as Record<string, unknown>)) {
        if (!node || typeof node !== "object") continue;
        for (const [key, value] of Object.entries((node as { inputs?: Record<string, unknown> }).inputs ?? {})) {
            if (Array.isArray(value) && !ids.has(String(value[0]))) dangling.push(`${id}.${key}->${value[0]}`);
        }
    }
    if (dangling.length) {
        throw new Error(`工作流存在悬空链接（模板挂载形态未被剪槽逻辑覆盖）：${dangling.join("、")}`);
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

// 采样参数覆盖：BeefTV 渠道模型 defaultOptions 经 openai-videos 插件转成表单字段（providerOptions.newapi）。
// 缺省字段保持模板值；steps/shift_video/shift_audio 只作用于 MiniMaxH3DualClockSamplerT8 采样器节点。
function applySamplerOverrides(workflow: Record<string, unknown>, form: FormData, jobId: string) {
    const overrides: Record<string, number> = {};
    const numeric = (key: string, min: number, max: number) => {
        const raw = Number(text(form, key));
        if (!Number.isFinite(raw) || raw <= 0) return;
        overrides[key] = Math.min(max, Math.max(min, raw));
    };
    numeric("steps", 2, 12);
    numeric("shift_video", 1, 25);
    numeric("shift_audio", 1, 10);
    if (!Object.keys(overrides).length) return;
    let touched = 0;
    for (const value of Object.values(workflow)) {
        if (value && typeof value === "object" && (value as { class_type?: unknown }).class_type === "MiniMaxH3DualClockSamplerT8") {
            const inputs = (value as { inputs: Record<string, unknown> }).inputs;
            for (const [key, val] of Object.entries(overrides)) inputs[key] = val;
            touched += 1;
        }
    }
    if (touched) log(`任务 ${jobId} 采样覆盖：${JSON.stringify(overrides)}（${touched} 个采样器节点）`);
}

async function parseSize(form: FormData, config: GatewayConfig): Promise<{ width: number; height: number; size: string }> {
    const raw = text(form, "size");
    // H3 等本地模型要求宽高被 32 整除；对请求尺寸向下取整对齐，保持画幅且不放大显存需求。
    const snap32 = (value: number) => Math.max(32, Math.floor(value / 32) * 32);
    // 画幅别名（BeefTV 节点会传 "16:9" 这类比例字符串）→ 32 对齐的基准分辨率（720P 档）
    const aspectAlias: Record<string, [number, number]> = {
        "16:9": [1280, 704], "9:16": [704, 1280], "1:1": [960, 960], "4:3": [1024, 768], "3:4": [768, 1024], "21:9": [1344, 576],
    };
    // 分辨率档位（后端 vquality，如 480p/720p）只在比例别名换算时生效；显式 WxH 以请求为准。
    // 480P=基准的 0.625 倍线性缩放后取整对齐；720P 及未知档位回落基准。1080P 在 16GB 显存上易 OOM，同样回落。
    const tierRaw = (text(form, "resolution") || text(form, "resolution_name")).trim().toLowerCase();
    const tierScale = tierRaw === "480p" || tierRaw === "480" ? 0.625 : 1;
    const scaleAlias = (alias: [number, number]): [number, number] => [
        Math.max(32, Math.round((alias[0] * tierScale) / 32) * 32),
        Math.max(32, Math.round((alias[1] * tierScale) / 32) * 32),
    ];
    const match = raw.match(/^(\d+)x(\d+)$/i);
    if (match) {
        const width = snap32(Number(match[1]));
        const height = snap32(Number(match[2]));
        return { width, height, size: `${width}x${height}` };
    }
    const alias = aspectAlias[raw.trim()];
    if (alias) {
        const [width, height] = scaleAlias(alias);
        if (tierScale !== 1) log(`分辨率档位 ${tierRaw}：${alias[0]}x${alias[1]} → ${width}x${height}`);
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
    const allRefs = collectReferenceFiles(form);
    const audioRefs = collectAudioReferences(form, allRefs);
    const references = allRefs.filter((f) => !isAudioFile(f));
    const mode: Job["mode"] = references.length > 0 ? "image" : "text";
    // 音频参考必须搭配图片：T2V 模板没有任何音频槽位，纯音频请求的音频会被静默剪掉，
    // 出片成功但口型/台词全无——这种静默降级比显式失败更难排查（E01 口型事故同族问题）。
    if (mode === "text" && audioRefs.length > 0) {
        return json(res, 400, { error: { message: "携带音频参考但没有任何图片：文生视频模板没有音频槽位，音频会被丢弃。请为首帧连一张图，或改用 dub 系模型名（如 h3-hybrid-dub-flf）。" } });
    }
    const override = config.modelWorkflows[model];
    // 未注册模型名（如通用名 minimax-h3）+ 图+音齐备：默认 ref-to-video 没有 drive_audio 槽，
    // 音频会被静默剪掉（口型/台词全丢）。改走 dub 模板兜底，画面走 ref 槽、音频走 drive_audio。
    const dubFallback = !override && mode === "image" && audioRefs.length > 0
        ? config.modelWorkflows["h3-hybrid-dub-flf"]
        : undefined;
    const workflowPath = override || dubFallback || (mode === "image" ? config.workflows.image : config.workflows.text);

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
    // 口型绑定兜底：改写 job.prompt 与 context.prompt，保证 T8 文本侧有 <Audio 1> 锚点
    job.prompt = ensureAudioPerformanceBinding(prompt, workflow, audioRefs.length);
    const { width, height, size } = await parseSize(form, config);
    // 可选 seed 表单参数：A/B 对比/复现实验用同一种子；缺省仍随机，不影响现有调用方。
    // Number("")===0：字段缺失必须按"未提供"处理，否则所有无 seed 请求共用固定种子 0，重摇不换结果。
    const seedRaw = text(form, "seed");
    const seedParam = seedRaw === "" ? Number.NaN : Number(seedRaw);
    const seed = Number.isFinite(seedParam) && seedParam >= 0 && seedParam <= 2_147_483_647
        ? Math.floor(seedParam)
        : Math.floor(Math.random() * 2_147_483_647);
    const context: PlaceholderContext = {
        prompt: job.prompt,
        negative: config.defaultNegativePrompt,
        seconds,
        // H3 官方换算：24fps 下 帧数 = 秒×24+4（示例工作流 5s→124 帧），生成范围 2–15 秒。
        frames: Math.max(52, Math.min(15, seconds) * 24 + 4),
        width,
        height,
        size,
        seed,
        images: [],
        audios: [],
        textEncoder: config.modelTextEncoders[model] ?? config.defaultTextEncoder,
    };

    // 音频参考上传（ref_audios 声线锚定 / drive_audio 台词驱动模板消费 {{AUDIO_N}}）
    if (audioRefs.length && config.executor === "comfyui") {
        for (let index = 0; index < audioRefs.length && index < 4; index += 1) {
            context.audios.push(await uploadReferenceToComfy(config, audioRefs[index], 90 + index));
        }
        log(`任务前置：${audioRefs.length} 段音频参考已上传`);
    }

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
    if (substituted && typeof substituted === "object") {
        pruneEmptyRefSlots(substituted as Record<string, unknown>);
        pruneEmptyAudioSlots(substituted as Record<string, unknown>);
        pruneEmptyMediaNodes(substituted as Record<string, unknown>);
    }
    try {
        assertNoLeftoverPlaceholders(substituted);
        assertNoDanglingLinks(substituted);
    } catch (error) {
        return json(res, 400, { error: { message: error instanceof Error ? error.message : String(error) } });
    }
    applySamplerOverrides(substituted as Record<string, unknown>, form, job.id);

    jobs.set(job.id, job);
    await fs.mkdir(path.join(config.jobsDir, job.id), { recursive: true });
    log(`任务 ${job.id} 已创建：model=${model} 模板=${path.basename(job.workflowPath)}${override ? "" : dubFallback ? "（未注册模型名，图+音齐备走 dub 兜底）" : "（未注册模型名，按参考图回退默认模板）"} mode=${mode} seconds=${seconds} size=${size} seed=${seed}`);

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
    await ensureComfy(config);
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
    job.promptId = promptId;
    log(`任务 ${job.id} 已提交 ComfyUI：prompt_id=${promptId}`);

    const deadline = Date.now() + config.timeoutMinutes * 60_000;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
        if (job.cancelled) throw new Error("任务已取消");
        let historyResponse: Response;
        try {
            historyResponse = await fetch(`${config.comfyuiUrl}/history/${promptId}`);
        } catch {
            await new Promise((r) => setTimeout(r, config.pollIntervalMs));
            continue;
        }
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
    if (job.cancelled) {
        job.status = "cancelled";
        log(`任务 ${job.id} 在排队期间被取消，跳过执行`);
        return;
    }
    try {
        const target = config.executor === "mock" ? await mockRun(config, job) : await comfyRun(config, job, workflow);
        job.status = "completed";
        job.filePath = target;
        log(`任务 ${job.id} 完成`);
    } catch (error) {
        if (job.cancelled) {
            job.status = "cancelled";
            job.error = "任务已取消";
            log(`任务 ${job.id} 已取消`);
            return;
        }
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
        size: `${width}x${height}`, seed: Math.floor(Math.random() * 2_147_483_647), images: [composited], audios: [],
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
        seed: Math.floor(Math.random() * 2_147_483_647), images: [firstFrameName], audios: [],
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
    // 尺寸复用 parseSize：支持显式 WxH 和 16:9/9:16 等画幅别名（此前别名会静默回落 1280x704 横图）
    // parseSize 是 async，必须 await——漏掉会解构出 undefined，工作流拿到非法尺寸只能按参考图/默认值出小图。
    const { width, height } = await parseSize(form, config);
    // 可选 seed 表单参数：首帧编辑复现/对照实验用同一种子；缺省随机，不影响现有调用方。
    // 同上：Number("")===0，字段缺失走随机。
    const editSeedRaw = text(form, "seed");
    const editSeedParam = editSeedRaw === "" ? Number.NaN : Number(editSeedRaw);
    const editSeed = Number.isFinite(editSeedParam) && editSeedParam >= 0 && editSeedParam <= 2_147_483_647
        ? Math.floor(editSeedParam)
        : Math.floor(Math.random() * 2_147_483_647);

    // 收集输入图片（input_reference[] / input_reference / image）
    const inputFiles: File[] = [];
    for (const key of ["input_reference[]", "input_reference", "image", "image[]"]) {
        for (const entry of form.getAll(key)) {
            if (isFile(entry)) inputFiles.push(entry);
        }
    }
    if (!inputFiles.length) return json(res, 400, { error: { message: "图片编辑需要至少一张输入图片（input_reference）" } });
    if (inputFiles.length > 6) return json(res, 400, { error: { message: `图片编辑最多支持 6 张参考图（收到 ${inputFiles.length} 张），多余请合并为对照表或分镜拆解` } });

    if (config.executor === "mock") {
        return json(res, 500, { error: { message: "mock 模式不支持图片编辑" } });
    }

    log(`图片编辑任务开始：model=${model} 输入图=${inputFiles.length} 张 ${width}x${height} seed=${editSeed} prompt=${prompt.slice(0, 60)}`);
    try {
        // 1. 上传所有输入图到 ComfyUI（每张独立，不拼接——保持各参考图身份完整）
        const imageNames: string[] = [];
        for (let i = 0; i < inputFiles.length; i++) {
            imageNames.push(await uploadFileToComfyUI(config, Buffer.from(await inputFiles[i].arrayBuffer()), `beeftv-edit-${i}-${Date.now()}.png`));
        }
        // 2. 选择编辑模板：qwen-edit / qwen-edit-plus / uncensored 渠道统一走 Qwen-Image-2.1 原生编辑模板
        //（仅编码器按渠道名切换）；模型感知路由：model 命中 modelWorkflows 时优使用该工作流（如 supir-hd 超分修复）
        const editTemplatePath = config.modelWorkflows[model]
            ? config.modelWorkflows[model]
            : (config.modelWorkflows["qwen-edit"] || "workflows/qwen-edit.template.json");
        const editPath = templateAbsolutePath(config, editTemplatePath);
        const editWorkflow = stripDocKeys(JSON.parse(await fs.readFile(editPath, "utf8")));
        // images[0] = 主参考（第一张），images[1..] = 附加参考
        const substituted = substitutePlaceholders(editWorkflow, {
            prompt, negative: "", seconds: 0, frames: 0, width, height,
            size: `${width}x${height}`, seed: editSeed,
            images: imageNames, audios: [],
            textEncoder: config.modelTextEncoders[model] ?? config.defaultImageTextEncoder,
        });
        // 未提供的参考图槽位：剪掉空 LoadImage 和对应 images.image_N 输入
        pruneEmptyEditRefSlots(substituted as Record<string, any>);
        pruneEmptyMediaNodes(substituted as Record<string, any>);
        assertNoDanglingLinks(substituted);
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
    await ensureComfy(config);
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
        let historyResponse: Response;
        try {
            historyResponse = await fetch(`${config.comfyuiUrl}/history/${promptId}`);
        } catch {
            await new Promise((r) => setTimeout(r, config.pollIntervalMs));
            continue;
        }
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
    // 可选 seed 字段：场景底图等需要复现的生图用同一种子；缺省随机。
    const genSeedParam = Number(body.seed);
    const genSeed = Number.isFinite(genSeedParam) && genSeedParam >= 0 && genSeedParam <= 2_147_483_647
        ? Math.floor(genSeedParam)
        : Math.floor(Math.random() * 2_147_483_647);

    const job: Job = {
        id: randomUUID(),
        status: "in_progress",
        createdAt: Date.now(),
        model,
        prompt,
        mode: "text",
        workflowPath: config.modelImageWorkflows[model] ?? config.workflows.imageGen,
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
        seed: genSeed,
        images: [],
        audios: [],
        textEncoder: config.modelTextEncoders[model] ?? config.defaultImageTextEncoder,
    });
    assertNoLeftoverPlaceholders(substituted);
    log(`图片任务 ${job.id} 开始：model=${model} ${width}x${height} seed=${genSeed} prompt=${prompt.slice(0, 60)}`);

    try {
        if (config.executor === "mock") {
            throw new Error("mock 模式不支持生图；请把 executor 设为 comfyui");
        }
        const buffers = await enqueueGpuWork(job.workflowPath, () => comfyRunImages(config, substituted), config, "image");
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

// ==================== 管理控制台（/admin，仅限本机访问） ====================
// 查看并在线修改 workflows/*.template.json 的采样参数。模板在每个任务提交时实时读盘，
// 因此控制台保存后下一个任务即生效，无需重启网关。每次保存前自动备份到 workflows/.backups/。

type ParamDoc = {
    label: string;
    doc: string;
    kind?: "number" | "text" | "select";
    min?: number;
    max?: number;
    step?: number;
    options?: string[];
    editable?: boolean;
};

const PARAM_DOCS: Record<string, Record<string, ParamDoc>> = {
    MiniMaxH3DualClockSamplerT8: {
        steps: {
            label: "采样步数", kind: "number", min: 1, max: 60, step: 1,
            doc: "去噪步数：越多细节/一致性越好、越慢。搭配 turbo LoRA 时 4~8 步是甜点（v4_step600 官方建议 6-8，超过 8 开始过度锐化）；去掉 LoRA 的全采样档用 20（参考驱动镜头官方建议 20，参考漂移严重升 25）。改动只影响之后提交的任务。",
        },
        shift_video: {
            label: "视频时钟偏移", kind: "number", min: 1, max: 25, step: 1,
            doc: "视频去噪调度曲线的 sigma 偏移，官方值 12。决定开头噪声强度与运动幅度倾向；无明确目的不要改。",
        },
        shift_audio: {
            label: "音频时钟偏移", kind: "number", min: 1, max: 10, step: 1,
            doc: "音频去噪调度偏移，官方值 3，与 shift_video 配对使用。无明确目的不要改。",
        },
    },
    LoraLoaderModelOnly: {
        lora_name: {
            label: "加速 LoRA 权重", kind: "text",
            doc: "蒸馏加速件。minimax_h3_turbo_v4_step600_ema=当前推荐（静态/小动作最强、微细节最好，配 6-8 步）；文件名带「4步加速ema」的是旧版 v1_850（配 4 步）；ref2v_turbo_4step=多参考专用。删掉这个节点+步数提到 20 就是非加速档（已有现成的 -steady 模板，不必手改）。",
        },
        strength_model: {
            label: "LoRA 强度", kind: "number", min: 0, max: 1, step: 0.05,
            doc: "1.0=完全生效。降到 0.6-0.8 可缓和过锐，但不等价于非加速模板；要质量请直接换 -steady 档。",
        },
    },
    LoraLoaderBypassModelOnly: {
        lora_name: { label: "加速 LoRA 权重", kind: "text", doc: "同 LoraLoaderModelOnly（绕过文本编码器分支的变体）。" },
        strength_model: { label: "LoRA 强度", kind: "number", min: 0, max: 1, step: 0.05, doc: "同 LoraLoaderModelOnly。" },
    },
    MiniMaxH3AudioConditioningT8: {
        task_type: {
            label: "任务形态", kind: "select", options: ["T2VA", "Ref2VA", "Hybrid"],
            doc: "T2VA=纯文本生成；Ref2VA=参考图驱动；Hybrid=首帧+参考图混合（dub/flf 系模板用，首帧管构图、设定稿管身份）。",
        },
        audio_mode: {
            label: "音轨策略", kind: "select", options: ["native", "lock_source", "remix_source", "reference_only"],
            doc: "native=模型联合生成环境音；lock_source=驱动 wav 原声直通音轨（台词配音必须，画面向 wav 对齐）；remix_source=模型重新演绎音色；reference_only=仅作参考不进音轨。",
        },
        audio_denoise_strength: {
            label: "音频去噪强度", kind: "number", min: 0, max: 1, step: 0.05,
            doc: "lock_source 直通配音保持 0（保真，模型不动音轨）；native 联合生成可用 1。",
        },
        add_source_as_reference: {
            label: "驱动音频作参考", kind: "select", options: ["true", "false"],
            doc: "口型三件套之一：把驱动 wav 同时作为声线/节奏参考。台词驱动镜头必须 true（false 是 E01 口型事故的头号原因）。",
        },
        prompt_primary_audio_ordinal: {
            label: "主音频序号", kind: "number", min: 0, max: 4, step: 1,
            doc: "口型三件套之二：第几条 <Audio N> 是台词主驱动（1-based，0=无）。必须配合提示词里显式的 <Audio 1> 引用才生效（网关 ensureAudioPerformanceBinding 会兜底补写）。",
        },
        strict_prompt_tags: {
            label: "标签严格校验", kind: "select", options: ["true", "false"],
            doc: "校验提示词里的 <Picture N>/<Audio N> 是否真有对应接线，悬空标签直接报错而不是静默错绑。保持 true。",
        },
        ref_image_size: { label: "参考图尺寸策略", kind: "text", doc: "match=参考图跟随输出分辨率裁缩。保持 match。" },
        reference_video_policy: { label: "参考视频时长策略", kind: "text", doc: "official_2_to_15s=官方 2~15 秒约束。保持默认。" },
    },
    UNETLoader: {
        unet_name: {
            label: "底模（扩散模型）", kind: "text",
            doc: "fl2va=首帧/文生通用（可生成音频）；ref2va=多参考角色一致性优化（设定稿驱动镜头用它）；fasth3_8step=蒸馏快速底模（仅草稿）。名字带 _pruned=官方剪枝版。换底模要确认配套 LoRA/步数仍然匹配。",
        },
        weight_dtype: { label: "权重精度", kind: "text", doc: "default=按文件精度（int8_convrot 量化）。保持 default。" },
    },
    CLIPLoader: {
        clip_name: {
            label: "文本编码器", kind: "text",
            doc: "{{TEXT_ENCODER}} 是占位符：实际文件由 config.json 的 defaultTextEncoder/modelTextEncoders 按模型名决定（默认官方 qwen3vl_32b nvfp4；heretic 后缀=去审查微调版）。改编码器去 config.json，不要改这里。",
        },
        type: { label: "编码器协议", kind: "text", doc: "minimax=H3 专用协议。保持。" },
    },
    BasicScheduler: {
        steps: { label: "调度步数（噪声源）", kind: "number", min: 1, max: 60, step: 1, doc: "注意：T8 模板里这个节点只是给采样器提供 sigma 噪声表，实际步数由 MiniMaxH3DualClockSamplerT8 的 steps 决定，改这里不改变采样时长。" },
        scheduler: { label: "调度器", kind: "text", doc: "simple=官方推荐（配 res_multistep 采样器）。保持。" },
        denoise: { label: "去噪强度", kind: "number", min: 0, max: 1, step: 0.01, doc: "1.0=从纯噪声生成。保持 1.0。" },
    },
    KSamplerSelect: {
        sampler_name: { label: "采样器", kind: "text", doc: "res_multistep=官方 H3 推荐采样器。保持。" },
    },
    RandomNoise: {
        noise_seed: { label: "随机种子", kind: "text", doc: "{{SEED}}=网关按请求注入（请求不传则真随机）；写死数字=固定种子可复现（A/B 对照用）。" },
        control: { label: "种子控制", kind: "text", doc: "fixed=按 seed 生成。保持 fixed。" },
    },
    VAELoader: {
        vae_name: {
            label: "VAE 解码器", kind: "text",
            doc: "minimax_h3_video_vae=画面解码；minimax_h3_audio_vae=音轨解码。两个节点各司其职，别互换。",
        },
    },
    VHS_VideoCombine: {
        frame_rate: { label: "帧率", kind: "number", min: 1, max: 60, step: 1, doc: "H3 原生 24fps，与 length 帧数换算绑定（8s=192帧上下）。保持 24。" },
        crf: { label: "压缩质量 CRF", kind: "number", min: 0, max: 51, step: 1, doc: "h264 质量因子，越小越清晰、文件越大。19=高质量默认；成片要再超分/剪辑可降到 16。" },
        format: { label: "封装格式", kind: "text", doc: "video/h264-mp4=通用兼容。保持。" },
        pix_fmt: { label: "像素格式", kind: "text", doc: "yuv420p=播放器兼容最广。保持。" },
        filename_prefix: { label: "输出目录/前缀", kind: "text", doc: "相对 ComfyUI output 目录，如 MiniMaxH3/beeftv_hybrid。" },
        trim_to_audio: { label: "裁切到音频长度", kind: "select", options: ["true", "false"], doc: "true=成片时长截到音轨结束。lock_source 长视频场景可开。" },
        save_metadata: { label: "写入元数据", kind: "select", options: ["true", "false"], doc: "把工作流写进 mp4 元数据，便于事后排查。建议 true。" },
        save_output: { label: "存入 output 目录", kind: "select", options: ["true", "false"], doc: "false=存 temp。保持 true。" },
    },
    LoadImage: {
        image: {
            label: "图片槽位", kind: "text",
            doc: "{{IMAGE}}=首帧（管构图/机位）、{{IMAGE_2}}=尾帧、{{IMAGE_3..7}}=角色设定稿槽位。占位符由网关按请求顺序注入，改槽位语义要去 config.json 对应模板，不建议在模板里挪。",
        },
    },
    LoadAudio: {
        audio: { label: "音频槽位", kind: "text", doc: "{{AUDIO}}=台词驱动 wav（请求的 drive_audio）。占位符运行时注入。" },
    },
    PrimitiveStringMultiline: {
        value: { label: "文本", kind: "text", doc: "模板内嵌常量。通常是占位说明或固定后缀，改前先确认不与网关注入冲突。" },
    },
};

function isLoopbackRequest(req: IncomingMessage): boolean {
    const remote = String(req.socket.remoteAddress ?? "");
    return remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
}

function workflowsDir(config: GatewayConfig): string {
    return path.resolve(scriptDir, "workflows");
}

function templateUsedBy(config: GatewayConfig, file: string): string[] {
    const used: string[] = [];
    const push = (label: string, value: string | undefined) => {
        if (value && templateAbsolutePath(config, value) === templateAbsolutePath(config, `workflows/${file}`)) used.push(label);
    };
    for (const [key, value] of Object.entries(config.workflows)) push(`workflows.${key}`, value);
    for (const [model, value] of Object.entries(config.modelWorkflows)) push(`模型 ${model}`, value);
    for (const [model, value] of Object.entries(config.modelImageWorkflows ?? {})) push(`图片模型 ${model}`, value);
    return used;
}

type TemplateParam = {
    nodeId: string;
    nodeClass: string;
    nodeRole: string;
    field: string;
    label: string;
    doc: string;
    value: unknown;
    kind: "number" | "text" | "select" | "placeholder" | "link";
    min?: number;
    max?: number;
    step?: number;
    options?: string[];
    editable: boolean;
};

function nodeRoleLabel(nodeClass: string, inputs: Record<string, unknown>): string {
    const value = inputs.image;
    if (nodeClass === "LoadImage" && typeof value === "string") {
        if (value === "{{IMAGE}}") return "首帧槽";
        if (value === "{{IMAGE_2}}") return "尾帧槽";
        const match = value.match(/\{\{IMAGE_(\d+)\}\}/);
        if (match) return `参考稿槽 ${match[1]}`;
    }
    if (nodeClass === "LoadAudio") return "台词驱动音频";
    if (nodeClass === "VAELoader") {
        const name = String(inputs.vae_name ?? "");
        return name.includes("audio") ? "音频 VAE" : "视频 VAE";
    }
    return "";
}

function describeTemplate(config: GatewayConfig, file: string, raw: string) {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const readme = Array.isArray(parsed._README) ? (parsed._README as unknown[]).map(String) : [];
    const graph: Record<string, { class_type?: unknown; inputs?: Record<string, unknown> }> = {};
    for (const [nodeId, node] of Object.entries(parsed)) {
        if (!node || typeof node !== "object" || Array.isArray(node)) continue;
        const record = node as Record<string, unknown>;
        if (typeof record.class_type !== "string") continue;
        graph[nodeId] = { class_type: record.class_type, inputs: (record.inputs ?? {}) as Record<string, unknown> };
    }
    const params: TemplateParam[] = [];
    const nodeOrder = Object.keys(graph).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
    for (const nodeId of nodeOrder) {
        const node = graph[nodeId];
        const nodeClass = String(node.class_type);
        const docs = PARAM_DOCS[nodeClass] ?? {};
        const inputs = node.inputs ?? {};
        const role = nodeRoleLabel(nodeClass, inputs);
        for (const [field, rawValue] of Object.entries(inputs)) {
            if (Array.isArray(rawValue)) continue; // 连线在原始 JSON 里看
            const doc = docs[field];
            const valueStr = String(rawValue);
            const isPlaceholder = valueStr.includes("{{");
            const kind: TemplateParam["kind"] = isPlaceholder
                ? "placeholder"
                : doc?.kind === "number" && typeof rawValue === "number"
                    ? "number"
                    : doc?.kind === "select"
                        ? "select"
                        : "text";
            params.push({
                nodeId,
                nodeClass,
                nodeRole: role,
                field,
                label: doc?.label ?? field,
                doc: doc?.doc
                    ?? (isPlaceholder
                        ? "运行时占位符：网关按请求注入实际值，不需要在模板里改。"
                        : `原始字段（未收录释义）。类型 ${typeof rawValue}。`),
                value: rawValue,
                kind,
                min: doc?.min,
                max: doc?.max,
                step: doc?.step,
                options: doc?.options,
                editable: Boolean(doc) && !isPlaceholder,
            });
        }
    }
    return {
        file,
        usedBy: templateUsedBy(config, file),
        readme,
        params,
        nodeInventory: nodeOrder.map((nodeId) => ({ nodeId, nodeClass: String(graph[nodeId].class_type) })),
        raw: parsed,
    };
}

async function handleAdminList(req: IncomingMessage, res: ServerResponse, config: GatewayConfig) {
    if (!isLoopbackRequest(req)) return json(res, 403, { error: { message: "管理控制台仅限本机访问" } });
    const dir = workflowsDir(config);
    const files = (await fs.readdir(dir)).filter((name) => name.endsWith(".json")).sort();
    const templates = [];
    for (const file of files) {
        try {
            const raw = await fs.readFile(path.join(dir, file), "utf8");
            templates.push(describeTemplate(config, file, raw));
        } catch (error) {
            templates.push({ file, error: error instanceof Error ? error.message : String(error) });
        }
    }
    return json(res, 200, { templates, backupDir: "workflows/.backups/" });
}

async function handleAdminSave(req: IncomingMessage, res: ServerResponse, config: GatewayConfig) {
    if (!isLoopbackRequest(req)) return json(res, 403, { error: { message: "管理控制台仅限本机访问" } });
    const body = (await new Promise<Record<string, unknown>>((resolve, reject) => {
        let data = "";
        req.on("data", (chunk: Buffer) => (data += chunk));
        req.on("end", () => {
            try { resolve(JSON.parse(data)); } catch (error) { reject(error instanceof Error ? error : new Error(String(error))); }
        });
        req.on("error", reject);
    }).catch((error) => error)) as Record<string, unknown>;
    if (body instanceof Error) return json(res, 400, { error: { message: `请求体不是合法 JSON：${body.message}` } });

    const file = String(body.file ?? "");
    if (!/^[\w.-]+\.json$/.test(file)) return json(res, 400, { error: { message: `非法文件名：${file}` } });
    const dir = workflowsDir(config);
    const filePath = path.join(dir, file);
    let graph: Record<string, Record<string, unknown>>;
    try {
        graph = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, Record<string, unknown>>;
    } catch (error) {
        return json(res, 400, { error: { message: `读取模板失败：${error instanceof Error ? error.message : String(error)}` } });
    }
    const edits = Array.isArray(body.edits) ? (body.edits as Array<Record<string, unknown>>) : [];
    if (!edits.length) return json(res, 400, { error: { message: "没有要保存的修改" } });

    for (const edit of edits) {
        const nodeId = String(edit.nodeId ?? "");
        const field = String(edit.field ?? "");
        const node = graph[nodeId];
        if (!node || typeof node !== "object" || typeof node.class_type !== "string") {
            return json(res, 400, { error: { message: `节点不存在：${nodeId}` } });
        }
        const inputs = (node.inputs ?? {}) as Record<string, unknown>;
        if (!(field in inputs)) return json(res, 400, { error: { message: `节点 ${nodeId} 没有字段 ${field}` } });
        if (Array.isArray(inputs[field])) return json(res, 400, { error: { message: `字段 ${nodeId}.${field} 是连线，不能改值` } });
        const doc = PARAM_DOCS[String(node.class_type)]?.[field];
        const rawValue = edit.value;
        if (doc?.kind === "number") {
            const num = Number(rawValue);
            if (!Number.isFinite(num)) return json(res, 400, { error: { message: `${nodeId}.${field} 需要数字，收到 ${JSON.stringify(rawValue)}` } });
            inputs[field] = doc.min === undefined && doc.max === undefined ? num : Math.min(doc.max ?? num, Math.max(doc.min ?? num, num));
        } else if (doc?.kind === "select") {
            const text = String(rawValue);
            if (doc.options && !doc.options.includes(text)) {
                return json(res, 400, { error: { message: `${nodeId}.${field} 只允许 ${doc.options.join(" / ")}` } });
            }
            inputs[field] = text === "true" ? true : text === "false" ? false : text;
        } else if (typeof rawValue === "string") {
            if (rawValue.includes("{{") !== String(inputs[field]).includes("{{")) {
                return json(res, 400, { error: { message: `${nodeId}.${field} 是运行时占位符，不能改成字面值（或反之）` } });
            }
            inputs[field] = rawValue;
        } else {
            return json(res, 400, { error: { message: `${nodeId}.${field} 类型不支持：${typeof rawValue}` } });
        }
    }

    await fs.mkdir(path.join(dir, ".backups"), { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
    await fs.copyFile(filePath, path.join(dir, ".backups", `${file}.${stamp}.bak`));
    await fs.writeFile(filePath, JSON.stringify(graph, null, "    ") + "\n", "utf8");
    log(`管理控制台：${file} 已更新 ${edits.length} 个参数（已备份到 workflows/.backups/）`);
    return json(res, 200, { ok: true, effect: "下一个提交的任务即使用新参数，无需重启网关", backup: `workflows/.backups/${file}.${stamp}.bak` });
}

const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ComfyUI 视频网关 · 模板参数控制台</title>
<style>
:root { color-scheme: dark; --bg:#0e1116; --panel:#151a21; --card:#171c24; --border:#252c37; --border-2:#2f3846;
  --text:#e6ebf0; --muted:#8b95a3; --accent:#4f8cff; --amber:#e0b25f; --green:#34d399; --red:#f87171; }
* { box-sizing:border-box; }
html,body { height:100%; }
body { margin:0; background:var(--bg); color:var(--text); font:13.5px/1.55 ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif; display:flex; flex-direction:column; }
header { padding:10px 16px; border-bottom:1px solid var(--border); display:flex; align-items:baseline; gap:12px; flex-wrap:wrap; background:var(--panel); }
header h1 { font-size:15px; margin:0; }
header .sub { color:var(--muted); font-size:12px; }
main { flex:1; display:flex; min-height:0; }
aside { width:264px; flex:none; border-right:1px solid var(--border); background:var(--panel); display:flex; flex-direction:column; }
aside .search { padding:10px 12px; }
aside input[type=search] { width:100%; background:#0c0f14; border:1px solid var(--border-2); color:var(--text); border-radius:8px; padding:7px 10px; font-size:13px; }
aside input[type=search]:focus { outline:none; border-color:var(--accent); }
nav { overflow-y:auto; padding:0 8px 12px; flex:1; }
.tpl { display:block; width:100%; text-align:left; background:none; border:0; color:var(--text); border-radius:8px;
  padding:8px 10px; margin:2px 0; cursor:pointer; font-size:12.5px; font-family:ui-monospace,Consolas,monospace; }
.tpl:hover { background:#1c232e; }
.tpl.active { background:#20304a; color:#cfe2ff; }
.tpl .meta { display:block; color:var(--muted); font-size:11px; margin-top:2px; font-family:ui-sans-serif; }
.tpl .meta.used { color:#7ea6d9; }
section { flex:1; overflow-y:auto; padding:16px 20px 84px; min-width:0; }
.tpl-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:6px; }
.tpl-head h2 { font-size:15px; margin:0; font-family:ui-monospace,Consolas,monospace; }
.badge { background:#233043; color:#9cc3e8; border-radius:10px; padding:2px 9px; font-size:11.5px; }
.badge.none { background:#2a2431; color:#b093c9; }
.readme { background:#10151c; border-left:3px solid #3a6ea5; padding:8px 12px; margin:10px 0; color:#a9b6c2; font-size:12px; white-space:pre-wrap; border-radius:0 6px 6px 0; }
.toolbar { display:flex; gap:10px; align-items:center; margin:8px 0 10px; }
.toolbar input[type=search] { flex:1; max-width:420px; background:#0c0f14; border:1px solid var(--border-2); color:var(--text); border-radius:8px; padding:6px 10px; font-size:12.5px; }
.toolbar .count { color:var(--muted); font-size:12px; }
details.node { background:var(--card); border:1px solid var(--border); border-radius:10px; margin:10px 0; overflow:hidden; }
details.node summary { cursor:pointer; padding:9px 14px; font-family:ui-monospace,Consolas,monospace; font-size:12.5px;
  display:flex; align-items:center; gap:8px; list-style:none; user-select:none; }
details.node summary::-webkit-details-marker { display:none; }
details.node summary::before { content:"▸"; color:var(--muted); transition:transform .12s; }
details.node[open] summary::before { transform:rotate(90deg); }
details.node summary .role { color:#7ea6d9; font-family:ui-sans-serif; font-size:11.5px; background:#1b2839; border-radius:8px; padding:1px 8px; }
details.node summary .n { color:var(--muted); font-size:11px; margin-left:auto; font-family:ui-sans-serif; }
table { width:100%; border-collapse:collapse; font-size:12.5px; }
th { text-align:left; color:var(--muted); font-weight:500; font-size:11.5px; border-bottom:1px solid var(--border); padding:6px 10px; }
td { border-bottom:1px solid #1d232c; padding:7px 10px; vertical-align:top; }
tr:last-child td { border-bottom:none; }
tr:hover td { background:#1a212b; }
td.name { white-space:nowrap; }
td.name small { display:block; color:var(--muted); font-size:10.5px; font-family:ui-monospace,Consolas,monospace; }
td.doc { color:#98a5b3; max-width:460px; }
input[type=number], input[type=text] { background:#0c0f14; border:1px solid var(--border-2); color:var(--text); border-radius:6px; padding:5px 8px; width:200px; font-family:ui-monospace,Consolas,monospace; font-size:12.5px; }
input:focus { outline:none; border-color:var(--accent); }
input.changed { border-color:var(--amber); background:#241f12; }
select { background:#0c0f14; border:1px solid var(--border-2); color:var(--text); border-radius:6px; padding:5px 8px; font-size:12.5px; }
select.changed { border-color:var(--amber); background:#241f12; }
.ph { color:var(--amber); font-family:ui-monospace,Consolas,monospace; font-size:12px; }
.raw details { margin-top:10px; }
.raw pre { background:#0c0f14; padding:10px; border-radius:8px; overflow:auto; max-height:380px; font-size:11.5px; border:1px solid var(--border); }
.savebar { position:fixed; left:0; right:0; bottom:0; background:#141922f2; border-top:1px solid var(--border-2);
  padding:10px 20px; display:flex; align-items:center; gap:14px; transform:translateY(100%); transition:transform .15s; backdrop-filter:blur(4px); }
.savebar.show { transform:none; }
.savebar .diff { color:var(--amber); font-size:12.5px; }
.savebar button { background:var(--accent); border:0; color:#fff; border-radius:8px; padding:8px 20px; font-size:13px; cursor:pointer; }
.savebar button:disabled { opacity:.45; cursor:default; }
.savebar .revert { background:none; border:1px solid var(--border-2); color:var(--muted); padding:7px 14px; }
header .tts-box { margin-left:auto; display:flex; align-items:center; gap:8px; }
header .tts-box .state { color:var(--muted); font-size:12px; }
header .tts-box .state.on { color:var(--green); }
.hbtn { background:var(--accent); border:0; color:#fff; border-radius:8px; padding:5px 12px; font-size:12px; cursor:pointer; }
.hbtn.ghost { background:none; border:1px solid var(--border-2); color:var(--muted); }
.hbtn:disabled { opacity:.45; cursor:default; }
#toast { position:fixed; right:20px; bottom:64px; background:#1f2937; border:1px solid #374151; padding:10px 16px; border-radius:8px; display:none; max-width:520px; font-size:12.5px; z-index:9; }
.empty { color:var(--muted); padding:40px 20px; text-align:center; }
.err { color:var(--red); }
@media (max-width: 760px) { aside { width:200px; } td.doc { max-width:none; } }
</style></head><body>
<header><h1>模板参数控制台</h1><span class="sub">保存后<b>下一个任务即生效</b>（模板按任务实时读盘）· 每次保存自动备份 workflows/.backups/ · 金色 <span class="ph">{{占位符}}</span> 由网关按请求注入，不可改</span>
<div class="tts-box"><span class="state" id="tts-state">TTS 检测中…</span><button class="hbtn" id="tts-start">启动 TTS</button><button class="hbtn ghost" id="tts-stop">停止 TTS</button></div></header>
<main>
<aside>
  <div class="search"><input type="search" id="tpl-search" placeholder="筛选模板文件名…"></div>
  <nav id="tpl-list"></nav>
</aside>
<section id="content"><div class="empty">加载中…</div></section>
</main>
<div class="savebar" id="savebar"><span class="diff" id="diff"></span><button id="save" disabled>保存修改</button><button class="revert" id="revert">放弃修改</button></div>
<div id="toast"></div>
<script>
let TPLS = [], current = null, filter = '';

async function load() {
  const res = await fetch('/admin/api/templates');
  const data = await res.json();
  TPLS = data.templates || [];
  renderList();
  if (!current) {
    const preferred = TPLS.find(t => t.usedBy && t.usedBy.some(u => u.includes('h3-hybrid-dub-flf') && !u.includes('steady') && !u.includes('s8'))) || TPLS[0];
    if (preferred) select(preferred.file);
  } else {
    select(current);
  }
}

function renderList() {
  const nav = document.getElementById('tpl-list');
  nav.innerHTML = '';
  const kw = filter.toLowerCase();
  for (const t of TPLS) {
    if (kw && !t.file.toLowerCase().includes(kw)) continue;
    const b = document.createElement('button');
    b.className = 'tpl' + (t.file === current ? ' active' : '');
    const n = t.error ? '解析失败' : (t.params.length + ' 参数');
    const used = t.usedBy && t.usedBy.length ? '← ' + t.usedBy.join('、') : '未被 config 引用';
    b.innerHTML = t.file + '<span class="meta ' + (t.usedBy && t.usedBy.length ? 'used' : '') + '">' + n + ' · ' + used + '</span>';
    b.addEventListener('click', () => select(t.file));
    nav.appendChild(b);
  }
  if (!nav.children.length) nav.innerHTML = '<div class="empty" style="padding:16px">无匹配模板</div>';
}

function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'); }

function select(file) {
  if (current && current !== file) resetChanges();
  current = file;
  renderList();
  const t = TPLS.find(x => x.file === file);
  const c = document.getElementById('content');
  if (!t) { c.innerHTML = '<div class="empty">未找到模板</div>'; return; }
  if (t.error) { c.innerHTML = '<div class="empty err">解析失败：' + esc(t.error) + '</div>'; return; }
  let html = '<div class="tpl-head"><h2>' + t.file + '</h2>';
  html += (t.usedBy || []).map(u => '<span class="badge">' + esc(u) + '</span>').join('') || '<span class="badge none">未被 config 引用</span>';
  html += '</div>';
  if (t.readme && t.readme.length) html += '<div class="readme">' + esc(t.readme.join('\\n')) + '</div>';
  html += '<div class="toolbar"><input type="search" id="param-search" placeholder="在参数名/释义中搜索…"><span class="count" id="param-count"></span></div><div id="groups"></div>';
  html += '<div class="raw"><details><summary>原始 JSON（含连线）</summary><pre>' + esc(JSON.stringify(t.raw, null, 2)) + '</pre></details></div>';
  c.innerHTML = html;
  document.getElementById('param-search').addEventListener('input', e => renderGroups(t, e.target.value));
  renderGroups(t, '');
}

const KEY_NODES = ['MiniMaxH3DualClockSamplerT8','LoraLoaderModelOnly','LoraLoaderBypassModelOnly','MiniMaxH3AudioConditioningT8','VHS_VideoCombine'];

function renderGroups(t, kw) {
  const groups = new Map();
  for (const p of t.params) {
    const key = p.nodeClass + '#' + p.nodeId;
    if (!groups.has(key)) groups.set(key, { nodeClass: p.nodeClass, nodeId: p.nodeId, role: p.nodeRole, params: [] });
    groups.get(key).params.push(p);
  }
  const lower = kw.toLowerCase();
  const wrap = document.getElementById('groups');
  wrap.innerHTML = '';
  let shown = 0;
  for (const [key, g] of groups) {
    const visible = g.params.filter(p => !lower || (p.label + ' ' + p.field + ' ' + p.doc + ' ' + p.nodeClass).toLowerCase().includes(lower));
    if (!visible.length) continue;
    shown += visible.length;
    const d = document.createElement('details');
    d.className = 'node';
    d.open = !lower || KEY_NODES.includes(g.nodeClass);
    let inner = '<summary>' + esc(g.nodeClass) + ' #' + esc(g.nodeId)
      + (g.role ? '<span class="role">' + esc(g.role) + '</span>' : '')
      + '<span class="n">' + visible.length + ' 参数</span></summary><table><tr><th>参数</th><th>值</th><th>含义</th></tr>';
    for (const p of visible) {
      let control;
      if (p.kind === 'placeholder') control = '<span class="ph">' + esc(p.value) + '</span>';
      else if (p.kind === 'number') control = '<input type="number" data-node="' + p.nodeId + '" data-field="' + p.field + '" data-orig="' + p.value + '" value="' + p.value + '"' + (p.min !== undefined ? ' min="' + p.min + '"' : '') + (p.max !== undefined ? ' max="' + p.max + '"' : '') + (p.step !== undefined ? ' step="' + p.step + '"' : '') + '>';
      else if (p.kind === 'select') control = '<select data-node="' + p.nodeId + '" data-field="' + p.field + '" data-orig="' + String(p.value) + '">' + p.options.map(o => '<option' + (String(p.value) === o ? ' selected' : '') + '>' + o + '</option>').join('') + '</select>';
      else control = '<input type="text" data-node="' + p.nodeId + '" data-field="' + p.field + '" data-orig="' + esc(p.value) + '" value="' + esc(p.value) + '">';
      inner += '<tr><td class="name">' + esc(p.label) + '<small>' + esc(p.field) + '</small></td><td>' + control + '</td><td class="doc">' + esc(p.doc) + '</td></tr>';
    }
    d.innerHTML = inner + '</table>';
    wrap.appendChild(d);
  }
  wrap.querySelectorAll('input,select').forEach(el => el.addEventListener('input', () => { el.classList.toggle('changed', el.value !== el.dataset.orig); updateSavebar(); }));
  document.getElementById('param-count').textContent = shown + ' / ' + t.params.length + ' 个参数';
}

function collectEdits() {
  const edits = [];
  document.querySelectorAll('#content input[data-node],#content select[data-node]').forEach(el => {
    if (el.value === el.dataset.orig) return;
    edits.push({ nodeId: el.dataset.node, field: el.dataset.field, value: el.type === 'number' ? Number(el.value) : el.value });
  });
  return edits;
}

function updateSavebar() {
  const n = collectEdits().length;
  const bar = document.getElementById('savebar');
  bar.classList.toggle('show', n > 0);
  document.getElementById('diff').textContent = n + ' 处修改待保存';
  document.getElementById('save').disabled = n === 0;
}

function resetChanges() {
  document.querySelectorAll('#content .changed').forEach(el => { el.value = el.dataset.orig; el.classList.remove('changed'); });
  updateSavebar();
}

document.getElementById('revert').addEventListener('click', resetChanges);
document.getElementById('save').addEventListener('click', async () => {
  const edits = collectEdits();
  if (!edits.length) return;
  const btn = document.getElementById('save');
  btn.disabled = true;
  const res = await fetch('/admin/api/template', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ file: current, edits }) });
  const data = await res.json();
  const toast = document.getElementById('toast');
  toast.style.display = 'block';
  toast.textContent = res.ok ? ('已保存：' + data.effect + '（备份 ' + data.backup + '）') : ('保存失败：' + (data.error && data.error.message || res.status));
  setTimeout(() => toast.style.display = 'none', 6000);
  if (res.ok) await load(); else updateSavebar();
});
document.getElementById('tpl-search').addEventListener('input', e => { filter = e.target.value; renderList(); });

// TTS 声线服务（IndexTTS-2）状态：请求时自动拉起；闲置或被视频任务挤占时自动退出释放显存
async function loadTTS() {
  const el = document.getElementById('tts-state');
  try {
    const r = await fetch('/admin/api/tts');
    const d = await r.json();
    if (!d.enabled) { el.textContent = 'TTS 未启用'; el.className = 'state'; }
    else if (d.running) {
      const mins = d.idleRemainingMs === null ? '' : ' · ' + Math.ceil(d.idleRemainingMs / 60000) + ' 分钟后闲置回收';
      el.textContent = 'TTS 运行中' + mins; el.className = 'state on';
    } else { el.textContent = 'TTS 已停止（配音请求会自动拉起）'; el.className = 'state'; }
  } catch { el.textContent = 'TTS 状态未知'; el.className = 'state'; }
}
document.getElementById('tts-start').addEventListener('click', async () => {
  const btn = document.getElementById('tts-start'); btn.disabled = true; btn.textContent = '拉起中…';
  try { await fetch('/admin/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start' }) }); } catch {}
  btn.disabled = false; btn.textContent = '启动 TTS'; loadTTS();
});
document.getElementById('tts-stop').addEventListener('click', async () => {
  await fetch('/admin/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop' }) });
  loadTTS();
});
setInterval(loadTTS, 5000);

load();
loadTTS();
</script></body></html>
`;


async function readRawBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBuffer);
        total += buf.length;
        if (total > limitBytes) throw new Error("请求体过大");
        chunks.push(buf);
    }
    return Buffer.concat(chunks);
}

// POST /audio/speech：进 GPU 串行队列（tts 车道），按需拉起 TTS 后代理，二进制 wav 直回。
// 上游 4xx（如未知音色）原样透传，让调用方拿到可读的错误 JSON。
async function handleTTSSpeech(req: IncomingMessage, res: ServerResponse, config: GatewayConfig) {
    if (!config.tts.enabled) return json(res, 404, { error: { message: "网关未启用 TTS（config.json tts.enabled）" } });
    const body = await readRawBody(req, 8 << 20);
    let upstreamError: { status: number; body: string } | null = null;
    try {
        const wav = await enqueueGpuWork("tts", async () => {
            await ensureTTS(config);
            lastTtsJobAt = Date.now();
            const upstream = await fetch(`${config.tts.url}/v1/audio/speech`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body,
                signal: AbortSignal.timeout(config.timeoutMinutes * 60_000),
            });
            if (!upstream.ok) {
                upstreamError = { status: upstream.status, body: (await upstream.text()).slice(0, 500) };
                throw new Error(`TTS 上游返回 ${upstream.status}`);
            }
            const buffer = Buffer.from(await upstream.arrayBuffer());
            if (buffer.length < 4 || buffer.toString("ascii", 0, 4) !== "RIFF") {
                throw new Error("TTS 上游返回的不是有效 WAV 音频");
            }
            return buffer;
        }, config, "tts");
        res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length });
        return res.end(wav);
    } catch (error) {
        if (upstreamError) {
            res.writeHead(upstreamError.status, { "Content-Type": "application/json" });
            return res.end(upstreamError.body);
        }
        log(`TTS 合成失败：${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) return json(res, 502, { error: { message: error instanceof Error ? error.message : String(error) } });
    }
}

// GET /voices：读预置目录列音色名，不触发 TTS 服务启动（零成本冷列表）。
async function handleVoicesList(res: ServerResponse, config: GatewayConfig) {
    if (!config.tts.enabled) return json(res, 404, { error: { message: "网关未启用 TTS（config.json tts.enabled）" } });
    try {
        const entries = await fs.readdir(config.tts.voicesDir);
        const voices = entries.filter((f) => f.toLowerCase().endsWith(".wav")).map((f) => f.slice(0, -4)).sort();
        return json(res, 200, { voices });
    } catch {
        // 目录缺失/不可读：返回空列表，前端回落静态建议
        return json(res, 200, { voices: [] });
    }
}

async function handleAdminTTS(req: IncomingMessage, res: ServerResponse, config: GatewayConfig) {
    if (!isLoopbackRequest(req)) return json(res, 403, { error: { message: "管理控制台仅限本机访问" } });
    if (req.method === "GET") {
        const running = await probeTTS(config);
        return json(res, 200, {
            enabled: config.tts.enabled,
            running,
            url: config.tts.url,
            idleStopMs: config.tts.idleStopMs,
            idleRemainingMs: running && lastTtsJobAt > 0 && config.tts.idleStopMs > 0
                ? Math.max(0, lastTtsJobAt + config.tts.idleStopMs - Date.now())
                : null,
        });
    }
    if (req.method === "POST") {
        let action = "";
        try {
            const parsed = JSON.parse((await readRawBody(req, 64 << 10)).toString("utf8") || "{}") as { action?: string };
            action = String(parsed.action ?? "");
        } catch {
            return json(res, 400, { error: { message: "请求体必须是 JSON" } });
        }
        if (action === "start") {
            try {
                await ensureTTS(config);
                return json(res, 200, { ok: true });
            } catch (e) {
                return json(res, 500, { error: { message: e instanceof Error ? e.message : String(e) } });
            }
        }
        if (action === "stop") {
            await stopTTS(config, "管理员手动停止");
            return json(res, 200, { ok: true });
        }
        return json(res, 400, { error: { message: "action 必须是 start 或 stop" } });
    }
    return json(res, 405, { error: { message: "方法不支持" } });
}

// ---------- 音色设计（Spark-TTS 受控生成，子进程即用即卸） ----------
const VOICE_DESIGN_GENDERS = new Set(["male", "female"]);
const VOICE_DESIGN_PITCHES = new Set(["very_low", "low", "moderate", "high", "very_high"]);
const VOICE_DESIGN_SPEEDS = new Set(["very_low", "low", "moderate", "high", "very_high"]);
const VOICE_NAME_PATTERN = /^[\p{Script=Han}A-Za-z0-9_-]{1,24}$/u;

type VoiceDesignRequest = { gender: string; pitch: string; speed: string; text: string };

function parseVoiceDesignRequest(raw: string): VoiceDesignRequest {
    let parsed: Partial<VoiceDesignRequest>;
    try {
        parsed = JSON.parse(raw) as Partial<VoiceDesignRequest>;
    } catch {
        throw Object.assign(new Error("请求体必须是 JSON"), { statusCode: 400 });
    }
    const gender = String(parsed.gender ?? "male");
    const pitch = String(parsed.pitch ?? "moderate");
    const speed = String(parsed.speed ?? "moderate");
    const text = String(parsed.text ?? "").trim().slice(0, 200);
    if (!VOICE_DESIGN_GENDERS.has(gender) || !VOICE_DESIGN_PITCHES.has(pitch) || !VOICE_DESIGN_SPEEDS.has(speed)) {
        throw Object.assign(new Error("gender/pitch/speed 参数不合法"), { statusCode: 400 });
    }
    if (!text) throw Object.assign(new Error("试听文本不能为空"), { statusCode: 400 });
    return { gender, pitch, speed, text };
}

// 运行 spark_design.py：stdin JSON → stdout WAV 字节。超时强杀，失败带 stderr 摘要。
async function runVoiceDesignProcess(config: GatewayConfig, params: VoiceDesignRequest): Promise<Buffer> {
    return await new Promise<Buffer>((resolve, reject) => {
        const child = spawn(config.tts.design.command[0], config.tts.design.command.slice(1), {
            cwd: config.tts.design.cwd,
            windowsHide: true,
        });
        const stdout: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let killed = false;
        const timer = setTimeout(() => {
            killed = true;
            spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"]).on("close", () => undefined);
            reject(new Error(`音色设计超时（${Math.round(config.tts.design.timeoutMs / 1000)} 秒）`));
        }, config.tts.design.timeoutMs);
        child.stdout?.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
        child.stderr?.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
        child.on("error", (e) => { clearTimeout(timer); reject(e); });
        child.on("close", () => {
            clearTimeout(timer);
            if (killed) return;
            const wav = Buffer.concat(stdout);
            if (wav.length > 4 && wav.toString("ascii", 0, 4) === "RIFF") return resolve(wav);
            const stderr = Buffer.concat(stderrChunks).toString("utf8").slice(-500);
            reject(new Error(`音色设计子进程失败：${stderr || "无输出"}`));
        });
        child.stdin?.end(JSON.stringify(params), "utf8");
    });
}

// POST /audio/voice-design：设计一个新音色并返回试听 wav（进 tts 车道，与合成/视频互斥）。
async function handleVoiceDesign(req: IncomingMessage, res: ServerResponse, config: GatewayConfig) {
    if (!config.tts.enabled || !config.tts.design.enabled) {
        return json(res, 404, { error: { message: "网关未启用音色设计（config.json tts.design）" } });
    }
    let params: VoiceDesignRequest;
    try {
        params = parseVoiceDesignRequest((await readRawBody(req, 64 << 10)).toString("utf8"));
    } catch (error) {
        return json(res, (error as { statusCode?: number }).statusCode ?? 400, { error: { message: error instanceof Error ? error.message : String(error) } });
    }
    log(`音色设计：${params.gender} / ${params.pitch} / ${params.speed}（Spark 子进程即用即卸）`);
    try {
        const wav = await enqueueGpuWork("voice-design", () => runVoiceDesignProcess(config, params), config, "tts");
        res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length });
        return res.end(wav);
    } catch (error) {
        log(`音色设计失败：${error instanceof Error ? error.message : String(error)}`);
        return json(res, 502, { error: { message: error instanceof Error ? error.message : String(error) } });
    }
}

// POST /audio/voice-design/save：把设计产物（base64 wav）命名写入预置池，立即成为可克隆音色。
async function handleVoiceDesignSave(req: IncomingMessage, res: ServerResponse, config: GatewayConfig) {
    if (!config.tts.enabled || !config.tts.design.enabled) {
        return json(res, 404, { error: { message: "网关未启用音色设计（config.json tts.design）" } });
    }
    let parsed: { name?: string; wavBase64?: string; text?: string; overwrite?: boolean };
    try {
        parsed = JSON.parse((await readRawBody(req, 32 << 20)).toString("utf8")) as typeof parsed;
    } catch {
        return json(res, 400, { error: { message: "请求体必须是 JSON" } });
    }
    const name = String(parsed.name ?? "").trim();
    if (!VOICE_NAME_PATTERN.test(name)) {
        return json(res, 400, { error: { message: "音色名只能包含中文/字母/数字/下划线/连字符，长度 1-24" } });
    }
    let wav: Buffer;
    try {
        wav = Buffer.from(String(parsed.wavBase64 ?? ""), "base64");
    } catch {
        return json(res, 400, { error: { message: "wavBase64 解码失败" } });
    }
    if (wav.length < 44 || wav.length > 20 << 20 || wav.toString("ascii", 0, 4) !== "RIFF") {
        return json(res, 400, { error: { message: "音频内容无效（必须是 WAV）" } });
    }
    const wavPath = path.join(config.tts.voicesDir, `${name}.wav`);
    if (parsed.overwrite !== true && await fs.stat(wavPath).then(() => true).catch(() => false)) {
        return json(res, 409, { error: { message: `音色 "${name}" 已存在（overwrite=true 可覆盖）` } });
    }
    await fs.writeFile(wavPath, wav);
    const text = String(parsed.text ?? "").trim();
    if (text) await fs.writeFile(path.join(config.tts.voicesDir, `${name}.txt`), text, "utf8");
    log(`新音色已入库：${name}.wav（${(wav.length / 1024).toFixed(0)}KB${parsed.overwrite ? "，覆盖" : ""}）`);
    const entries = await fs.readdir(config.tts.voicesDir).catch(() => [] as string[]);
    const voices = entries.filter((f) => f.toLowerCase().endsWith(".wav")).map((f) => f.slice(0, -4)).sort();
    return json(res, 200, { ok: true, name, voices });
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
        const ttsStatus = config.tts.enabled ? ((await probeTTS(config)) ? "running" : "stopped") : "disabled";
        return json(res, 200, { status: "ok", executor: config.executor, comfyuiUrl: config.comfyuiUrl, tts: ttsStatus });
    }

    // 管理控制台：仅限本机浏览器访问，且不走 API Key 校验（本地部署的密钥本来就为空）。
    if (pathname === "/admin" || pathname === "/admin/") {
        if (!isLoopbackRequest(req)) return json(res, 403, { error: { message: "管理控制台仅限本机访问" } });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(ADMIN_PAGE_HTML);
    }
    if (pathname === "/admin/api/templates") return handleAdminList(req, res, config);
    if (pathname === "/admin/api/template" && req.method === "POST") return handleAdminSave(req, res, config);
    if (pathname === "/admin/api/tts" && (req.method === "GET" || req.method === "POST")) return handleAdminTTS(req, res, config);

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
            ...config.tts.models,
        ];
        return json(res, 200, { object: "list", data: [...new Set(models)].map((id) => ({ id, object: "model" })) });
    }

    if (req.method === "GET" && (pathname === "/voices" || pathname.endsWith("/voices"))) {
        return await handleVoicesList(res, config);
    }

    if (req.method === "POST" && (pathname === "/audio/speech" || pathname.endsWith("/audio/speech"))) {
        return await handleTTSSpeech(req, res, config);
    }

    if (req.method === "POST" && (pathname === "/audio/voice-design" || pathname.endsWith("/audio/voice-design"))) {
        return await handleVoiceDesign(req, res, config);
    }

    if (req.method === "POST" && (pathname === "/audio/voice-design/save" || pathname.endsWith("/audio/voice-design/save"))) {
        return await handleVoiceDesignSave(req, res, config);
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

    // 取消任务（openai-videos 插件 cancel 钩子）：排队中→跳过；执行中→删 ComfyUI 队列并中断
    if (req.method === "DELETE" && taskMatch) {
        const job = jobs.get(taskMatch[1]);
        if (!job) return json(res, 404, { error: { message: `任务 ${taskMatch[1]} 不存在或已被清理` } });
        if (job.status === "completed" || job.status === "cancelled") {
            return json(res, 200, { id: job.id, status: job.status });
        }
        job.cancelled = true;
        if (job.status === "in_progress" && job.promptId) {
            await fetch(`${config.comfyuiUrl}/queue`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ delete: [job.promptId] }),
            }).catch(() => undefined);
            await fetch(`${config.comfyuiUrl}/interrupt`, { method: "POST" }).catch(() => undefined);
        }
        job.status = "cancelled";
        job.error = "任务已取消";
        log(`任务 ${job.id} 收到取消请求（${job.promptId ? `已中断 ComfyUI ${job.promptId}` : "排队中，轮到时跳过"}）`);
        return json(res, 200, { id: job.id, status: "cancelled" });
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

    // TTS 闲置回收：最后一次合成后超时退出进程（从未被网关使用过的外部实例不动）
    if (config.tts.enabled && config.tts.idleStopMs > 0) {
        setInterval(() => {
            if (lastTtsJobAt > 0 && Date.now() - lastTtsJobAt > config.tts.idleStopMs) {
                void stopTTS(config, `闲置超过 ${Math.round(config.tts.idleStopMs / 60000)} 分钟自动回收`);
            }
        }, 30_000).unref();
    }

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
