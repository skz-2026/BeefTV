// LoRA Studio —— 短剧角色卡司 LoRA 一站式训练台（独立前后端，零依赖 Bun 服务）
// 流程：建剧 → 传三视图(自动裁正/侧/背) → 一键姿势扩增数据集(走网关 qwen-edit) → 一键合训(AI Toolkit) → 自动交付(ComfyUI loras + 网关路由) → A/B 验收
// 复用：C:\AI\ai-toolkit（训练引擎）、8765 网关（数据集生成）、8188 ComfyUI（生成引擎）
// 环境守卫：数据集生成需 ComfyUI 在线；训练需 ComfyUI 停机（脚本自动切换，训完拉回）
const { randomUUID } = await import("node:crypto");
const fs = await import("node:fs");
const path = await import("node:path");
const { spawn, execFile } = await import("node:child_process");

const PORT = Number(process.env.STUDIO_PORT || 8890);
const STUDIO_DIR = import.meta.dir;
const DATA_ROOT = "C:/AI/lora-studio";
const TOOLKIT = "C:/AI/ai-toolkit";
const TOOLKIT_PY = `${TOOLKIT}/venv/Scripts/python.exe`;
const CONFIG_DIR = `${TOOLKIT}/config/studio`;
const COMFY_LORAS = "C:/AI/ComfyUI-Portable/ComfyUI/models/loras";
const GATEWAY_DIR = "C:/work/BeefTV/local/comfy-video-gateway";
const GW = "http://127.0.0.1:8765";
const COMFY = "http://127.0.0.1:8188";

// ---------- 工具 ----------
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
function ensureDir(p: string) { fs.mkdirSync(p, { recursive: true }); return p; }
function readJson<T>(p: string, fallback: T): T { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; } }
function writeJson(p: string, v: unknown) { fs.writeFileSync(p, JSON.stringify(v, null, 2)); }
const j = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const ok = (body: unknown) => j(200, { ok: true, ...body as object });
const fail = (status: number, msg: string) => j(status, { ok: false, error: msg });

async function httpOk(url: string, ms = 4000) { try { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); const r = await fetch(url, { signal: c.signal }); clearTimeout(t); return r.ok; } catch { return false; } }

async function gpuUsed() {
    try {
        const out = await new Promise<string>((resolve) => execFile("nvidia-smi", ["--query-gpu=utilization.gpu,memory.used,memory.total", "--format=csv,noheader,nounits"], { shell: true }, (e, so) => resolve(String(so || ""))));
        const [util, used, total] = out.trim().split(",").map((x) => Number(x.trim()));
        return { util, used, total };
    } catch { return { util: -1, used: -1, total: -1 }; }
}

async function trainingProcessInfo() {
    try {
        const out = await new Promise<string>((resolve) => execFile(
            "powershell", ["-NoProfile", "-Command",
                "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'python.exe' -and $_.CommandLine -match 'run.py' } | Select-Object -ExpandProperty ProcessId"],
            { shell: false }, (e, so) => resolve(String(so || ""))));
        const pids = out.split(/\s+/).map(Number).filter(Boolean);
        return { running: pids.length > 0, pids };
    } catch { return { running: false, pids: [] as number[] }; }
}

function killPort(port: number) {
    return new Promise<boolean>((resolve) => {
        execFile("netstat", ["-ano"], { shell: false }, (_e, so) => {
            const line = String(so || "").split("\n").find((l) => l.includes("LISTENING") && l.includes(`:${port} `));
            const pid = line?.trim().split(/\s+/).pop();
            if (!pid) return resolve(false);
            execFile("taskkill", ["/F", "/PID", pid, "/T"], { shell: false }, () => resolve(true));
        });
    });
}

// 三视图裁切（复用 .local/crop-sheet.py）
function cropSheet(src: string, outDir: string) {
    return new Promise<void>((resolve, reject) => {
        execFile("python", ["C:/work/BeefTV/.local/crop-sheet.py", src, outDir], { shell: false }, (e, so, se) => (e ? reject(new Error(String(se || e))) : resolve()));
    });
}

// 对照表（复用 .local/contact-sheet.py，动态生成）
function contactSheet(dir: string, out: string) {
    return new Promise<void>((resolve, reject) => {
        execFile("python", ["C:/work/BeefTV/.local/contact-sheet.py", dir, out], { shell: false }, (e, so, se) => (e ? reject(new Error(String(se || e))) : resolve()));
    });
}

