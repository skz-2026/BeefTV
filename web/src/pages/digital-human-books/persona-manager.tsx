import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { App, Alert, Button, Input, Progress, Select, Space, Tooltip } from "antd";
import { ExperimentOutlined, PictureOutlined, SoundOutlined, StarOutlined, ThunderboltOutlined } from "@ant-design/icons";

import { CanvasPromptLibraryModal } from "@/components/canvas/canvas-prompt-library-modal";
import { AppModal } from "@/components/ui/product/app-modal/app-modal";
import { http } from "@/services/api/request";
import { fetchChannelVoices, requestAudioGeneration } from "@/services/api/audio";
import { runCanvasImageTask } from "@/services/digital-human-media";
import { createPersonaCanvas } from "@/services/digital-human-split";
import { DIGITAL_HUMAN_STYLES, parsePersonaCanvas, personaPortraitPrompt, type DigitalHumanStyleId, type PersonaDoc } from "@/services/digital-human-doc";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { resolveModelRequestConfig, useConfigStore } from "@/stores/use-config-store";
import { defaultStorybookAudioModel, storybookAudioModelOptions } from "@/services/storybook-audio";

// 数字人档案编辑：人物参考图（一次生成、跨期复用）+ 固定音色 + 英文外貌锚点。
// 档案存为独立画布（digitalhuman-persona 文本节点 + portrait 图片节点），
// 建口播册时快照进 persona，改档案不影响已建的期。

type Props = {
    open: boolean;
    onClose: () => void;
    onSaved: () => void;
    /** 编辑既有数字人（画布 id）；缺省 = 新建 */
    editingCanvasId?: string;
};

type FormState = {
    personaId: string;
    name: string;
    note: string;
    appearanceZh: string;
    appearanceEn: string;
    style: DigitalHumanStyleId;
    voice: string;
    voiceModel: string;
    voiceInstructions: string;
};

const EMPTY_FORM: FormState = { personaId: "", name: "", note: "", appearanceZh: "", appearanceEn: "", style: "realistic", voice: "", voiceModel: "", voiceInstructions: "" };

