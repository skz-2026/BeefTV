import { useEffect, useMemo, useState, type ReactNode } from "react";

import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { audioPitchLabel, audioSpeedLabel, audioSpeechProfile, audioVolumeLabel, normalizeAudioFormatValue, normalizeAudioPitchValue, normalizeAudioSpeedValue, normalizeAudioVolumeValue, normalizeAudioVoiceValue } from "@/lib/audio-generation";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { designChannelVoice, fetchChannelVoices, saveChannelVoice, type VoiceDesignParams } from "@/services/api/audio";
import { resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";

type AudioSettingKey = "audioVoice" | "audioFormat" | "audioSpeed" | "audioPitch" | "audioVolume" | "audioInstructions";

type AudioSettingsPanelProps = {
    config: AiConfig;
    onConfigChange: (key: AudioSettingKey, value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
};

export function AudioSettingsPanel({ config, onConfigChange, theme, showTitle = true, className = "w-[var(--panel-width-compact)] space-y-4 rounded-2xl px-1 py-0.5" }: AudioSettingsPanelProps) {
    const model = config.model || config.audioModel;
    const profile = audioSpeechProfile(model);
    const voice = normalizeAudioVoiceValue(config.audioVoice, model);
    const format = normalizeAudioFormatValue(config.audioFormat, model);
    const speed = normalizeAudioSpeedValue(config.audioSpeed, model);
    const pitch = normalizeAudioPitchValue(config.audioPitch);
    const volume = normalizeAudioVolumeValue(config.audioVolume);

    // 本地 TTS 模型（网关 indextts2 / voiceforge）：音色来自渠道 /voices（预置参考音频），
    // 拉不到时回落静态 OpenAI 音色名（服务端有别名兜底映射）。
    const wantsChannelVoices = /voiceforge|indextts|tts/i.test(model);
    const audioRequestConfig = useMemo(() => resolveModelRequestConfig(config, model), [config, model]);
    const isLocalGatewayChannel = /127\.0\.0\.1|localhost|::1/i.test(audioRequestConfig.baseUrl);
    const [channelVoices, setChannelVoices] = useState<string[] | null>(null);
    useEffect(() => {
        if (!wantsChannelVoices) {
            setChannelVoices(null);
            return;
        }
        let cancelled = false;
        void channelVoicesFor(config, model).then((voices) => {
            if (!cancelled) setChannelVoices(voices);
        });
        return () => { cancelled = true; };
    }, [config, model, wantsChannelVoices]);
    const voiceOptions = useMemo(() => {
        if (!wantsChannelVoices || !channelVoices?.length) return profile.voices;
        const options = channelVoices.map((value) => ({ value, label: value }));
        if (voice && !channelVoices.includes(voice)) options.unshift({ value: voice, label: voice });
        return options;
    }, [channelVoices, profile.voices, voice, wantsChannelVoices]);

    // ---------- 设计新音色（本地网关 · Spark-TTS 即用即卸） ----------
    const canDesignVoice = wantsChannelVoices && isLocalGatewayChannel;
    const [designParams, setDesignParams] = useState<VoiceDesignParams>({ gender: "male", pitch: "low", speed: "moderate", text: "大家好，这是我的声音，很高兴认识你。" });
    const [designWav, setDesignWav] = useState<Blob | null>(null);
    const [designUrl, setDesignUrl] = useState<string | null>(null);
    const [designBusy, setDesignBusy] = useState(false);
    const [designName, setDesignName] = useState("");
    const [designMessage, setDesignMessage] = useState("");
    useEffect(() => {
        return () => { if (designUrl) URL.revokeObjectURL(designUrl); };
    }, [designUrl]);
    const startVoiceDesign = async () => {
        setDesignBusy(true);
        setDesignMessage("音色生成中（约 30-60 秒）…");
        try {
            const wav = await designChannelVoice(audioRequestConfig, designParams);
            setDesignWav(wav);
            setDesignUrl((prev) => {
                if (prev) URL.revokeObjectURL(prev);
                return URL.createObjectURL(wav);
            });
            setDesignMessage("试听满意后命名保存；不满意可换参数重新生成。");
        } catch (error) {
            setDesignWav(null);
            setDesignMessage(error instanceof Error ? error.message : "音色设计失败");
        } finally {
            setDesignBusy(false);
        }
    };
    const saveDesignedVoice = async () => {
        if (!designWav || !designName.trim()) return;
        setDesignBusy(true);
        try {
            const voices = await saveChannelVoice(audioRequestConfig, { name: designName.trim(), wav: designWav, text: designParams.text });
            invalidateChannelVoices(config, model);
            setChannelVoices(voices);
            onConfigChange("audioVoice", designName.trim());
            setDesignMessage(`音色 "${designName.trim()}" 已入库并选中，可直接生成。`);
            setDesignName("");
        } catch (error) {
            setDesignMessage(error instanceof Error ? error.message : "音色保存失败");
        } finally {
            setDesignBusy(false);
        }
    };

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? <div className="text-lg font-semibold">音频设置</div> : null}
                {profile.showVoice ? (
                    <SettingGroup title="音色" color={theme.node.muted}>
                        <div className="grid grid-cols-3 gap-2.5">
                            {voiceOptions.map((item) => (
                                <OptionPill key={item.value} selected={voice === item.value} theme={theme} onClick={() => onConfigChange("audioVoice", item.value)}>
                                    {item.label}
                                </OptionPill>
                            ))}
                        </div>
                        {canDesignVoice ? (
                            <details
                                className="rounded-xl border"
                                style={{ borderColor: theme.node.stroke }}
                                onMouseDown={(event) => event.stopPropagation()}
                            >
                                <summary className="cursor-pointer select-none px-3 py-2 text-xs" style={{ color: theme.node.muted }}>
                                    ＋ 设计新音色（本地）
                                </summary>
                                <div className="space-y-2.5 px-3 pb-3 pt-1">
                                    <div className="flex flex-wrap gap-2">
                                        {([["male", "男声"], ["female", "女声"]] as const).map(([value, label]) => (
                                            <OptionPill key={value} selected={designParams.gender === value} theme={theme} onClick={() => setDesignParams((p) => ({ ...p, gender: value }))}>
                                                {label}
                                            </OptionPill>
                                        ))}
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        {([["very_low", "极低"], ["low", "低沉"], ["moderate", "适中"], ["high", "偏高"], ["very_high", "高亢"]] as const).map(([value, label]) => (
                                            <OptionPill key={value} selected={designParams.pitch === value} theme={theme} onClick={() => setDesignParams((p) => ({ ...p, pitch: value }))}>
                                                {label}
                                            </OptionPill>
                                        ))}
                                    </div>
                                    <div className="flex flex-wrap gap-2">
                                        {([["low", "慢"], ["moderate", "适中"], ["high", "快"]] as const).map(([value, label]) => (
                                            <OptionPill key={value} selected={designParams.speed === value} theme={theme} onClick={() => setDesignParams((p) => ({ ...p, speed: value }))}>
                                                {label}
                                            </OptionPill>
                                        ))}
                                    </div>
                                    <input
                                        value={designParams.text}
                                        placeholder="试听文本"
                                        className="h-9 w-full rounded-full border bg-transparent px-3 text-sm outline-none"
                                        style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                                        onChange={(event) => setDesignParams((p) => ({ ...p, text: event.target.value }))}
                                        onMouseDown={(event) => event.stopPropagation()}
                                    />
                                    <button
                                        type="button"
                                        className="h-9 w-full cursor-pointer rounded-full border text-sm transition hover:opacity-80 disabled:cursor-default disabled:opacity-45"
                                        style={{ borderColor: theme.node.text, color: theme.node.text }}
                                        disabled={designBusy || !designParams.text.trim()}
                                        onClick={() => void startVoiceDesign()}
                                        onMouseDown={(event) => event.stopPropagation()}
                                    >
                                        {designBusy ? "生成中（约 30-60 秒）…" : "生成试听"}
                                    </button>
                                    {designUrl ? (
                                        <div onMouseDown={(event) => event.stopPropagation()}>
                                            {/* eslint-disable-next-line jsx-a11y/media-has-caption -- 纯音频试听 */}
                                            <audio controls src={designUrl} className="w-full" />
                                        </div>
                                    ) : null}
                                    {designWav ? (
                                        <div className="flex gap-2">
                                            <input
                                                value={designName}
                                                placeholder="音色名，如 boss-male"
                                                className="h-9 min-w-0 flex-1 rounded-full border bg-transparent px-3 text-sm outline-none"
                                                style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                                                onChange={(event) => setDesignName(event.target.value)}
                                                onMouseDown={(event) => event.stopPropagation()}
                                            />
                                            <button
                                                type="button"
                                                className="h-9 shrink-0 cursor-pointer rounded-full border px-3 text-sm transition hover:opacity-80 disabled:cursor-default disabled:opacity-45"
                                                style={{ borderColor: theme.node.text, color: theme.node.text }}
                                                disabled={designBusy || !designName.trim()}
                                                onClick={() => void saveDesignedVoice()}
                                                onMouseDown={(event) => event.stopPropagation()}
                                            >
                                                保存为音色
                                            </button>
                                        </div>
                                    ) : null}
                                    {designMessage ? (
                                        <div className="text-xs leading-4" style={{ color: theme.node.muted }}>
                                            {designMessage}
                                        </div>
                                    ) : null}
                                </div>
                            </details>
                        ) : null}
                    </SettingGroup>
                ) : null}
                <SettingGroup title="格式" color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2.5">
                        {profile.formats.map((item) => (
                            <OptionPill key={item.value} selected={format === item.value} theme={theme} onClick={() => onConfigChange("audioFormat", item.value)}>
                                {item.label}
                            </OptionPill>
                        ))}
                    </div>
                </SettingGroup>
                {profile.showSpeed ? (
                    <SettingGroup title="语速" color={theme.node.muted}>
                        <div className="grid grid-cols-4 gap-2.5">
                            {profile.speedOptions.map((value) => (
                                <OptionPill key={value} selected={speed === value} theme={theme} onClick={() => onConfigChange("audioSpeed", value)}>
                                    {audioSpeedLabel(value, model)}
                                </OptionPill>
                            ))}
                        </div>
                        <input
                            type="number"
                            min={profile.speedMin}
                            max={profile.speedMax}
                            step={0.05}
                            className="h-9 w-full rounded-full border bg-transparent px-3 text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                            style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                            value={config.audioSpeed || "1"}
                            onChange={(event) => onConfigChange("audioSpeed", event.target.value)}
                            onBlur={(event) => onConfigChange("audioSpeed", normalizeAudioSpeedValue(event.target.value, model))}
                            onMouseDown={(event) => event.stopPropagation()}
                        />
                    </SettingGroup>
                ) : null}
                {profile.showPitch ? (
                    <SettingGroup title="声调" color={theme.node.muted}>
                        <div className="flex items-center gap-2">
                            <input aria-label="声调" type="range" min={-12} max={12} step={1} className="min-w-0 flex-1 accent-current" value={pitch} onChange={(event) => onConfigChange("audioPitch", event.target.value)} onMouseDown={(event) => event.stopPropagation()} />
                            <span className="w-12 text-right text-xs tabular-nums">{audioPitchLabel(pitch)}</span>
                        </div>
                    </SettingGroup>
                ) : null}
                {profile.showVolume ? (
                    <SettingGroup title="音量" color={theme.node.muted}>
                        <div className="flex items-center gap-2">
                            <input aria-label="音量" type="range" min={0} max={1} step={0.05} className="min-w-0 flex-1 accent-current" value={volume} onChange={(event) => onConfigChange("audioVolume", event.target.value)} onMouseDown={(event) => event.stopPropagation()} />
                            <span className="w-12 text-right text-xs tabular-nums">{audioVolumeLabel(volume)}</span>
                        </div>
                    </SettingGroup>
                ) : null}
                {profile.showInstructions ? (
                    <SettingGroup title="声音指令" color={theme.node.muted}>
                        <textarea
                            value={config.audioInstructions || ""}
                            placeholder={wantsChannelVoices ? "情感词：高兴 / 愤怒 / 悲伤 / 恐惧 / 反感 / 低落 / 惊讶 / 自然" : "例如：自然、温暖、适合旁白。"}
                            className="thin-scrollbar h-20 w-full resize-none rounded-xl border bg-transparent px-3 py-2 text-sm leading-5 outline-none"
                            style={{ borderColor: theme.node.stroke, color: theme.node.text }}
                            onChange={(event) => onConfigChange("audioInstructions", event.target.value)}
                            onMouseDown={(event) => event.stopPropagation()}
                        />
                    </SettingGroup>
                ) : null}
            </div>
        </ImageSettingsTheme>
    );
}

function OptionPill({ selected, theme, onClick, children }: { selected: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            className="h-9 cursor-pointer rounded-full border px-2 text-sm transition hover:opacity-80"
            style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <div className="space-y-2.5">
            <div className="text-xs font-medium" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}

// 渠道音色列表按 baseUrl+model 缓存（含失败空结果），避免弹窗每次打开都打一次 /voices
const channelVoicesCache = new Map<string, Promise<string[]>>();
function channelVoicesFor(config: AiConfig, model: string): Promise<string[]> {
    const requestConfig = resolveModelRequestConfig(config, model);
    const key = `${requestConfig.baseUrl}::${requestConfig.model}`;
    let entry = channelVoicesCache.get(key);
    if (!entry) {
        entry = fetchChannelVoices(requestConfig).catch(() => [] as string[]);
        channelVoicesCache.set(key, entry);
    }
    return entry;
}

function invalidateChannelVoices(config: AiConfig, model: string): void {
    const requestConfig = resolveModelRequestConfig(config, model);
    channelVoicesCache.delete(`${requestConfig.baseUrl}::${requestConfig.model}`);
}