// ---------- 数据模型 ----------
type Char = {
    trigger: string;              // 触发词（拼音）
    displayName: string;          // 中文名
    desc?: string;                // 英文锁定描述（提示词用）
    sheetFile?: string;           // 原始三视图（相对剧目录）
    build?: { active: boolean; done: number; total: number; error?: string };
};
type Drama = {
    id: string; name: string; createdAt: string;
    chars: Char[];
    training?: { status: "idle" | "running" | "done" | "failed"; logPath?: string; scriptPath?: string; startedAt?: string; loraFile?: string; error?: string; steps?: number };
    delivered?: { route?: string; template?: string; loraCopied?: boolean };
};
const dramasFile = `${DATA_ROOT}/dramas.json`;
function loadDramas(): Drama[] { return readJson<Drama[]>(dramasFile, []); }
function saveDramas(ds: Drama[]) { ensureDir(DATA_ROOT); writeJson(dramasFile, ds); }
function dramaDir(id: string) { return `${DATA_ROOT}/${id}`; }
function datasetDir(id: string, trigger: string) { return `${dramaDir(id)}/datasets/${trigger}`; }

// ---------- 姿势库（可按剧覆盖：数据目录 poses.json） ----------
const DEFAULT_POSES: [string, string][] = [
    ["standing with arms crossed, confident smirk, full body front view", "standing with arms crossed"],
    ["running fast, dynamic side view, leaning forward", "running, side view"],
    ["jumping in the air with one fist raised, action pose", "jumping with a raised fist"],
    ["pointing forward with a big grin, three-quarter view", "pointing forward and grinning"],
    ["holding a smartphone with both hands, looking down at it", "looking at a smartphone"],
    ["thinking pose with hand on chin", "thinking, hand on chin"],
    ["waving hello with one hand, cheerful smile", "waving hello"],
    ["walking calmly, hands in pockets, three-quarter view", "walking with hands in pockets"],
    ["sitting cross-legged on the floor, relaxed", "sitting cross-legged"],
    ["close-up bust portrait, smiling at the camera", "bust portrait, smiling"],
    ["standing at ease, relaxed shoulders, full body", "standing at ease"],
    ["turning to look back over the shoulder, back three-quarter view", "looking back over shoulder"],
];

// ---------- 数据集构建（走网关 /v1/images/edits，固定 seed 可复现） ----------
let building = false;
async function buildDataset(drama: Drama, ch: Char, poses: [string, string][], seedBase: number) {
    const dir = ensureDir(datasetDir(drama.id, ch.trigger));
    // 三视图 caption
    for (const [name, view] of [["00-sheet-front", "front view"], ["01-sheet-side", "side view"], ["02-sheet-back", "back view"]] as const) {
        if (fs.existsSync(`${dir}/${name}.png`) && !fs.existsSync(`${dir}/${name}.txt`)) {
            fs.writeFileSync(`${dir}/${name}.txt`, `${ch.trigger}${ch.desc ? `, ${ch.desc}` : ""}, standing ${view}, plain white background`);
        }
    }
    const front = `${dir}/00-sheet-front.png`;
    if (!fs.existsSync(front)) throw new Error(`角色 ${ch.trigger} 缺少正面裁切（先上传三视图）`);
    const frontBuf = fs.readFileSync(front);
    ch.build = { active: true, done: 0, total: poses.length };
    let err: string | undefined;
    for (let i = 0; i < poses.length; i++) {
        const [pose, cap] = poses[i];
        const name = `${String(10 + i).padStart(2, "0")}-pose`;
        try {
            const form = new FormData();
            form.append("input_reference[]", new Blob([frontBuf], { type: "image/png" }), "front.png");
            form.append("prompt", `Edit the first image: the SAME single character${ch.desc ? ` (${ch.desc})` : ""}. New pose: ${pose}. Keep every facial feature and costume design EXACTLY identical to the reference. Exactly ONE person, never two. 2D anime style, plain white background.`);
            form.append("model", "qwen-edit-plus");
            form.append("seed", String(seedBase + i));
            const res = await fetch(`${GW}/v1/images/edits`, { method: "POST", body: form });
            const body = await res.json() as { data?: { b64_json?: string }[]; error?: { message?: string } };
            const b64 = body?.data?.[0]?.b64_json;
            if (!res.ok || !b64) throw new Error(body?.error?.message || String(res.status));
            fs.writeFileSync(`${dir}/${name}.png`, Buffer.from(b64, "base64"));
            fs.writeFileSync(`${dir}/${name}.txt`, `${ch.trigger}${ch.desc ? `, ${ch.desc}` : ""}, ${cap}, plain white background`);
            ch.build.done++;
        } catch (e) { err = e instanceof Error ? e.message : String(e); break; }
    }
    ch.build.active = false;
    if (err) ch.build.error = err;
    try { await contactSheet(dir, `${dramaDir(drama.id)}/contact-${ch.trigger}.png`); } catch { /* 非致命 */ }
    saveDramas(loadDramas()); // 持久化进度
    return err;
}