export function PersonaManagerModal({ open, onClose, onSaved, editingCanvasId }: Props) {
    const { message } = App.useApp();
    const globalConfig = useConfigStore((state) => state.config);
    const [form, setForm] = useState<FormState>(EMPTY_FORM);
    const [savedCanvasId, setSavedCanvasId] = useState<string | null>(null);
    const [portraitUrl, setPortraitUrl] = useState<string | null>(null);
    const portraitKeyRef = useRef<string | null>(null);
    const [generating, setGenerating] = useState<string | null>(null); // 'portrait' | 'retouch' | 'preview' | 'anchor'
    const [error, setError] = useState<string | null>(null);
    const [voices, setVoices] = useState<string[] | null>(null);
    const [anchorLibraryOpen, setAnchorLibraryOpen] = useState(false);
    const audioRef = useRef<HTMLAudioElement | null>(null);

    const audioModelOptions = useMemo(() => storybookAudioModelOptions(globalConfig), [globalConfig]);
    const effectiveVoiceModel = form.voiceModel || defaultStorybookAudioModel(globalConfig, audioModelOptions);
    const imageChannelOptions = useMemo(() => {
        const options: Array<{ value: string; label: string }> = [];
        for (const channel of globalConfig.channels ?? []) {
            if ((channel.models ?? []).some((m) => m === "qwen-image-2.1" || m === "qwen-edit-plus")) {
                options.push({ value: channel.id, label: channel.name });
            }
        }
        return options;
    }, [globalConfig.channels]);
    const effectiveImageChannel = imageChannelOptions[0]?.value ?? "";

    const patch = (p: Partial<FormState>) => setForm((prev) => ({ ...prev, ...p }));

    // 打开时载入既有档案或重置表单
    useEffect(() => {
        if (!open) return;
        setError(null);
        setGenerating(null);
        audioRef.current?.pause();
        if (!editingCanvasId) {
            setForm(EMPTY_FORM);
            setSavedCanvasId(null);
            setPortraitUrl(null);
            return;
        }
        (async () => {
            try {
                const res = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(editingCanvasId)}`);
                const doc: PersonaDoc | null = parsePersonaCanvas(res.project);
                if (!doc) throw new Error("画布里没有数字人档案");
                setForm({
                    personaId: editingCanvasId.replace(/^digitalhuman-persona-/, ""),
                    name: doc.config.name,
                    note: doc.config.note ?? "",
                    appearanceZh: "",
                    appearanceEn: doc.config.appearanceEn,
                    style: doc.config.style ?? "realistic",
                    voice: doc.config.voice,
                    voiceModel: doc.config.voiceModel,
                    voiceInstructions: doc.config.voiceInstructions ?? "",
                });
                setSavedCanvasId(editingCanvasId);
                portraitKeyRef.current = doc.portraitStorageKey;
                setPortraitUrl(doc.portraitStorageKey ? `/api/resources/${doc.portraitStorageKey.replace(/^resource:/, "")}/file` : null);
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
            }
        })();
    }, [open, editingCanvasId]);

    // 本机 TTS 预置音色列表（IndexTTS-2 克隆音色 = presets 目录）
    const voiceRequestConfig = useMemo(() => resolveModelRequestConfig(globalConfig, effectiveVoiceModel), [globalConfig, effectiveVoiceModel]);
    const usesPresetVoices = /tts|voiceforge/i.test(voiceRequestConfig.model) && /127\.0\.0\.1|localhost|::1/i.test(voiceRequestConfig.baseUrl);
    useEffect(() => {
        if (!usesPresetVoices) { setVoices(null); return; }
        let cancelled = false;
        (async () => {
            const list = await fetchChannelVoices(voiceRequestConfig).catch(() => [] as string[]);
            if (!cancelled) setVoices(list);
        })();
        return () => { cancelled = true; };
    }, [usesPresetVoices, voiceRequestConfig]);

    const canvasId = savedCanvasId ?? (form.personaId.trim() ? `digitalhuman-persona-${form.personaId.trim()}` : "");

    /** 保存档案（新建或更新画布）；返回画布 id */
    const save = useCallback(async (): Promise<string | null> => {
        setError(null);
        if (!form.name.trim() || !form.appearanceEn.trim()) {
            setError("名称与英文外貌锚点必填（锚点决定人物一致性，建议 30-80 词）");
            return null;
        }
        if (!savedCanvasId && !/^[a-z0-9-]+$/i.test(form.personaId.trim())) {
            setError("数字人 ID 只能是英文、数字和连字符（如 anchor-li）");
            return null;
        }
        try {
            const id = savedCanvasId ?? await createPersonaCanvas({
                personaId: form.personaId.trim(),
                name: form.name.trim(),
                ...(form.note.trim() ? { note: form.note.trim() } : {}),
                appearanceEn: form.appearanceEn.trim(),
                style: form.style,
                voice: form.voice || "alloy",
                voiceModel: effectiveVoiceModel,
                ...(form.voiceInstructions.trim() ? { voiceInstructions: form.voiceInstructions.trim() } : {}),
                imageChannel: effectiveImageChannel,
            });
            if (savedCanvasId) {
                // 更新：整体重写 persona 文本节点 content（revision 409 时重拉重试）
                for (let attempt = 0; attempt < 3; attempt++) {
                    const fresh = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(savedCanvasId)}`);
                    const nodes = fresh.project.nodes.map((node) => (node.id === "digitalhuman-persona"
                        ? {
                            ...node,
                            metadata: {
                                ...(node.metadata ?? {}),
                                content: JSON.stringify({
                                    kind: "digitalhuman-persona",
                                    name: form.name.trim(),
                                    ...(form.note.trim() ? { note: form.note.trim() } : {}),
                                    appearanceEn: form.appearanceEn.trim(),
                                    style: form.style,
                                    voice: form.voice || "alloy",
                                    voiceModel: effectiveVoiceModel,
                                    ...(form.voiceInstructions.trim() ? { voiceInstructions: form.voiceInstructions.trim() } : {}),
                                }, null, 1),
                            },
                        }
                        : node));
                    try {
                        await http.put(`/canvas-projects/${encodeURIComponent(savedCanvasId)}`, { project: { ...fresh.project, nodes }, assets: [] });
                        return savedCanvasId;
                    } catch { /* revision 冲突重试 */ }
                }
                throw new Error("画布写入连续冲突，请稍后再试");
            }
            setSavedCanvasId(id);
            return id;
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            return null;
        }
    }, [effectiveImageChannel, effectiveVoiceModel, form, savedCanvasId]);

    /** 生成人物图并写回 portrait 节点（generated-assets 原子通道） */
    const generatePortrait = async (mode: "portrait" | "retouch") => {
        const projectId = await save();
        if (!projectId || !effectiveImageChannel) return;
        setGenerating(mode);
        try {
            const isRetouch = mode === "retouch";
            const refs = isRetouch && portraitKeyRef.current ? [{ storageKey: portraitKeyRef.current, name: "portrait.png" }] : [];
            const prompt = isRetouch
                ? `Enhance this portrait with realistic fine detail: visible skin pores, subtle wrinkles, individual hair strands, fabric texture. Keep the identity, pose, framing and lighting exactly the same. ${DIGITAL_HUMAN_STYLES[form.style].portraitSuffix}`
                : personaPortraitPrompt({ appearanceEn: form.appearanceEn.trim(), style: form.style });
            const result = await runCanvasImageTask({
                projectId,
                model: `${effectiveImageChannel}::${isRetouch ? "qwen-edit-plus" : "qwen-image-2.1"}`,
                prompt,
                size: "960x960",
                ...(refs.length ? { referenceImages: refs } : {}),
                nodeId: "portrait",
            });
            // 写回：拉最新画布，portrait 节点顶层媒体走 generated-assets
            for (let attempt = 0; attempt < 3; attempt++) {
                const fresh = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(projectId)}`);
                const assetId = "generation_" + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
                const now = new Date().toISOString();
                const mediaPatch = {
                    content: `/api/resources/${result.resourceId}/file`,
                    storageKey: `resource:${result.resourceId}`,
                    status: "success" as const,
                    assetId,
                    bytes: result.bytes,
                    naturalWidth: result.width,
                    naturalHeight: result.height,
                };
                const nodes = fresh.project.nodes.map((node) => (node.id === "portrait" ? { ...node, metadata: { ...(node.metadata ?? {}), ...mediaPatch } } : node));
                const asset = {
                    id: assetId,
                    kind: "image",
                    category: "material",
                    status: "ready",
                    primaryVersionId: crypto.randomUUID().replace(/-/g, ""),
                    title: `数字人·${form.name || "portrait"}`,
                    createdAt: now,
                    updatedAt: now,
                    coverUrl: `/api/resources/${result.resourceId}/file`,
                    source: "generation-task",
                    data: { bytes: result.bytes ?? 0, dataUrl: `/api/resources/${result.resourceId}/file`, height: result.height ?? 0, mimeType: "image/png", storageKey: `resource:${result.resourceId}`, width: result.width ?? 0 },
                    metadata: { generationEffectKey: `dh-portrait:${now}`, nodeId: "portrait", outputIndex: 0, source: "generation-task" },
                    tags: [],
                };
                try {
                    await http.put(`/canvas-projects/${encodeURIComponent(projectId)}/generated-assets`, { project: { ...fresh.project, nodes }, assets: [asset] });
                    portraitKeyRef.current = `resource:${result.resourceId}`;
                    setPortraitUrl(result.url);
                    message.success(isRetouch ? "人物图已精修" : "人物图已生成");
                    onSaved();
                    return;
                } catch { /* revision 冲突重试 */ }
            }
            throw new Error("画布写入连续冲突");
        } catch (e) {
            message.error(`${mode === "retouch" ? "精修" : "生成人物图"}失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setGenerating(null);
        }
    };

    /** 音色试听：本地合成一句固定示例（不落资源库） */
    const previewVoice = async () => {
        if (!form.voice) { message.warning("先选择音色"); return; }
        setGenerating("preview");
        try {
            const blob = await requestAudioGeneration({ ...voiceRequestConfig, model: effectiveVoiceModel, audioVoice: form.voice, audioInstructions: form.voiceInstructions, audioFormat: "wav" }, "大家好，每天三分钟，带你看看今天最值得聊的事。");
            const url = URL.createObjectURL(blob);
            audioRef.current?.pause();
            const audio = new Audio(url);
            audioRef.current = audio;
            audio.onended = () => URL.revokeObjectURL(url);
            await audio.play();
        } catch (e) {
            message.error(`试听失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setGenerating(null);
        }
    };

    const busy = !!generating;
    const canSave = form.name.trim().length > 0 && form.appearanceEn.trim().length > 0 && (savedCanvasId ? true : /^[a-z0-9-]+$/i.test(form.personaId.trim()));

    return (
        <>
        <AppModal
            open={open}
            onCancel={() => { if (!busy) onClose(); }}
            title={editingCanvasId ? "编辑数字人" : "新建数字人"}
            width={760}
            footer={null}
        >
            <div style={{ display: "flex", flexDirection: "column", gap: 12, maxHeight: "74vh", overflowY: "auto", padding: "4px 4px 8px" }}>
                <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 14 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <div style={{ aspectRatio: "3 / 4", borderRadius: 10, border: "1px solid var(--user-border, var(--border))", overflow: "hidden", background: "var(--user-fill, rgba(128,128,128,.08))", display: "grid", placeItems: "center" }}>
                            {portraitUrl ? <img src={portraitUrl} alt="人物参考图" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <PictureOutlined style={{ fontSize: 28, opacity: 0.35 }} />}
                        </div>
                        <Space direction="vertical" size={4} style={{ width: "100%" }}>
                            <Button block icon={<ThunderboltOutlined />} loading={generating === "portrait"} disabled={!canSave || !effectiveImageChannel} onClick={() => void generatePortrait("portrait")}>
                                {portraitUrl ? "重新生成人物图" : "生成人物图"}
                            </Button>
                            <Tooltip title="在人物图上追加毛孔、发丝等真实细节（参考视频同款修图步），身份与构图保持不变">
                                <Button block icon={<StarOutlined />} loading={generating === "retouch"} disabled={!portraitUrl || !effectiveImageChannel} onClick={() => void generatePortrait("retouch")}>
                                    精修细节
                                </Button>
                            </Tooltip>
                        </Space>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                            <div>
                                <div style={{ marginBottom: 4, fontSize: 13 }}>数字人 ID（英文，档案画布的后缀）</div>
                                <Input value={form.personaId} onChange={(e) => patch({ personaId: e.target.value })} placeholder="anchor-li" disabled={!!savedCanvasId || busy} />
                            </div>
                            <div>
                                <div style={{ marginBottom: 4, fontSize: 13 }}>名称</div>
                                <Input value={form.name} onChange={(e) => patch({ name: e.target.value })} placeholder="李主播" disabled={busy} />
                            </div>
                        </div>
                        <div>
                            <div style={{ marginBottom: 4, fontSize: 13 }}>画风（人物图与场景图共用，跨期一致）</div>
                            <Select value={form.style} onChange={(v) => patch({ style: v })} disabled={busy} style={{ width: "100%" }}
                                options={Object.entries(DIGITAL_HUMAN_STYLES).map(([id, s]) => ({ value: id as DigitalHumanStyleId, label: s.label }))} />
                        </div>
                        <div>
                            <div style={{ marginBottom: 4, fontSize: 13 }}>中文描述（备注，不进提示词）</div>
                            <Input.TextArea rows={2} value={form.appearanceZh} onChange={(e) => patch({ appearanceZh: e.target.value })} placeholder="35 岁男性新闻主播，短发西装，沉稳可信" disabled={busy} />
                        </div>
                        <div>
                            <div style={{ marginBottom: 4, fontSize: 13, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                                <span>英文外貌锚点（决定人物一致性：长相/发型/穿着/气质，30-80 词）</span>
                                <Tooltip title="从提示词参考库搜索人物形象提示词，选中后追加到锚点（可再删改）">
                                    <Button type="text" size="small" disabled={busy} onClick={() => setAnchorLibraryOpen(true)}>参考库</Button>
                                </Tooltip>
                            </div>
                            <Input.TextArea rows={3} value={form.appearanceEn} onChange={(e) => patch({ appearanceEn: e.target.value })}
                                placeholder="a 35-year-old East Asian male news anchor, short black hair, charcoal suit with white shirt, calm trustworthy presence" disabled={busy} />
                        </div>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                            <div>
                                <div style={{ marginBottom: 4, fontSize: 13 }}>配音模型（本机 IndexTTS-2 优先）</div>
                                <Select value={effectiveVoiceModel} onChange={(v) => patch({ voiceModel: v, voice: "" })} disabled={busy} style={{ width: "100%" }}
                                    options={audioModelOptions} placeholder="选择音频模型" notFoundContent="没有可用音频渠道，请先到「模型配置」添加" />
                            </div>
                            <div>
                                <div style={{ marginBottom: 4, fontSize: 13 }}>音色（预置克隆音色，跨期一致）</div>
                                <Select value={form.voice} onChange={(v) => patch({ voice: v })} disabled={busy} style={{ width: "100%" }} showSearch
                                    options={(voices ?? []).map((v) => ({ value: v, label: v }))} placeholder={voices === null ? "选择或输入音色名" : "选择音色"}
                                    notFoundContent={voices?.length === 0 ? "该渠道未返回音色列表" : undefined} />
                            </div>
                        </div>
                        <div>
                            <div style={{ marginBottom: 4, fontSize: 13 }}>情感/语气指令（IndexTTS-2 生效，如「沉稳自信，新闻播报语气」）</div>
                            <Input value={form.voiceInstructions} onChange={(e) => patch({ voiceInstructions: e.target.value })} placeholder="沉稳自信，语速适中" disabled={busy} />
                        </div>
                    </div>
                </div>
                {error ? <Alert type="error" showIcon message={error} /> : null}
                {generating === "preview" ? <Progress percent={80} size="small" status="active" /> : null}
                <Space>
                    <Button type="primary" disabled={!canSave || busy} onClick={() => { void save().then((id) => { if (id) { message.success("档案已保存"); onSaved(); } }); }}>保存档案</Button>
                    <Button icon={<SoundOutlined />} loading={generating === "preview"} disabled={!form.voice || busy} onClick={() => void previewVoice()}>试听音色</Button>
                    {savedCanvasId ? <Button onClick={() => { if (!busy) onClose(); }} disabled={busy}>完成</Button> : <Button onClick={() => { if (!busy) onClose(); }} disabled={busy}>取消</Button>}
                    {imageChannelOptions.length === 0 ? <span style={{ fontSize: 12, color: "#d46b08" }}><ExperimentOutlined /> 先到「模型配置」配好 qwen 生图渠道再生成人物图</span> : null}
                </Space>
                <div style={{ fontSize: 12, opacity: 0.65 }}>
                    数字人 = 人物参考图 + 固定音色 + 外貌锚点，一次建档跨期复用；建口播册时快照绑定，改档案不影响已建的期。
                </div>
            </div>
        </AppModal>
        <CanvasPromptLibraryModal
            open={anchorLibraryOpen}
            onClose={() => setAnchorLibraryOpen(false)}
            onInsert={(promptText) => patch({ appearanceEn: form.appearanceEn.trim() ? `${form.appearanceEn.trim()}, ${promptText}` : promptText })}
        />
        </>
    );
}
