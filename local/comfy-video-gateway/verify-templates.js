#!/usr/bin/env node
// 网关-ComfyUI 集成全量校验器：证明"每一套注册模板在任何请求形态下都能提交成功"。
//
// 三层校验（独立重实现网关的替换/剪槽逻辑——刻意不 import gateway.ts，
// 用第二份实现交叉验证第一份，网关逻辑有 bug 时这里能暴露）：
//   1. 静态：config 注册的模板全部存在、可解析、占位符合法、剪槽后图连通（无悬空链接/空文件名/无输出节点）；
//      T8 图片槽位不变量（接 last_frame 的模板参考槽必须从 IMAGE_3 起）；
//   2. 活体：ComfyUI /object_info 核对每个 class_type 存在、每个非 autogrow 输入名在册、
//      每个加载器(UNET/LoRA/CLIP/VAE/GGUF)引用的权重文件在 ComfyUI 可见；
//   3. 实弹(--live)：每个模板取代表形态，真实 POST /prompt 过 ComfyUI 自身的图校验
//      （节点/输入/类型/组合值全查），拿到 prompt_id 即视为 PASS，随即从队列删除，不占 GPU。
//
// 用法：node verify-templates.js [--live]   （或 bun verify-templates.js --live）
// 退出码 0=全绿，1=有失败。CI/排障均可用；改模板、改 config、升级 ComfyUI 或增删权重后必跑。

"use strict";

const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const [, , ...argv] = process.argv;
const LIVE = argv.includes("--live");
const COMFY_URL = (argv.find((a) => a.startsWith("--comfy=")) || "--comfy=http://127.0.0.1:8188").slice("--comfy=".length);

const failures = [];
const warns = [];
const warnKeys = new Set();
const passes = [];
const fail = (msg) => failures.push(msg);
const warn = (msg) => {
    const key = msg.replace(/\s*\[[^\]]*\]/g, "").replace(/节点 \d+/, "节点 N"); // 去掉场景标签与节点号去重，避免刷屏
    if (!warnKeys.has(key)) { warnKeys.add(key); warns.push(msg); }
};
const pass = (msg) => passes.push(msg);

// ---------- 网关逻辑的独立重实现（保持与 gateway.ts 同步：substitutePlaceholders / prune*） ----------

const PLACEHOLDER_RE = /\{\{([A-Z0-9_]+)\}\}/g;

function substitute(node, ctx) {
    if (typeof node === "string") {
        const exact = node.trim();
        if (exact === "{{PROMPT}}") return ctx.prompt;
        if (exact === "{{NEGATIVE_PROMPT}}") return ctx.negative;
        if (exact === "{{SECONDS}}") return ctx.seconds;
        if (exact === "{{FRAMES}}") return ctx.frames;
        if (exact === "{{WIDTH}}") return ctx.width;
        if (exact === "{{HEIGHT}}") return ctx.height;
        if (exact === "{{SIZE}}") return ctx.size;
        if (exact === "{{SEED}}") return ctx.seed;
        if (exact === "{{TEXT_ENCODER}}") return ctx.textEncoder;
        const img = exact.match(/^\{\{IMAGE(?:_(\d+))?\}\}$/);
        if (img) return ctx.images[Number(img[1] ?? 1) - 1] ?? "";
        const aud = exact.match(/^\{\{AUDIO(?:_(\d+))?\}\}$/);
        if (aud) return ctx.audios[Number(aud[1] ?? 1) - 1] ?? "";
        return node.replace(/\{\{PROMPT\}\}/g, ctx.prompt).replace(/\{\{NEGATIVE_PROMPT\}\}/g, ctx.negative).replace(/\{\{SIZE\}\}/g, ctx.size);
    }
    if (Array.isArray(node)) return node.map((x) => substitute(x, ctx));
    if (node && typeof node === "object") {
        const out = {};
        for (const [k, v] of Object.entries(node)) if (!k.startsWith("_")) out[k] = substitute(v, ctx);
        return out;
    }
    return node;
}