async function buildAll(drama: Drama, posesPerChar: number) {
    if (building) throw new Error("已有数据集构建在进行中");
    if (!(await httpOk(`${COMFY}/system_stats`))) throw new Error("ComfyUI 不在线（训练期间停机是预期），等训练结束再建数据集");
    building = true;
    const posesFile = `${dramaDir(drama.id)}/poses.json`;
    const poses = fs.existsSync(posesFile) ? readJson<[string, string][]>(posesFile, DEFAULT_POSES).slice(0, posesPerChar) : DEFAULT_POSES.slice(0, posesPerChar);
    (async () => {
        for (const ch of drama.chars) {
            const err = await buildDataset(drama, ch, poses, 90001);
            if (err) { log(`数据集构建中断 @${ch.trigger}:`, err); break; }
        }
        building = false;
    })();
}

// ---------- 训练编排 ----------
function datasetCount(drama: Drama, ch: Char) {
    const dir = datasetDir(drama.id, ch.trigger);
    try { return fs.readdirSync(dir).filter((f) => f.endsWith(".png")).length; } catch { return 0; }
}

function genTrainConfig(drama: Drama, steps: number) {
    ensureDir(CONFIG_DIR);
    const ds = drama.chars.filter((c) => datasetCount(drama, c) >= 6).map((c) => `        - folder_path: "${datasetDir(drama.id, c.trigger).replace(/\\/g, "/")}"
          caption_ext: "txt"
          caption_dropout_rate: 0.05
          shuffle_tokens: false
          cache_latents_to_disk: true
          cache_text_embeddings: true
          resolution: [ 512 ]`).join("\n");
    if (!ds) throw new Error("没有角色达到最小数据集要求（每个角色 ≥6 张，先建数据集）");
    const name = `${drama.id}_cast_h3_i2v_r32`;
    const yaml = `---
# LoRA Studio 自动生成：${drama.name} 全卡司合训（多触发词）
job: extension
config:
  name: "${name}"
  process:
    - type: 'sd_trainer'
      training_folder: "output"
      device: cuda:0
      network:
        type: "lora"
        linear: 32
        linear_alpha: 32
      save:
        dtype: float16
        save_every: 250
        max_step_saves_to_keep: 4
        push_to_hub: false
      datasets:
${ds}
      train:
        batch_size: 1
        steps: ${steps}
        gradient_accumulation: 1
        train_unet: true
        train_text_encoder: false
        gradient_checkpointing: true
        noise_scheduler: "flowmatch"
        optimizer: "adamw8bit"
        lr: 1e-4
        optimizer_params:
          weight_decay: 1e-4
        ema_config:
          use_ema: true
          ema_decay: 0.99
        dtype: bf16
        disable_sampling: true
      model:
        name_or_path: "C:/AI/ComfyUI-Portable/ComfyUI/models"
        arch: 'minimax_h3'
        quantize: true
        quantize_te: true
        low_vram: true
        model_kwargs:
          partition: "fl2va"
      sample:
        sampler: "flowmatch"
        sample_every: 250
        width: 352
        height: 1024
        num_frames: 1
        prompts:
          - "${drama.chars[0]?.trigger || "character"} standing, 2D anime style"
        neg: ""
        seed: 42
        walk_seed: true
        guidance_scale: 1.0
        sample_steps: 4
meta:
  name: "[name]"
  version: '1.0'
`;
    const cfgPath = `${CONFIG_DIR}/train_${drama.id}.yaml`;
    fs.writeFileSync(cfgPath, yaml);
    return { cfgPath, name };
}

