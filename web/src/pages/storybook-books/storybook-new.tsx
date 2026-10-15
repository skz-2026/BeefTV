import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { App, Alert, Button, Input, Modal, Progress, Select, Space, Tabs } from "antd";
import { ExperimentOutlined, FileAddOutlined, ThunderboltOutlined } from "@ant-design/icons";

import { createStorybookCanvas, splitStorybook, STORYBOOK_STYLES, type SplitStoryBook, type StorybookOrientation, type StorybookStyleId } from "@/services/storybook-split";
import { useConfigStore } from "@/stores/use-config-store";

type Phase = "form" | "outline" | "fill" | "done" | "creating";
type SourceTab = "idea" | "text";

/** 绘本书架页「新建绘本」弹窗：想法或贴入文本 → 两段式 LLM 拆书 → 一键建册（画布+storybook-config），全程界面内完成 */
export function StorybookNewModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const config = useConfigStore((state) => state.config);
    const [tab, setTab] = useState<SourceTab>("idea");
    const [idea, setIdea] = useState("");
    const [story, setStory] = useState("");
    const [bookId, setBookId] = useState("");
    const [pages, setPages] = useState(16);
    const [style, setStyle] = useState<StorybookStyleId>("watercolor");
    const [orientation, setOrientation] = useState<StorybookOrientation>("portrait");
    const [model, setModel] = useState("");
    const [imageChannelId, setImageChannelId] = useState("");
    const [phase, setPhase] = useState<Phase>("form");
    const [progress, setProgress] = useState<{ done: number; total: number; detail?: string }>({ done: 0, total: 1 });
    const [book, setBook] = useState<SplitStoryBook | null>(null);
    const [error, setError] = useState<string | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    // 文本模型候选：全部渠道的模型展开（本地网关只有图片/视频，选了也跑不通，过滤 127.0.0.1）
    const textModelOptions = useMemo(() => {
        const options: Array<{ value: string; label: string }> = [];
        for (const channel of config.channels ?? []) {
            if (!channel.baseUrl || /127\.0\.0\.1|localhost/.test(channel.baseUrl)) continue;
            for (const m of channel.models ?? []) {
                options.push({ value: `${channel.id}::${m}`, label: `${m}（${channel.name}）` });
            }
        }
        return options;
    }, [config.channels]);
    // 生图渠道候选（建册时挂 qwen-image-2.1/qwen-edit-plus 模型名）
    const imageChannelOptions = useMemo(() => {
        const options: Array<{ value: string; label: string }> = [];
        for (const channel of config.channels ?? []) {
            if ((channel.models ?? []).some((m) => m === "qwen-image-2.1" || m === "qwen-edit-plus")) {
                options.push({ value: channel.id, label: channel.name });
            }
        }
        return options;
    }, [config.channels]);

    const defaultModel = textModelOptions.find((o) => o.value.includes("deepseek"))?.value ?? (textModelOptions[0]?.value ?? "");
    const effectiveModel = model || defaultModel;
    const effectiveImageChannel = imageChannelId || (imageChannelOptions[0]?.value ?? "");
    const sourceReady = tab === "idea" ? idea.trim().length >= 8 : story.trim().length >= 100;
    const canStart = sourceReady && /^[a-z0-9-]+$/i.test(bookId.trim()) && !!effectiveModel && !!effectiveImageChannel;
    const busy = phase === "outline" || phase === "fill" || phase === "creating";

    const start = async () => {
        setError(null);
        setBook(null);
        setPhase("outline");
        setProgress({ done: 0, total: 1 });
        const controller = new AbortController();
        abortRef.current = controller;
        // 文本渠道 config：按 channelId 找渠道，拼成 channelRequest 需要的 AiConfig 形状
        const channelId = effectiveModel.includes("::") ? effectiveModel.split("::")[0] : "";
        const modelName = effectiveModel.includes("::") ? effectiveModel.split("::")[1] : effectiveModel;
        const channel = (config.channels ?? []).find((c) => c.id === channelId);
        if (!channel) {
            setError("找不到文本渠道，请先在「模型配置」里配置（如 DeepSeek）");
            setPhase("form");
            return;
        }
        try {
            const result = await splitStorybook({
                config: { ...channel, apiFormat: channel.apiFormat ?? "openai" } as never,
                model: modelName,
                source: { mode: tab, content: (tab === "idea" ? idea : story).trim() },
                bookId: bookId.trim(),
                pages,
                style,
                orientation,
                signal: controller.signal,
                onProgress: (p) => {
                    setPhase(p.stage === "outline" ? "outline" : "fill");
                    setProgress({ done: p.done, total: p.total, detail: p.detail });
                },
            });
            setBook(result);
            setPhase("done");
        } catch (e) {
            if (controller.signal.aborted) {
                setPhase("form");
                return;
            }
            setError(e instanceof Error ? e.message : String(e));
            setPhase("form");
        }
    };

    const create = async () => {
        if (!book) return;
        setPhase("creating");
        try {
            const canvasId = await createStorybookCanvas(book, effectiveImageChannel);
            message.success(`《${book.title}》建册完成，跳转绘本成书页`);
            onClose();
            navigate(`/storybook-book/${encodeURIComponent(canvasId)}`);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setPhase("done");
        }
    };

    const close = () => {
        if (busy) {
            abortRef.current?.abort();
        }
        setPhase("form");
        setError(null);
        onClose();
    };

    const nNarration = book?.panels.filter((p) => p.narration).length ?? 0;
    const nDialogue = book?.panels.reduce((n, p) => n + p.dialogue.length, 0) ?? 0;

    return (
        <Modal
            open={open}
            onCancel={close}
            title={<Space><FileAddOutlined /> 新建儿童绘本</Space>}
            width={720}
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
                                label: "从一个想法开始",
                                children: (
                                    <Input.TextArea
                                        rows={5}
                                        value={idea}
                                        onChange={(e) => setIdea(e.target.value)}
                                        placeholder="例如：一只怕黑的小兔子，在月亮的帮助下找到了回家的路"
                                        disabled={busy}
                                    />
                                ),
                            },
                            {
                                key: "text",
                                label: "贴入故事文本",
                                children: (
                                    <Input.TextArea
                                        rows={5}
                                        value={story}
                                        onChange={(e) => setStory(e.target.value)}
                                        placeholder="贴入童话或故事原文（建议 300-3000 字），将改编为逐页图文并做低龄化润色"
                                        disabled={busy}
                                    />
                                ),
                            },
                        ]}
                    />
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
                        <div>
                            <div style={{ marginBottom: 4, fontSize: 13 }}>书 ID（英文，画布将建为 storybook-此ID）</div>
                            <Input value={bookId} onChange={(e) => setBookId(e.target.value)} placeholder="moon-rabbit" disabled={busy} />
                        </div>
                        <div>
                            <div style={{ marginBottom: 4, fontSize: 13 }}>正文页数</div>
                            <Select value={pages} onChange={setPages} disabled={busy} style={{ width: "100%" }}
                                options={[8, 12, 16, 20, 24].map((n) => ({ value: n, label: `${n} 页` }))} />
                        </div>
                        <div>
                            <div style={{ marginBottom: 4, fontSize: 13 }}>画风</div>
                            <Select value={style} onChange={setStyle} disabled={busy} style={{ width: "100%" }}
                                options={Object.entries(STORYBOOK_STYLES).map(([id, s]) => ({ value: id as StorybookStyleId, label: s.label }))} />
                        </div>
                        <div>
                            <div style={{ marginBottom: 4, fontSize: 13 }}>开本</div>
                            <Select value={orientation} onChange={setOrientation} disabled={busy} style={{ width: "100%" }}
                                options={[{ value: "portrait", label: "竖版" }, { value: "square", label: "方形" }]} />
                        </div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                        <div>
                            <div style={{ marginBottom: 4, fontSize: 13 }}>拆分模型（文本渠道）</div>
                            <Select value={effectiveModel} onChange={setModel} disabled={busy} style={{ width: "100%" }}
                                options={textModelOptions} placeholder="选择文本模型" notFoundContent="没有可用文本渠道，请先到「模型配置」添加" />
                        </div>
                        <div>
                            <div style={{ marginBottom: 4, fontSize: 13 }}>生图渠道（建册挂 qwen 车道）</div>
                            <Select value={effectiveImageChannel} onChange={setImageChannelId} disabled={busy} style={{ width: "100%" }}
                                options={imageChannelOptions} placeholder="选择生图渠道" notFoundContent="没有 qwen 渠道，请先到「模型配置」添加" />
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
                                {phase === "outline" ? "正在创作绘本大纲（书名/角色/逐页图文）…" : `逐页画面填充中 ${progress.done}/${progress.total} ${progress.detail ?? ""}`}
                            </div>
                        </div>
                    ) : null}
                    <Space>
                        <Button type="primary" icon={<ThunderboltOutlined />} loading={busy} disabled={!canStart} onClick={() => void start()}>
                            开始拆书
                        </Button>
                        {busy ? <Button onClick={() => abortRef.current?.abort()}>取消</Button> : null}
                        {textModelOptions.length === 0 ? (
                            <span style={{ fontSize: 12, color: "#d46b08" }}>先到「模型配置」给文本渠道（如 DeepSeek）填好 API Key</span>
                        ) : null}
                    </Space>
                </Space>
            ) : (
                <Space direction="vertical" size={12} style={{ width: "100%" }}>
                    <Alert
                        type="success"
                        showIcon
                        icon={<ExperimentOutlined />}
                        message={`《${book?.title}》拆书完成`}
                        description={`将创建画布 storybook-${book?.id}：${STORYBOOK_STYLES[book?.style ?? "watercolor"].label} · 角色 ${book?.cast.length} 个 · ${book?.pages.length} 页（封面+正文+封底）· 旁白 ${nNarration} 页 · 对白 ${nDialogue} 条。带角色的页自动连角色卡（edit-plus 参考锚定），无角色页走 qwen-image-2.1 直出。`}
                    />
                    {error ? <Alert type="error" showIcon message={error} /> : null}
                    {phase === "creating" ? <Progress percent={95} size="small" status="active" /> : null}
                    <Space>
                        <Button type="primary" loading={phase === "creating"} onClick={() => void create()}>创建绘本并打开</Button>
                        <Button onClick={() => { setBook(null); setPhase("form"); }}>返回修改</Button>
                        <Button onClick={close}>取消</Button>
                    </Space>
                    <div style={{ fontSize: 12, opacity: 0.65 }}>
                        建册后流程：绘本成书页审校旁白与对白 → 工具栏「生成缺帧」出图 → 「配音」面板逐页配音（旁白+角色对白）→ 「导出有声视频」。
                    </div>
                </Space>
            )}
        </Modal>
    );
}