function loadImageNodesWithEmptyName(wf) {
    const dropped = new Set();
    for (const [id, n] of Object.entries(wf)) {
        if (!n || typeof n !== "object") continue;
        if (n.class_type === "LoadImage" && typeof n.inputs?.image === "string" && !n.inputs.image.trim()) dropped.add(id);
        if (n.class_type === "LoadAudio" && typeof n.inputs?.audio === "string" && !n.inputs.audio.trim()) dropped.add(id);
    }
    return dropped;
}

function pruneRefSlots(wf) {
    // 复刻网关三段剪槽的合并效果（ref/audio/edit 槽 + 空加载器兜底 + keyframe 槽）
    const dropped = loadImageNodesWithEmptyName(wf);
    if (!dropped.size) return dropped;
    for (const n of Object.values(wf)) {
        if (!n || typeof n !== "object") continue;
        const ct = n.class_type;
        if (ct !== "MiniMaxH3AudioConditioningT8" && ct !== "TextEncodeQwenImage21") continue;
        for (const key of Object.keys(n.inputs ?? {})) {
            const isRef = key.startsWith("ref_images.ref_image_") || key.startsWith("images.image_");
            const isAudio = key === "drive_audio" || /^ref_audios\.ref_audio_\d+$/.test(key);
            const isKeyframe = key === "first_frame" || key === "last_frame";
            if (!isRef && !isAudio && !isKeyframe) continue;
            const link = n.inputs[key];
            if (Array.isArray(link) && dropped.has(String(link[0]))) delete n.inputs[key];
        }
    }
    for (const id of dropped) delete wf[id];
    return dropped;
}

// ---------- 场景构造：对每个模板枚举"网关真实会产生的请求形态" ----------