function genTrainScript(drama: Drama, configName: string) {
    const name = configName;
    const loraOut = `${TOOLKIT}/output/${name}/${name}.safetensors`;
    const script = `#!/usr/bin/env bash
# LoRA Studio 自动生成：${drama.name}
set -uo pipefail
export MODELS_PATH='C:\\AI\\ComfyUI-Portable\\ComfyUI\\models'
export HF_ENDPOINT=https://hf-mirror.com
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
CPID=$(netstat -ano | grep "LISTENING" | grep ":8188 " | awk '{print $5}' | head -1)
[ -n "$CPID" ] && taskkill //F //PID "$CPID" >/dev/null 2>&1 && echo "COMFY_STOPPED"
sleep 3
(cd "${TOOLKIT}" && "${TOOLKIT_PY}" run.py "${CONFIG_DIR}/train_${drama.id}.yaml") > "${dramaDir(drama.id)}/train.log" 2>&1
rc=$?
echo "TRAIN_RC=$rc"
if [ $rc -eq 0 ] && [ -f "${loraOut}" ]; then
  mkdir -p "${COMFY_LORAS}"
  cp "${loraOut}" "${COMFY_LORAS}/${drama.id}_cast.safetensors"
  echo "LORA_COPIED"
fi
cmd //c "C:\\work\\BeefTV\\.local\\start-comfy-detached.cmd" >/dev/null 2>&1 || true
sleep 15
echo "TRAIN_DONE"
`;
    const scriptPath = `${dramaDir(drama.id)}/train.sh`;
    fs.writeFileSync(scriptPath, script);
    return { scriptPath, loraOut };
}

async function launchTraining(drama: Drama, steps: number) {
    const tp = await trainingProcessInfo();
    if (tp.running) throw new Error(`已有训练进程在跑（PID ${tp.pids.join(",")}），等它结束`);
    const { cfgPath, name } = genTrainConfig(drama, steps);
    const { scriptPath } = genTrainScript(drama, name);
    drama.training = { status: "running", logPath: `${dramaDir(drama.id)}/train.log`, scriptPath, startedAt: new Date().toISOString(), steps };
    saveDramas(loadDramas());
    const outLog = `${dramaDir(drama.id)}/runner.out.log`;
    const errLog = `${dramaDir(drama.id)}/runner.err.log`;
    await new Promise<void>((resolve, reject) => {
        execFile("powershell", ["-NoProfile", "-Command",
            `Start-Process -FilePath 'C:\\Program Files\\Git\\bin\\bash.exe' -ArgumentList '${scriptPath.replace(/\//g, "\\")}' -WindowStyle Hidden -RedirectStandardOutput '${outLog.replace(/\//g, "\\")}' -RedirectStandardError '${errLog.replace(/\//g, "\\")}'`],
            { shell: false }, (e) => (e ? reject(e) : resolve()));
    });
    return { cfgPath };
}

function parseProgress(drama: Drama) {
    const t = drama.training;
    if (!t?.logPath || !fs.existsSync(t.logPath)) return null;
    const tail = fs.readFileSync(t.logPath, "utf8").slice(-4000).replace(/\r/g, "\n").split("\n").filter(Boolean);
    const stepLine = [...tail].reverse().find((l) => /\d+\/\d+ \[/.test(l)) || "";
    const m = stepLine.match(/(\d+)\/(\d+) \[([\d:]+)<([\d:]+)[^\]]*\]?.*loss: ([\d.e+-]+)/);
    const done = tail.some((l) => l.includes("TRAIN_DONE"));
    const rc = tail.find((l) => l.startsWith("TRAIN_RC="));
    const copied = tail.some((l) => l.includes("LORA_COPIED"));
    // 状态推进
    if (done && t.status === "running") {
        t.status = rc === "TRAIN_RC=0" ? "done" : "failed";
        t.error = t.status === "failed" ? `训练退出码 ${rc?.slice(9)}` : undefined;
        t.loraFile = copied ? `${COMFY_LORAS}/${drama.id}_cast.safetensors` : undefined;
        saveDramas(loadDramas());
    }
    return m ? { step: Number(m[1]), total: Number(m[2]), elapsed: m[3], eta: m[4], loss: m[5], status: t.status } : { status: t.status, done };
}

