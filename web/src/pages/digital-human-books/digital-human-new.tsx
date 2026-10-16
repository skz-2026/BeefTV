import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { App, Alert, Button, Input, Modal, Progress, Select, Space, Tabs } from "antd";
import { AudioOutlined, FileAddOutlined, ThunderboltOutlined, UserOutlined } from "@ant-design/icons";

import { createDigitalHumanCanvas, splitDigitalHumanEpisode, type SplitEpisode } from "@/services/digital-human-split";
import { DIGITAL_HUMAN_ASPECTS, type DigitalHumanAspect, type DigitalHumanPersonaCard } from "@/services/digital-human-doc";
import { useConfigStore } from "@/stores/use-config-store";

type Phase = "form" | "outline" | "fill" | "done" | "creating";
type SourceTab = "idea" | "text";

/** 新建口播弹窗：主题/贴稿 → 两段式 LLM 分镜 → 选数字人与渠道 → 建口播画布 */
export function DigitalHumanNewModal({ open, onClose, personas }: { open: boolean; onClose: () => void; personas: DigitalHumanPersonaCard[] }) {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const config = useConfigStore((state) => state.config);
    const [tab, setTab] = useState<SourceTab>("idea");
    const [idea, setIdea] = useState("");
    const [script, setScript] = useState("");
    const [episodeId, setEpisodeId] = useState("");
    const [durationSec, setDurationSec] = useState(90);
    const [aspect, setAspect] = useState<DigitalHumanAspect>("9:16");
    const [personaKey, setPersonaKey] = useState("");
    const [model, setModel] = useState("");
    const [imageChannelId, setImageChannelId] = useState("");
    const [videoChannelId, setVideoChannelId] = useState("");
    const [videoModelName, setVideoModelName] = useState("");
    const [phase, setPhase] = useState<Phase>("form");
    const [progress, setProgress] = useState<{ done: number; total: number; detail?: string }>({ done: 0, total: 1 });
    const [episode, setEpisode] = useState<SplitEpisode | null>(null);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    // 文本模型候选：全部渠道的模型展开（本地网关只有图片/视频/音频，选了也跑不通，过滤 127.0.0.1）
    const textModelOptions = useMemo(() => {
        const options: Array<{ value: string; label: string }> = [];
        for (const channel of config.channels ?? []) {
            if (!channel.baseUrl || /127\.0\.0\.1|localhost/.test(channel.baseUrl)) continue;
            for (const m of channel.models ?? []) options.push({ value: `${channel.id}::${m}`, label: `${m}（${channel.name}）` });
        }
        return options;
    }, [config.channels]);
    // 生图渠道（场景图/站位首帧挂 qwen 车道）
    const imageChannelOptions = useMemo(() => {
        const options: Array<{ value: string; label: string }> = [];
        for (const channel of config.channels ?? []) {
            if ((channel.models ?? []).some((m) => m === "qwen-image-2.1" || m === "qwen-edit-plus")) options.push({ value: channel.id, label: channel.name });
        }
        return options;
    }, [config.channels]);
    // 视频渠道：openai-videos 协议（本机 ComfyUI 网关），模型取渠道内 dub 类模板优先
    const videoChannelOptions = useMemo(() => {
        const options: Array<{ id: string; name: string; models: string[] }> = [];
        for (const channel of config.channels ?? []) {
            if (!channel.baseUrl) continue;
            const isVideos = /openai-video/i.test(channel.interfaceType || "") || (channel.models ?? []).some((m) => /h3-hybrid-dub/.test(m));
            if (isVideos) options.push({ id: channel.id, name: channel.name, models: channel.models ?? [] });
        }
        return options;
    }, [config.channels]);
    const videoModels = useMemo(() => {
        const channel = videoChannelOptions.find((c) => c.id === (videoChannelId || videoChannelOptions[0]?.id));
        return channel?.models ?? [];
    }, [videoChannelOptions, videoChannelId]);

    const defaultModel = textModelOptions.find((o) => o.value.includes("deepseek"))?.value ?? (textModelOptions[0]?.value ?? "");
    const effectiveModel = model || defaultModel;
    const effectiveImageChannel = imageChannelId || (imageChannelOptions[0]?.value ?? "");
    const effectiveVideoChannel = videoChannelId || (videoChannelOptions[0]?.id ?? "");
    const effectiveVideoModel = videoModelName
        // 口播必须是 dub-flf 家族（lock_source 口型直通）；普通 hybrid-dub 是 native 模式，<Audio 1> 会被 H3 严格校验拒绝
        || videoModels.find((m) => /dub-flf/.test(m))
        || videoModels.find((m) => /dub/.test(m))
        || videoModels[0]
        || "";
    const readyPersonas = personas.filter((p) => p.ready);
    const effectivePersona = readyPersonas.find((p) => p.canvasId === personaKey) ?? readyPersonas[0];
    const sourceReady = tab === "idea" ? idea.trim().length >= 6 : script.trim().length >= 80;
    const canStart = sourceReady && /^[a-z0-9-]+$/i.test(episodeId.trim()) && !!effectiveModel && !!effectiveImageChannel && !!effectiveVideoChannel && !!effectiveVideoModel && !!effectivePersona;
    const busy = phase === "outline" || phase === "fill" || phase === "creating";

    const start = async () => {
        setError(null);
        setEpisode(null);
        setPhase("outline");
        setProgress({ done: 0, total: 1 });
        const controller = new AbortController();
        abortRef.current = controller;
        const channelId = effectiveModel.includes("::") ? effectiveModel.split("::")[0] : "";
        const modelName = effectiveModel.includes("::") ? effectiveModel.split("::")[1] : effectiveModel;
        const channel = (config.channels ?? []).find((c) => c.id === channelId);
        if (!channel) {
            setError("找不到文本渠道，请先在「模型配置」里配置（如 DeepSeek）");
            setPhase("form");
            return;
        }
        if (!effectivePersona) {
            setError("先在「数字人」页建档（人物图 + 音色）才能建口播");
            setPhase("form");
            return;
        }
        try {
            const result = await splitDigitalHumanEpisode({
                config: { ...channel, apiFormat: channel.apiFormat ?? "openai" } as never,
                model: modelName,
                source: { mode: tab, content: (tab === "idea" ? idea : script).trim() },
                episodeId: episodeId.trim(),
                durationSec,
                signal: controller.signal,
                onProgress: (p) => {
                    setPhase(p.stage === "outline" ? "outline" : "fill");
                    setProgress({ done: p.done, total: p.total, detail: p.detail });
                },
            });
            setEpisode(result);
            setPhase("done");
        } catch (e) {
            if (controller.signal.aborted) { setPhase("form"); return; }
            setError(e instanceof Error ? e.message : String(e));
            setPhase("form");
        }
    };

    const create = async () => {
        if (!episode || !effectivePersona) return;
        setPhase("creating");
        try {
            const { ready: _ready, ...persona } = effectivePersona;
            const canvasId = await createDigitalHumanCanvas({
                episode,
                topic: (tab === "idea" ? idea : script).trim().slice(0, 400),
                aspect,
                textModel: effectiveModel,
                imageChannel: effectiveImageChannel,
                videoChannel: effectiveVideoChannel,
                videoModel: effectiveVideoModel,
                persona,
            });
            message.success(`《${episode.title}》建册完成，跳转口播生产页`);
            onClose();
            navigate(`/digital-human-book/${encodeURIComponent(canvasId)}`);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setPhase("done");
        }
    };

    const close = () => {
        if (busy) abortRef.current?.abort();
        setPhase("form");
        setError(null);
        onClose();
    };

    const estSegments = Math.max(3, Math.round(durationSec / 10));

    return (
        <Modal
            open={open}
            onCancel={close}
            title={<Space><FileAddOutlined /> 新建数字人口播</Space>}
            width={760}
            footer={null}
            destroyOnHidden
        >
            {phase === "form" || phase === "outline" || phase === "fill" ? (
                <Space direction="vertical" size={12} style={{ width: "100%" }}>
                    <Tabs
                        activeKey={tab}
                        onChange={(k) => setTab(k as SourceTab)}
                        items={[
                            {
                                key: "idea",
                                label: "从一个主题开始",
                                children: (
                                    <Input.TextArea
                                        rows={4}
                                        value={idea}
                                        onChange={(e) => setIdea(e.target.value)}
                                        placeholder="例如：每天 3 分钟 AI 圈快讯，受众是科技爱好者，风格轻快犀利"
                                        disabled={busy}
                                    />
                                ),
                            },
                            {
                                key: "text",
                                label: "贴入口播文稿",
                                children: (
                                    <Input.TextArea
                                        rows={6}
                                        value={script}
                                        onChange={(e) => setScript(e.target.value)}
                                        placeholder="贴入完整口播稿（建议 200-2000 字），将忠实拆分为逐段分镜"
                                        disabled={busy}
                                    />
                                ),
                            },
                        ]}
                    />
                    <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr", gap: 10 }}>
                        <div>
                            <div style={{ marginBottom: 4, fontSize: 13 }}>期 ID（英文，画布将建为 digitalhuman-此ID）</div>
                            <Input value={episodeId} onChange={(e) => setEpisodeId(e.target.value)} placeholder="ai-news-001" disabled={busy} />
                        </div>
                        <div>
                            <div style={{ marginBottom: 4, fontSize: 13 }}>目标时长（约 {estSegments} 段）</div>
                            <Select value={durationSec} onChange={setDurationSec} disabled={busy} style={{ width: "100%" }}
                                options={[60, 90, 120, 180, 240].map((n) => ({ value: n, label: `${n} 秒` }))} />
                        </div>
                        <div>
                            <div style={{ marginBottom: 4, fontSize: 13 }}>画幅</div>
                            <Select value={aspect} onChange={setAspect} disabled={busy} style={{ width: "100%" }}
                                options={Object.entries(DIGITAL_HUMAN_ASPECTS).map(([id, a]) => ({ value: id as DigitalHumanAspect, label: a.label }))} />
                        </div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                        <div>
                            <div style={{ marginBottom: 4, fontSize: 13 }}>数字人（人物图 + 音色已就绪）</div>
                            <Select value={effectivePersona?.canvasId ?? ""} onChange={setPersonaKey} disabled={busy} style={{ width: "100%" }}
                                options={readyPersonas.map((p) => ({ value: p.canvasId, label: `${p.name}（${p.voice}）` }))}
                                placeholder="选择数字人" notFoundContent="没有就绪的数字人，先到本页「数字人」Tab 建档" />
                        </div>
                        <div>
                            <div style={{ marginBottom: 4, fontSize: 13 }}>拆分模型（文本渠道）</div>
                            <Select value={effectiveModel} onChange={setModel} disabled={busy} style={{ width: "100%" }}
                                options={textModelOptions} placeholder="选择文本模型" notFoundContent="没有可用文本渠道，请先到「模型配置」添加" />
                        </div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                        <div>
                            <div style={{ marginBottom: 4, fontSize: 13 }}>生图渠道（场景图/站位首帧）</div>
                            <Select value={effectiveImageChannel} onChange={setImageChannelId} disabled={busy} style={{ width: "100%" }}
                                options={imageChannelOptions} placeholder="选择生图渠道" notFoundContent="没有 qwen 渠道，请先到「模型配置」添加" />
                        </div>
                        <div>
                            <div style={{ marginBottom: 4, fontSize: 13 }}>视频渠道（本机 ComfyUI）</div>
                            <Select value={effectiveVideoChannel} onChange={(v) => { setVideoChannelId(v); setVideoModelName(""); }} disabled={busy} style={{ width: "100%" }}
                                options={videoChannelOptions.map((c) => ({ value: c.id, label: c.name }))} placeholder="选择视频渠道" notFoundContent="没有 openai-videos 渠道（本机网关），请先到「模型配置」添加" />
                        </div>
                        <div>
                            <div style={{ marginBottom: 4, fontSize: 13 }}>口播模板（dub = 口型同步）</div>
                            <Select value={effectiveVideoModel} onChange={setVideoModelName} disabled={busy || !videoModels.length} style={{ width: "100%" }}
                                options={videoModels.map((m) => ({ value: m, label: m }))} placeholder="选择视频模型" notFoundContent="该渠道没有模型" />
                        </div>
                    </div>
                    {error ? <Alert type="error" showIcon message={error} /> : null}
                    {busy ? (
                        <div>
                            <Progress
                                percent={phase === "outline" ? 10 : Math.round((progress.done / Math.max(1, progress.total)) * 90) + 10}
                                size="small"
                            />
                            <div style={{ fontSize: 12, opacity: 0.7 }}>
                                {phase === "outline" ? "正在写口播稿与分镜（场景/逐段台词/表情/微动作/景别）…" : `逐段表演提示词填充中 ${progress.done}/${progress.total} ${progress.detail ?? ""}`}
                            </div>
                        </div>
                    ) : null}
                    <Space>
                        <Button type="primary" icon={<ThunderboltOutlined />} loading={busy} disabled={!canStart} onClick={() => void start()}>
                            开始分镜
                        </Button>
                        {busy ? <Button onClick={() => abortRef.current?.abort()}>取消</Button> : null}
                        {readyPersonas.length === 0 ? (
                            <span style={{ fontSize: 12, color: "#d46b08" }}><UserOutlined /> 先到本页「数字人」Tab 建档（人物图 + 音色）</span>
                        ) : null}
                    </Space>
                </Space>
            ) : (
                <Space direction="vertical" size={12} style={{ width: "100%" }}>
                    <Alert
                        type="success"
                        showIcon
                        message={`《${episode?.title}》分镜完成`}
                        description={`将创建画布 digitalhuman-${episode?.id}：${episode?.scenes.length} 个场景 · ${episode?.segments.length} 段口播 · 数字人 ${effectivePersona?.name}（${effectivePersona?.voice}）· ${DIGITAL_HUMAN_ASPECTS[aspect].label}。建册后到生产页一键「生成缺音频 → 生成缺视频 → 合成成片」。`}
                    />
                    <div style={{ maxHeight: 200, overflowY: "auto", border: "1px solid var(--user-border, var(--border))", borderRadius: 8, padding: "8px 12px", fontSize: 13 }}>
                        {(episode?.segments ?? []).map((seg) => (
                            <div key={seg.id} style={{ display: "flex", gap: 8, padding: "3px 0" }}>
                                <span style={{ opacity: 0.55, minWidth: 32 }}>{seg.id}</span>
                                <span style={{ flex: 1 }}>{seg.line}</span>
                                <span style={{ opacity: 0.55, minWidth: 96, textAlign: "right" }}>{seg.camera} · ~{seg.secondsHint}s</span>
                            </div>
                        ))}
                    </div>
                    {error ? <Alert type="error" showIcon message={error} /> : null}
                    {phase === "creating" ? <Progress percent={95} size="small" status="active" /> : null}
                    <Space>
                        <Button type="primary" icon={<AudioOutlined />} loading={phase === "creating"} onClick={() => void create()}>创建口播并打开</Button>
                        <Button onClick={() => { setEpisode(null); setPhase("form"); }}>返回修改</Button>
                        <Button onClick={close}>取消</Button>
                    </Space>
                </Space>
            )}
        </Modal>
    );
}
