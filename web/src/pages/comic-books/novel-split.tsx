import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { App, Alert, Button, Input, Modal, Progress, Select, Space, Tag } from "antd";
import { ExperimentOutlined, FileAddOutlined, ThunderboltOutlined } from "@ant-design/icons";

import { createComicCanvas, splitNovel, type SplitBook } from "@/services/comic-split";
import { useConfigStore } from "@/stores/use-config-store";

type Phase = "form" | "outline" | "fill" | "done" | "creating";

/** 书架页「从小说新建」弹窗：粘贴章节 → 两段式 LLM 拆分 → 一键建册（画布+comic-config），全程界面内完成 */
export function NovelSplitModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { message } = App.useApp();
    const navigate = useNavigate();
    const config = useConfigStore((state) => state.config);
    const [text, setText] = useState("");
    const [bookId, setBookId] = useState("");
    const [frames, setFrames] = useState(36);
    const [model, setModel] = useState("");
    const [imageChannelId, setImageChannelId] = useState("");
    const [phase, setPhase] = useState<Phase>("form");
    const [progress, setProgress] = useState<{ done: number; total: number; detail?: string }>({ done: 0, total: 1 });
    const [book, setBook] = useState<SplitBook | null>(null);
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
    const canStart = text.trim().length > 200 && /^[a-z0-9-]+$/i.test(bookId.trim()) && !!effectiveModel && !!effectiveImageChannel;
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
            const result = await splitNovel({
                config: { ...channel, apiFormat: channel.apiFormat ?? "openai" } as never,
                model: modelName,
                chapterText: text.trim(),
                bookId: bookId.trim(),
                frames,
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
            const canvasId = await createComicCanvas(book, effectiveImageChannel);
            message.success(`《${book.chapter}》建册完成，跳转成书页`);
            onClose();
            navigate(`/comic-book/${encodeURIComponent(canvasId)}`);
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

    const nDialogue = book?.panels.reduce((n, p) => n + p.dialogue.length, 0) ?? 0;

    return (
        <Modal
            open={open}
            onCancel={close}
            title={<Space><FileAddOutlined /> 从小说新建漫画集</Space>}
            width={720}
            footer={null}
            destroyOnHidden
        >
            {phase === "form" || phase === "outline" || phase === "fill" ? (
                <Space direction="vertical" size={12} style={{ width: "100%" }}>
                    <div>
                        <div style={{ marginBottom: 4, fontSize: 13 }}>章节原文（粘贴小说一章，建议 3000-8000 字）</div>
                        <Input.TextArea
                            rows={9}
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                            placeholder="子时三刻，万籁俱寂。沈映书盘膝坐在父亲的书桌前……"
                            disabled={busy}
                        />
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                        <div>
                            <div style={{ marginBottom: 4, fontSize: 13 }}>书 ID（英文，画布将建为 manhua-此ID）</div>
                            <Input value={bookId} onChange={(e) => setBookId(e.target.value)} placeholder="meng-ch03" disabled={busy} />
                        </div>
                        <div>
                            <div style={{ marginBottom: 4, fontSize: 13 }}>目标帧数</div>
                            <Select value={frames} onChange={setFrames} disabled={busy} style={{ width: "100%" }}
                                options={[16, 24, 36, 48].map((n) => ({ value: n, label: `${n} 帧左右` }))} />
                        </div>
                        <div>
                            <div style={{ marginBottom: 4, fontSize: 13 }}>拆分模型（文本渠道）</div>
                            <Select value={effectiveModel} onChange={setModel} disabled={busy} style={{ width: "100%" }}
                                options={textModelOptions} placeholder="选择文本模型" notFoundContent="没有可用文本渠道，请先到「模型配置」添加" />
                        </div>
                    </div>
                    {imageChannelOptions.length > 1 ? (
                        <div>
                            <div style={{ marginBottom: 4, fontSize: 13 }}>生图渠道（建册挂 qwen 车道）</div>
                            <Select value={effectiveImageChannel} onChange={setImageChannelId} disabled={busy} style={{ width: 280 }}
                                options={imageChannelOptions} />
                        </div>
                    ) : null}
                    {error ? <Alert type="error" showIcon message={error} /> : null}
                    {busy ? (
                        <div>
                            <Progress
                                percent={phase === "outline" ? 8 : Math.round((progress.done / Math.max(1, progress.total)) * 92) + 8}
                                size="small"
                            />
                            <div style={{ fontSize: 12, opacity: 0.7 }}>
                                {phase === "outline" ? "正在生成分镜大纲（页型/帧/角色）…" : `逐页填充中 ${progress.done}/${progress.total} ${progress.detail ?? ""}`}
                            </div>
                        </div>
                    ) : null}
                    <Space>
                        <Button type="primary" icon={<ThunderboltOutlined />} loading={busy} disabled={!canStart} onClick={() => void start()}>
                            开始拆分
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
                        message={`《${book?.chapter}》拆分完成`}
                        description={`将创建画布 manhua-${book?.id}：角色卡 ${book?.cast.length} 张 · ${book?.pages.length} 页（含扉页）· ${book?.panels.length} 帧 · 台词 ${nDialogue} 条。带角色的帧自动连角色卡（edit-plus 参考锚定），空镜走 qwen-image-2.1 直出。`}
                    />
                    {error ? <Alert type="error" showIcon message={error} /> : null}
                    {phase === "creating" ? <Progress percent={95} size="small" status="active" /> : null}
                    <Space>
                        <Button type="primary" loading={phase === "creating"} onClick={() => void create()}>创建成书并打开</Button>
                        <Button onClick={() => { setBook(null); setPhase("form"); }}>返回修改</Button>
                        <Button onClick={close}>取消</Button>
                    </Space>
                    <div style={{ fontSize: 12, opacity: 0.65 }}>
                        建册后流程：成书页审校台词/版式 → 工具栏「生成缺帧」出图 → 满意帧可接 comic-hd 超分。
                    </div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {(book?.pages ?? []).slice(1, 7).map((p, i) => (
                            <Tag key={i}>{p.type === "grid" ? `${i + 2}页·${p.layout}` : `${i + 2}页·${p.type}`}</Tag>
                        ))}
                        {(book?.pages.length ?? 0) > 7 ? <Tag>+{book!.pages.length - 7} 页</Tag> : null}
                    </div>
                </Space>
            )}
        </Modal>
    );
}