// ---------- 交付：注册网关路由 ----------
async function deliver(drama: Drama) {
    const lora = `${COMFY_LORAS}/${drama.id}_cast.safetensors`;
    if (!fs.existsSync(lora)) throw new Error(`LoRA 未就绪：${lora}`);
    const src = JSON.parse(fs.readFileSync(`${GATEWAY_DIR}/workflows/hybrid-first-frame.template.json`, "utf8"));
    src["27"] = { class_type: "LoraLoaderModelOnly", inputs: { model: ["2", 0], lora_name: `${drama.id}_cast.safetensors`, strength_model: 0.8 }, _meta: { title: `${drama.name}卡司LoRA` } };
    src["7"].inputs.model = ["27", 0];
    const template = `workflows/hybrid-${drama.id}.template.json`;
    fs.writeFileSync(`${GATEWAY_DIR}/${template}`, JSON.stringify(src, null, 2));
    const cfg = JSON.parse(fs.readFileSync(`${GATEWAY_DIR}/config.json`, "utf8"));
    const route = `h3-${drama.id}`;
    cfg.modelWorkflows[route] = template;
    fs.writeFileSync(`${GATEWAY_DIR}/config.json`, JSON.stringify(cfg, null, 2));
    await killPort(8765); await new Promise((r) => setTimeout(r, 2000));
    const outLog = `${dramaDir(drama.id)}/gw.out.log`, errLog = `${dramaDir(drama.id)}/gw.err.log`;
    await new Promise<void>((resolve) => {
        execFile("powershell", ["-NoProfile", "-Command",
            `Start-Process -FilePath 'C:\\Users\\ksa\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Oven-sh.Bun_Microsoft.Winget.Source_8wekyb3d8bbwe\\bun-windows-x64\\bun.exe' -ArgumentList 'gateway.ts' -WorkingDirectory '${GATEWAY_DIR.replace(/\//g, "\\")}' -WindowStyle Hidden -RedirectStandardOutput '${outLog.replace(/\//g, "\\")}' -RedirectStandardError '${errLog.replace(/\//g, "\\")}'`],
            { shell: false }, () => resolve());
    });
    await new Promise((r) => setTimeout(r, 3000));
    const up = await httpOk(`${GW}/v1/models`);
    drama.delivered = { route, template, loraCopied: true };
    saveDramas(loadDramas());
    return { route, gatewayUp: up };
}

// ---------- 验收：A/B 2s 短片 ----------
async function validate(drama: Drama, trigger: string) {
    const route = drama.delivered?.route;
    if (!route) throw new Error("先执行交付（注册网关路由）");
    const ch = drama.chars.find((c) => c.trigger === trigger);
    if (!ch) throw new Error("角色不存在");
    const prompt = `2D anime style. ${ch.trigger}${ch.desc ? `, ${ch.desc}` : ""}, standing on a city street at sunset, waving at the camera, smiling.`;
    const outDir = ensureDir(`${dramaDir(drama.id)}/validation`);
    const results: string[] = [];
    for (const model of [route, "h3-hybrid"]) {
        const form = new FormData();
        form.append("model", model); form.append("prompt", prompt);
        form.append("seconds", "2"); form.append("size", "832x480"); form.append("seed", "777");
        const res = await fetch(`${GW}/v1/videos`, { method: "POST", body: form });
        const body = await res.json() as { id?: string };
        if (!body.id) throw new Error(`提交失败: ${JSON.stringify(body).slice(0, 150)}`);
        for (;;) {
            await new Promise((r) => setTimeout(r, 5000));
            const st = await (await fetch(`${GW}/v1/videos/${body.id}`)).json() as { status?: string; error?: string };
            if (st.status === "completed" || st.status === "succeeded") {
                const buf = Buffer.from(await (await fetch(`${GW}/v1/videos/${body.id}/content`)).arrayBuffer());
                const f = `${outDir}/${trigger}-${model === route ? "lora" : "base"}.mp4`;
                fs.writeFileSync(f, buf); results.push(f); break;
            }
            if (st.status === "failed") throw new Error(`${model} 生成失败: ${String(st.error || "").slice(0, 120)}`);
        }
    }
    return { files: results };
}