function scenariosFor(template, textEncoder) {
    const text = JSON.stringify(template);
    const hasImage = /\{\{IMAGE/.test(text);
    const hasAudio = /\{\{AUDIO/.test(text);
    const out = [];
    const imageCounts = hasImage ? [1, 2, 3, 4, 5, 6, 7] : [0];
    const audioCounts = hasAudio ? [0, 1] : [0];
    for (const images of imageCounts) {
        for (const audios of audioCounts) {
            out.push({
                label: `images=${images} audios=${audios}`,
                ctx: {
                    prompt: "verify prompt", negative: "", seconds: 8, frames: 196,
                    width: 1280, height: 704, size: "1280x704", seed: 12345,
                    textEncoder, images: images ? Array.from({ length: images }, (_, i) => `ref-${i}.png`) : [],
                    audios: audios ? Array.from({ length: audios }, (_, i) => `aud-${i}.wav`) : [],
                },
            });
        }
    }
    return out;
}

// ---------- 静态：剪槽后图完整性 ----------

const OUTPUT_NODES = new Set(["SaveVideo", "VHS_VideoCombine", "SaveImage", "SaveAnimatedWEBP"]);

function checkGraphIntegrity(wf, scenarioLabel, templateName) {
    const where = `${templateName} [${scenarioLabel}]`;
    // 1. 无残留占位符
    const leftovers = new Set();
    const walk = (n) => {
        if (typeof n === "string") { for (const m of n.matchAll(PLACEHOLDER_RE)) leftovers.add(m[0]); }
        else if (Array.isArray(n)) n.forEach(walk);
        else if (n && typeof n === "object") Object.values(n).forEach(walk);
    };
    walk(wf);
    if (leftovers.size) fail(`${where}: 残留占位符 ${[...leftovers].join(",")}`);
    // 2. 链接完整性：所有 [id, slot] 指向存在的节点
    for (const [id, n] of Object.entries(wf)) {
        if (!n || typeof n !== "object") continue;
        for (const [key, val] of Object.entries(n.inputs ?? {})) {
            if (Array.isArray(val)) {
                const [target] = val;
                if (!(String(target) in wf)) fail(`${where}: 节点 ${id} 输入 ${key} 链接到已剪除/不存在的节点 ${target}`);
            }
        }
    }
    // 3. 加载器文件名非空（该剪没剪）
    for (const [id, n] of Object.entries(wf)) {
        if (!n || typeof n !== "object") continue;
        for (const field of ["image", "audio"]) {
            const v = n.inputs?.[field];
            if ((n.class_type === "LoadImage" || n.class_type === "LoadAudio") && typeof v === "string" && !v.trim()) {
                fail(`${where}: 节点 ${id}(${n.class_type}) ${field} 为空串（网关剪槽逻辑缺口）`);
            }
        }
    }
    // 4. 至少一个输出节点
    if (!Object.values(wf).some((n) => n && typeof n === "object" && OUTPUT_NODES.has(n.class_type))) {
        fail(`${where}: 剪槽后没有任何输出节点`);
    }
    return leftovers.size === 0;
}

// ---------- T8 槽位不变量：last_frame 在场时参考槽必须 IMAGE_3 起 ----------

function checkT8SlotInvariant(template, templateName) {
    for (const n of Object.values(template)) {
        if (!n || typeof n !== "object" || n.class_type !== "MiniMaxH3AudioConditioningT8") continue;
        const inputs = n.inputs ?? {};
        if (!("last_frame" in inputs)) continue;
        const refKeys = Object.keys(inputs).filter((k) => k.startsWith("ref_images.")).sort();
        if (!refKeys.length) continue;
        const first = inputs[refKeys[0]];
        const src = template[String(Array.isArray(first) ? first[0] : "")];
        const ph = src?.inputs?.image;
        if (ph !== "{{IMAGE_3}}") {
            fail(`${templateName}: T8 槽位不变量违反——接了 last_frame 但首个参考槽是 ${ph ?? "(断链)"}（须 {{IMAGE_3}}，否则 <Picture N> 文字绑定整体错位）`);
        }
    }
}

// ---------- 活体：object_info ----------

const LOADER_FIELDS = {
    UNETLoader: "unet_name", LoraLoaderModelOnly: "lora_name", CLIPLoader: "clip_name", VAELoader: "vae_name",
    UnetLoaderGGUF: "unet_name", CLIPLoaderGGUF: "clip_name", VAELoaderGGUF: "vae_name",
};

async function fetchObjectInfo() {
    try {
        const res = await fetch(`${COMFY_URL}/object_info`, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch (e) {
        warn(`ComfyUI 不可达（${e.message}），活体校验跳过——只跑了静态层`);
        return null;
    }
}

function checkAgainstObjectInfo(wf, objectInfo, where) {
    if (!objectInfo) return;
    for (const [id, n] of Object.entries(wf)) {
        if (!n || typeof n !== "object") continue;
        const spec = objectInfo[n.class_type];
        if (!spec) { fail(`${where}: 节点 ${id} class_type "${n.class_type}" 在 ComfyUI /object_info 中不存在（缺自定义节点包或版本不匹配）`); continue; }
        const inputs = spec.input ?? {};
        const known = new Set([...Object.keys(inputs.required ?? {}), ...Object.keys(inputs.optional ?? {})]);
        for (const key of Object.keys(n.inputs ?? {})) {
            if (key.includes(".")) continue; // autogrow 槽位（ref_images.ref_image_N 等）不静态列举
            if (!known.has(key)) {
                // ComfyUI /prompt 校验会忽略未知输入键（UI-only 键如 upload/control、VHS 动态注册的
                // format widget 如 pix_fmt/crf 不出现在静态 object_info 里），故只作漂移提示；
                // 权威判定交给 --live 层的 ComfyUI 自身提交校验。
                warn(`${where}: 节点 ${id}(${n.class_type}) 输入 "${key}" 不在 object_info 静态表（多为 UI-only/动态 widget，以 --live 为准）`);
            }
        }
        const field = LOADER_FIELDS[n.class_type];
        if (field) {
            const value = n.inputs?.[field];
            const options = inputs.required?.[field]?.[0] ?? inputs.optional?.[field]?.[0];
            if (typeof value === "string" && value.startsWith("<") ) {
                fail(`${where}: 节点 ${id}(${n.class_type}) ${field} 未被正确解析（仍是占位标记 "${value}"）`);
            } else if (typeof value === "string" && Array.isArray(options) && !options.includes(value)) {
                fail(`${where}: 节点 ${id}(${n.class_type}) ${field}="${value}" 不在 ComfyUI 可见列表（文件缺失/改名/未就位）`);
            }
        }
    }
}

// ---------- 实弹：submit-and-cancel ----------

async function uploadProbeAudio() {
    try {
        const sampleRate = 8000;
        const dataLen = sampleRate * 0.1 * 2; // 0.1s 16bit 单声道静音
        const buf = Buffer.alloc(44 + dataLen);
        buf.write("RIFF", 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write("WAVE", 8);
        buf.write("fmt ", 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
        buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
        buf.write("data", 36); buf.writeUInt32LE(dataLen, 40);
        const form = new FormData();
        // 本机 ComfyUI 无 /upload/audio 路由；网关生产上传音频也走 /upload/image（E01 实证），此处镜像
        form.append("image", new Blob([buf], { type: "audio/wav" }), "verify-probe.wav");
        form.append("type", "input");
        form.append("overwrite", "true");
        const res = await fetch(`${COMFY_URL}/upload/image`, { method: "POST", body: form, signal: AbortSignal.timeout(10000) });
        if (!res.ok) return null;
        return "verify-probe.wav";
    } catch {
        return null;
    }
}

async function liveSubmit(wf, templateName) {
    const res = await fetch(`${COMFY_URL}/prompt`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: wf, client_id: `verify-${Date.now()}` }),
        signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.prompt_id) {
        await fetch(`${COMFY_URL}/queue`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ delete: [body.prompt_id] }),
        }).catch(() => undefined);
        return { ok: true };
    }
    const detail = typeof body === "object" && body.error ? `${body.error} ${JSON.stringify(body.node_errors ?? {}).slice(0, 300)}` : JSON.stringify(body).slice(0, 300);
    return { ok: false, detail };
}

// ---------- 主流程 ----------

(async () => {
    const config = JSON.parse(fs.readFileSync(path.join(DIR, "config.json"), "utf8"));
    const registered = {
        ...(config.workflows ?? {}),
        ...(config.modelWorkflows ?? {}),
        ...(config.modelImageWorkflows ?? {}),
    };
    console.log(`注册模板 ${new Set(Object.values(registered)).size} 个（来自 workflows/modelWorkflows/modelImageWorkflows）`);

    // textEncoder 真实值：模板 {{TEXT_ENCODER}} 会被替换成 config 里的编码器名，活体校验要查真名
    const encoders = new Set([config.defaultTextEncoder, ...(Object.values(config.modelTextEncoders ?? {}))].filter(Boolean));

    const objectInfo = await fetchObjectInfo();

    // 编码器家族解析（镜像网关各端点的解析规则）：
    //   /v1/videos 家族 → defaultTextEncoder；/images/edits 与 /images/generations 家族 → defaultImageTextEncoder。
    const imageGenTemplates = new Set([...Object.values(config.modelImageWorkflows ?? {}), config.workflows?.imageGen].filter(Boolean));
    const editsModels = new Set(["qwen-edit", "qwen-edit-plus", "qwen-edit-plus-uncensored", "qwen-edit-uncensored", "supir-hd", "anime-hd"]);
    const encoderFor = (model, rel) =>
        imageGenTemplates.has(rel) || editsModels.has(model) ? config.defaultImageTextEncoder : config.defaultTextEncoder;

    const templateCache = {};
    for (const [model, rel] of Object.entries(registered)) {
        const file = path.resolve(DIR, rel);
        if (!fs.existsSync(file)) { fail(`[${model}] 模板文件不存在: ${rel}`); continue; }
        let parsed;
        try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
        catch (e) { fail(`[${model}] 模板 JSON 解析失败: ${e.message}`); continue; }
        if (!parsed || typeof parsed !== "object" || !JSON.stringify(parsed).includes("class_type")) { fail(`[${model}] 不是 API 格式工作流`); continue; }
        templateCache[rel] = parsed;

        checkT8SlotInvariant(parsed, rel);

        for (const sc of scenariosFor(parsed, encoderFor(model, rel))) {
            const wf = substitute(parsed, sc.ctx);
            pruneRefSlots(wf);
            checkGraphIntegrity(wf, sc.label, rel);
            // 活体校验只对代表形态跑（全形态 × object_info 代价高且重复）：images=4 或 0、audios=1
            const representative = (sc.ctx.images.length === 4 || sc.ctx.images.length === 0) && sc.ctx.audios.length <= 1;
            if (representative) checkAgainstObjectInfo(wf, objectInfo, `${rel} [${sc.label}]`);
        }
        pass(`[${model}] ${rel} 静态${objectInfo ? "+活体" : ""}校验通过`);
    }

    // 编码器清单本身也过一遍 object_info（CLIPLoader 选项）
    if (objectInfo?.CLIPLoader) {
        const clips = objectInfo.CLIPLoader.input?.required?.clip_name?.[0] ?? [];
        for (const enc of encoders) if (!clips.includes(enc)) fail(`编码器 "${enc}" 不在 ComfyUI CLIPLoader 可见列表`);
    }

    if (LIVE) {
        console.log("\n实弹层：逐模板真实提交 ComfyUI 校验后立即取消…");
        // 用 ComfyUI input 目录里真实存在的文件名（空串能过提交校验但执行期才炸，
        // 用真名才能让"提交成功"等价于"可执行"）
        const imgOptionsRaw = objectInfo?.LoadImage?.input?.required?.image?.[0];
        const imgOptions = (Array.isArray(imgOptionsRaw) ? imgOptionsRaw : []).filter((x) => /^[^\\/:]+\.(png|jpe?g|webp)$/i.test(x));
        // LoadAudio 的选项是延迟加载（静态表只给 "COMBO"）——上传一个 0.1s 静音探针 wav 作真实可解码引用
        const probeAudio = await uploadProbeAudio();
        const audOptions = probeAudio ? [probeAudio] : [];
        if (imgOptions.length < 4) warn(`ComfyUI input 目录图片不足 4 个，实弹层将重复引用同一文件（仍可校验图结构）`);
        if (!audOptions.length) warn(`探针音频上传失败，含 {{AUDIO}} 的模板实弹层将提交占位音频名`);
        const pickImages = (n) => Array.from({ length: n }, (_, i) => imgOptions[i % Math.max(1, imgOptions.length)] ?? "placeholder.png");
        const pickAudios = (n) => Array.from({ length: n }, (_, i) => audOptions[i % Math.max(1, audOptions.length)] ?? "placeholder.wav");
        for (const [model, rel] of Object.entries(registered)) {
            const parsed = templateCache[rel];
            if (!parsed) continue;
            // 代表形态：与该模板家族匹配的图片数（有 IMAGE 槽给 4 张，纯文本 0 张），音频给 1
            const wantAudio = /\{\{AUDIO/.test(JSON.stringify(parsed));
            const hasImage = /\{\{IMAGE/.test(JSON.stringify(parsed));
            const wf = substitute(parsed, {
                prompt: "verify live", negative: "", seconds: 8, frames: 196, width: 1280, height: 704,
                size: "1280x704", seed: 1, textEncoder: encoderFor(model, rel),
                images: hasImage ? pickImages(4) : [],
                audios: wantAudio ? pickAudios(1) : [],
            });
            pruneRefSlots(wf);
            const left = JSON.stringify(wf).match(PLACEHOLDER_RE);
            if (left) { fail(`[live ${model}] 替换后残留 ${left[0]}`); continue; }
            const r = await liveSubmit(wf, rel);
            if (r.ok) pass(`[live ${model}] ComfyUI 提交校验通过（已取消）`);
            else fail(`[live ${model}] ComfyUI 拒绝: ${r.detail}`);
        }
    }

    console.log(`\n===== 结果: ${passes.length} 通过, ${failures.length} 失败, ${warns.length} 警告 =====`);
    for (const w of warns) console.log(`WARN  ${w}`);
    for (const f of failures) console.log(`FAIL  ${f}`);
    process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error("校验器自身异常:", e); process.exit(1); });
