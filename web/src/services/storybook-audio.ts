import { audioMimeType } from "@/lib/audio-generation";
import { probeMediaDurationMs } from "@/lib/media-metadata";
import { fetchChannelVoices, requestAudioGeneration } from "@/services/api/audio";
import { resourceFileUrl, resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import { type AiConfig } from "@/stores/use-config-store";

// 绘本配音：逐行（旁白/对白）TTS 合成 + 落库 + 时长/textHash 记录。
// 渠道无关：本地声线工坊（voiceforge，OpenAI /audio/speech 协议，免密钥）与远程音频渠道同一条路。

export type StorybookLineAudio = {
    storageKey: string;
    url: string;
    durationMs: number;
    textHash: string;
    mimeType?: string;
    bytes?: number;
};

export type StorybookVoice = { voice: string; instructions?: string };

/** 行指纹：文字或期望音色变化都会使已存配音过期（提示重配） */
export function storybookLineHash(text: string, voice?: string): string {
    const key = voice ? `${text}@${voice}` : text;
    let h = 5381;
    for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) >>> 0;
    return h.toString(16);
}

function audioModelId(model: string) {
    const trimmed = model.trim();
    const separator = trimmed.lastIndexOf("::");
    return (separator >= 0 ? trimmed.slice(separator + 2) : trimmed).toLowerCase();
}

/** 声线工坊（本地 voiceforge）：voice 是基底、instructions 承载声线描述（与 .local 配音脚本同款） */
export function isVoiceforgeModel(model: string) {
    return audioModelId(model).includes("voiceforge");
}

/**
 * 声线工坊预置音色（GET /v1/voices）：描述固化的音色名，每次合成听感一致。
 * 未列入的 voice 名（如 openai 的 alloy）会走"按描述即时生成"，音色逐次漂移，不可用。
 * 浏览器直连本机服务会被 CORS 拦截，走渠道 transport（本地后端中转），与 TTS 合成同通道；
 * 中转白名单未放行 /voices 时调用方回落到 FALLBACK 建议列表（允许手动输入任意音色名）。
 */
export const VOICEFORGE_FALLBACK_VOICES = ["_sys_中文男", "ameng", "lingzong", "guanyin-desc", "wukong-desc", "bajie-desc", "shaseng-desc", "tangseng-desc", "bailongma-desc"];

export async function fetchVoiceforgeVoices(config: AiConfig): Promise<string[]> {
    return fetchChannelVoices(config);
}

/**
 * 合成一行配音。voice 决定音色；本地 voiceforge 走 wav（上传/试听/ffmpeg 全兼容）。
 * voiceforge 会把较长的 instructions 当文本朗读（实测 28 字指令使时长 +31%），因此不传；
 * durationMs 来自上传时的音频元数据探测，失败时二次探测，仍失败返回 0（视频导出按无音频页兜底）。
 */
export async function synthesizeStorybookLine(opts: {
    config: AiConfig;
    model: string;
    text: string;
    voice: StorybookVoice;
    speed?: string;
    signal?: AbortSignal;
}): Promise<StorybookLineAudio> {
    const { config, model, text, voice, speed, signal } = opts;
    if (!text.trim()) throw new Error("台词为空");
    const voiceforge = isVoiceforgeModel(model);
    const format = voiceforge ? "wav" : undefined;
    const overrides: Partial<AiConfig> = {
        model,
        audioVoice: voice.voice || "alloy",
        audioInstructions: voiceforge ? "" : (voice.instructions ?? ""),
        ...(speed ? { audioSpeed: speed } : {}),
        ...(format ? { audioFormat: format } : {}),
    };
    const blob = await requestAudioGeneration({ ...config, ...overrides }, text, { signal });
    // 服务端资源库持久化:resource:{id} 任何浏览器可取(试听/导出),不再依赖单浏览器 IndexedDB
    const audioBlob = blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: audioMimeType(format ?? "wav") });
    let durationMs = 0;
    try {
        durationMs = (await probeMediaDurationMs(new File([audioBlob], "line", { type: audioBlob.type }))) ?? 0;
    } catch { /* 探测失败按 0,上传后再由资源元数据兜底 */ }
    const resource = await uploadResourceFile(audioBlob, "audio", {
        fileName: `storybook-line.${format ?? "wav"}`,
        ...(durationMs > 0 ? { durationMs } : {}),
    });
    const finalDurationMs = durationMs > 0 ? durationMs : (resource.durationMs ?? 0);
    return {
        storageKey: resourceStorageKey(resource.id),
        url: resource.publicUrl || resourceFileUrl(resource.id),
        durationMs: finalDurationMs,
        textHash: storybookLineHash(text, voice.voice),
        mimeType: resource.mimeType || audioBlob.type,
        bytes: resource.size,
    };
}

export type StorybookAudioModelOption = { value: string; label: string; local: boolean };

/**
 * 绘本可选音频模型：音频协议渠道 + 名称含 TTS 语义的模型 + 本机服务渠道全量（voiceforge 等）。
 * 注意不能沿用漫画拆书器那种"过滤 localhost"的逻辑——本地渠道正是绘本配音的首选。
 */
export function storybookAudioModelOptions(config: AiConfig): StorybookAudioModelOption[] {
    const options: StorybookAudioModelOption[] = [];
    for (const channel of config.channels ?? []) {
        if (!channel.baseUrl) continue;
        const local = /127\.0\.0\.1|localhost|::1/i.test(channel.baseUrl);
        const channelAudio = /audio/i.test(channel.interfaceType || "");
        for (const m of channel.models ?? []) {
            const audioish = /voiceforge|speech|tts|voice|minimax-t2a|audio/i.test(m);
            if (!channelAudio && !audioish && !local) continue;
            options.push({ value: `${channel.id}::${m}`, label: `${m}（${channel.name}${local ? " · 本机" : ""}）`, local });
        }
    }
    // 本机渠道排前（零成本），voiceforge 优先中的优先
    return options.sort((a, b) => Number(b.local) - Number(a.local) || (Number(isVoiceforgeModel(b.value)) - Number(isVoiceforgeModel(a.value))));
}

export function defaultStorybookAudioModel(config: AiConfig, options: StorybookAudioModelOption[]): string {
    if (isVoiceforgeModel(config.audioModel ?? "")) return config.audioModel as string;
    return options.find((o) => isVoiceforgeModel(o.value))?.value
        ?? options.find((o) => o.value === config.audioModel)?.value
        ?? options[0]?.value
        ?? "";
}