// ---------- HTTP 服务 ----------
const routes: { method: string; pattern: RegExp; handler: (m: RegExpMatchArray, req: Request, url: URL) => Promise<Response> }[] = [];
function route(method: string, pattern: string, handler: (m: RegExpMatchArray, req: Request, url: URL) => Promise<Response>) {
    routes.push({ method, pattern: new RegExp(`^${pattern.replace(/:id/g, "(?<id>[^/]+)").replace(/:trigger/g, "(?<trigger>[^/]+)")}$`), handler });
}

route("GET", "/api/overview", async () => {
    const [comfy, gw, gpu, tp] = await Promise.all([httpOk(`${COMFY}/system_stats`), httpOk(`${GW}/v1/models`), gpuUsed(), trainingProcessInfo()]);
    const dramas = loadDramas().map((d) => ({
        ...d,
        chars: d.chars.map((c) => {
            const dir = datasetDir(d.id, c.trigger);
            let files: string[] = [];
            try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".png")); } catch { }
            return { ...c, datasetCount: files.length, files: files.slice(0, 24) };
        }),
    }));
    return ok({ dramas, env: { comfyOnline: comfy, gatewayOnline: gw, gpu, trainingProcess: tp, building } });
});
route("POST", "/api/dramas", async (_m, req) => {
    const { name } = await req.json() as { name?: string };
    if (!name?.trim()) return fail(400, "剧名不能为空");
    const id = name.trim().toLowerCase().replace(/[^a-z0-9-]/g, "") || randomUUID().slice(0, 8);
    const ds = loadDramas();
    if (ds.some((d) => d.id === id)) return fail(409, `剧 ${id} 已存在`);
    ds.push({ id, name: name.trim(), createdAt: new Date().toISOString(), chars: [] });
    saveDramas(ds); ensureDir(dramaDir(id));
    return ok({ drama: ds.at(-1) });
});
route("DELETE", "/api/dramas/:id", async (m) => {
    const ds = loadDramas();
    const rest = ds.filter((x) => x.id !== m.groups!.id);
    if (rest.length === ds.length) return fail(404, "剧不存在");
    saveDramas(rest);
    fs.rmSync(dramaDir(m.groups!.id), { recursive: true, force: true });
    return ok({});
});
route("POST", "/api/dramas/:id/chars", async (m, req) => {
    const ds = loadDramas(); const d = ds.find((x) => x.id === m.groups!.id);
    if (!d) return fail(404, "剧不存在");
    const { trigger, displayName, desc } = await req.json() as { trigger?: string; displayName?: string; desc?: string };
    if (!trigger?.trim() || !/^[a-z][a-z0-9_]*$/.test(trigger.trim())) return fail(400, "触发词必须是纯小写字母数字（提示词用）");
    if (d.chars.some((c) => c.trigger === trigger.trim())) return fail(409, "触发词已存在");
    d.chars.push({ trigger: trigger.trim(), displayName: displayName || trigger.trim(), desc: desc?.trim() || undefined });
    saveDramas(ds);
    return ok({ chars: d.chars });
});
route("POST", "/api/dramas/:id/chars/:trigger/sheet", async (m, req) => {
    const ds = loadDramas(); const d = ds.find((x) => x.id === m.groups!.id);
    if (!d) return fail(404, "剧不存在");
    const ch = d.chars.find((c) => c.trigger === m.groups!.trigger);
    if (!ch) return fail(404, "角色不存在");
    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return fail(400, "缺少 file 字段");
    const dir = ensureDir(dramaDir(d.id));
    const sheet = `${dir}/${ch.trigger}-sheet${path.extname(file.name) || ".png"}`;
    fs.writeFileSync(sheet, Buffer.from(await file.arrayBuffer()));
    try { await cropSheet(sheet, ensureDir(datasetDir(d.id, ch.trigger))); } catch (e) { return fail(500, `裁切失败（需为标准三视图）：${e instanceof Error ? e.message : e}`); }
    ch.sheetFile = path.basename(sheet); ch.build = undefined;
    saveDramas(ds);
    return ok({ sheet: ch.sheetFile, datasetCount: datasetCount(d, ch) });
});
route("DELETE", "/api/dramas/:id/chars/:trigger", async (m) => {
    const ds = loadDramas(); const d = ds.find((x) => x.id === m.groups!.id);
    if (!d) return fail(404, "剧不存在");
    d.chars = d.chars.filter((c) => c.trigger !== m.groups!.trigger);
    saveDramas(ds);
    return ok({});
});
route("POST", "/api/dramas/:id/build", async (m, req) => {
    const ds = loadDramas(); const d = ds.find((x) => x.id === m.groups!.id);
    if (!d) return fail(404, "剧不存在");
    const { posesPerChar = 12 } = await req.json().catch(() => ({}) as { posesPerChar?: number });
    if (!d.chars.length) return fail(400, "先添加角色");
    try { await buildAll(d, Math.min(20, Math.max(4, posesPerChar))); } catch (e) { return fail(409, e instanceof Error ? e.message : String(e)); }
    return ok({ started: true });
});
route("DELETE", "/api/dramas/:id/images/:trigger/:file", async (m) => {
    const dir = datasetDir(m.groups!.id, m.groups!.trigger);
    const f = path.basename(m.groups!.file);
    for (const p of [`${dir}/${f}`, `${dir}/${f.replace(/\.png$/, ".txt")}`]) { if (fs.existsSync(p)) fs.unlinkSync(p); }
    try { await contactSheet(dir, `${dramaDir(m.groups!.id)}/contact-${m.groups!.trigger}.png`); } catch { }
    return ok({});
});
route("GET", "/api/dramas/:id/progress", async (m) => {
    const d = loadDramas().find((x) => x.id === m.groups!.id);
    if (!d) return fail(404, "剧不存在");
    return ok({ training: d.training, progress: parseProgress(d) });
});
route("POST", "/api/dramas/:id/train", async (m, req) => {
    const ds = loadDramas(); const d = ds.find((x) => x.id === m.groups!.id);
    if (!d) return fail(404, "剧不存在");
    const { steps = 1000 } = await req.json().catch(() => ({}) as { steps?: number });
    try { const r = await launchTraining(d, Math.min(3000, Math.max(200, steps))); return ok(r); } catch (e) { return fail(409, e instanceof Error ? e.message : String(e)); }
});
route("POST", "/api/dramas/:id/deliver", async (m) => {
    const ds = loadDramas(); const d = ds.find((x) => x.id === m.groups!.id);
    if (!d) return fail(404, "剧不存在");
    try { return ok(await deliver(d)); } catch (e) { return fail(409, e instanceof Error ? e.message : String(e)); }
});
route("POST", "/api/dramas/:id/validate", async (m, req) => {
    const ds = loadDramas(); const d = ds.find((x) => x.id === m.groups!.id);
    if (!d) return fail(404, "剧不存在");
    const { trigger } = await req.json() as { trigger?: string };
    if (!trigger) return fail(400, "指定角色 trigger");
    try { return ok(await validate(d, trigger)); } catch (e) { return fail(409, e instanceof Error ? e.message : String(e)); }
});
// 媒体：数据集图片 / 对照表 / 验收视频
route("GET", "/media/:id/:rest", async (m) => {
    const p = path.join(dramaDir(m.groups!.id), decodeURIComponent(m.groups!.rest)).replace(/\.\./g, "");
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return fail(404, "文件不存在");
    const type = p.endsWith(".png") ? "image/png" : p.endsWith(".mp4") ? "video/mp4" : "application/octet-stream";
    return new Response(fs.readFileSync(p), { headers: { "content-type": type } });
});

Bun.serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/" || url.pathname === "/index.html") {
            return new Response(fs.readFileSync(`${STUDIO_DIR}/public/index.html`, "utf8"), { headers: { "content-type": "text/html; charset=utf-8" } });
        }
        for (const r of routes) {
            if (req.method !== r.method) continue;
            const m = url.pathname.match(r.pattern);
            if (m) {
                try { return await r.handler(m, req, url); }
                catch (e) { log("ERR", url.pathname, e); return fail(500, e instanceof Error ? e.message : String(e)); }
            }
        }
        return fail(404, "未知接口");
    },
});
log(`LoRA Studio http://127.0.0.1:${PORT}`);
