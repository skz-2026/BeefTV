import { useCallback, useEffect, useState } from "react";
import { App, Button, Input, Progress, Space, Tabs, Tag, Upload } from "antd";
import { AudioOutlined, PictureOutlined, SearchOutlined, ThunderboltOutlined } from "@ant-design/icons";

import { AppModal } from "@/components/ui/product/app-modal/app-modal";
import { http } from "@/services/api/request";
import { resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import { listWorkspaceAssetsPage } from "@/services/api/workspace-assets";
import { runCanvasImageTask } from "@/services/digital-human-media";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

// 素材选择器：资产库挑选 / 提示词实时生成（产物自动注册进资产库，下次直接选）/ 上传兜底。
// 解决"每次都要重新上传"的问题——画布式体验：生成即入库，跨期复用。

type PickerAsset = {
    id: string;
    title?: string;
    coverUrl?: string;
    data?: { storageKey?: string; durationMs?: number; width?: number; height?: number };
};

export type AssetPick = { storageKey: string; name: string };

type Props = {
    open: boolean;
    kind: "image" | "audio";
    title: string;
    projectId: string;
    /** 图片生成模型（channelId::qwen-image-2.1）；音频无生成页签 */
    imageModel?: string;
    genSize?: string;
    onClose: () => void;
    onPick: (pick: AssetPick) => void;
};

const PAGE_SIZE = 24;

export function AssetPickerModal({ open, kind, title, projectId, imageModel, genSize, onClose, onPick }: Props) {
    const { message } = App.useApp();
    const [tab, setTab] = useState("library");
    const [query, setQuery] = useState("");
    const [assets, setAssets] = useState<PickerAsset[] | null>(null);
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);
    const [prompt, setPrompt] = useState("");
    const [generating, setGenerating] = useState(false);
    const [uploading, setUploading] = useState(false);

    const load = useCallback(async (p: number, q: string) => {
        try {
            const res = await listWorkspaceAssetsPage({ page: p, pageSize: PAGE_SIZE, kind, query: q || undefined });
            setAssets(res.assets as PickerAsset[]);
            setTotal(res.total);
        } catch {
            setAssets([]);
            setTotal(0);
        }
    }, [kind]);

    useEffect(() => {
        if (!open) return;
        setTab("library");
        setAssets(null);
        setPage(1);
        void load(1, "");
    }, [open, load]);

    const storageKeyOf = (a: PickerAsset): string => {
        const key = a.data?.storageKey;
        if (key) return key;
        const m = (a.coverUrl ?? "").match(/\/resources\/([^/]+)\/file/);
        return m ? `resource:${m[1]}` : "";
    };

    const pick = (a: PickerAsset) => {
        const key = storageKeyOf(a);
        if (!key) { message.error("该素材缺少资源引用"); return; }
        onPick({ storageKey: key, name: a.title || (kind === "image" ? "asset.png" : "asset.wav") });
        onClose();
    };

    /** 生成并注册进资产库（generated-assets 通道提交 asset 记录，不动节点） */
    const generate = async () => {
        if (!imageModel || !prompt.trim()) return;
        setGenerating(true);
        try {
            const result = await runCanvasImageTask({
                projectId,
                model: imageModel,
                prompt: prompt.trim(),
                size: genSize || "960x960",
                nodeId: `asset-picker-${Date.now()}`,
            });
            // 注册到资产库：拉最新画布，仅附 asset 记录
            for (let attempt = 0; attempt < 3; attempt++) {
                const fresh = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(projectId)}`);
                const now = new Date().toISOString();
                const assetId = "generation_" + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
                const asset = {
                    id: assetId,
                    kind: "image",
                    category: "material",
                    status: "ready",
                    primaryVersionId: crypto.randomUUID().replace(/-/g, ""),
                    title: prompt.trim().slice(0, 24),
                    createdAt: now,
                    updatedAt: now,
                    coverUrl: `/api/resources/${result.resourceId}/file`,
                    source: "generation-task",
                    data: { bytes: result.bytes ?? 0, dataUrl: `/api/resources/${result.resourceId}/file`, height: result.height ?? 0, mimeType: "image/png", storageKey: `resource:${result.resourceId}`, width: result.width ?? 0 },
                    metadata: { generationEffectKey: `dh-picker:${now}`, outputIndex: 0, source: "generation-task" },
                    tags: [],
                };
                try {
                    await http.put(`/canvas-projects/${encodeURIComponent(projectId)}/generated-assets`, { project: fresh.project, assets: [asset] });
                    break;
                } catch { /* revision 冲突重试 */ }
            }
            message.success("已生成并入库");
            onPick({ storageKey: resourceStorageKey(result.resourceId), name: prompt.trim().slice(0, 24) });
            onClose();
        } catch (error) {
            message.error(`生成失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setGenerating(false);
        }
    };

    const uploadFile = async (file: File) => {
        setUploading(true);
        try {
            const res = await uploadResourceFile(file, kind, { fileName: file.name });
            onPick({ storageKey: resourceStorageKey(res.id), name: file.name });
            onClose();
        } catch (error) {
            message.error(`上传失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setUploading(false);
        }
        return false;
    };

    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    return (
        <AppModal open={open} onCancel={onClose} title={title} width={720} footer={null}>
            <Tabs
                activeKey={tab}
                onChange={(k) => setTab(k)}
                items={[
                    {
                        key: "library",
                        label: `资产库（${total}）`,
                        children: (
                            <div>
                                <Space.Compact style={{ width: "100%", marginBottom: 10 }}>
                                    <Input prefix={<SearchOutlined />} value={query} placeholder="搜索素材标题" allowClear
                                        onChange={(e) => setQuery(e.target.value)}
                                        onPressEnter={() => { setPage(1); void load(1, query); }} />
                                    <Button type="primary" onClick={() => { setPage(1); void load(1, query); }}>搜索</Button>
                                </Space.Compact>
                                {assets === null ? <div style={{ padding: 24, textAlign: "center", opacity: 0.6 }}>加载中…</div> : null}
                                {assets !== null && assets.length === 0 ? (
                                    <div style={{ padding: 24, textAlign: "center", opacity: 0.6 }}>
                                        资产库还没有{kind === "image" ? "图片" : "音频"}素材——去「生成」页签现做一张，会自动入库供下次选择。
                                    </div>
                                ) : null}
                                {kind === "image" ? (
                                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 10, maxHeight: "46vh", overflowY: "auto" }}>
                                        {(assets ?? []).map((a) => {
                                            const key = storageKeyOf(a);
                                            const src = key ? `/api/resources/${key.replace(/^resource:/, "")}/file` : a.coverUrl;
                                            return (
                                                <button type="button" key={a.id} onClick={() => pick(a)} className="cursor-interaction"
                                                    style={{ border: "1px solid var(--user-border, var(--border))", background: "transparent", borderRadius: 10, overflow: "hidden", padding: 0, cursor: "pointer", textAlign: "left" }}>
                                                    <span style={{ display: "block", aspectRatio: "1", background: "var(--user-fill, rgba(128,128,128,.1))" }}>
                                                        {src ? <img src={src} alt={a.title ?? ""} loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}
                                                    </span>
                                                    <span style={{ display: "block", padding: "4px 8px", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.title ?? "未命名"}</span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                ) : (
                                    <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: "46vh", overflowY: "auto" }}>
                                        {(assets ?? []).map((a) => (
                                            <button type="button" key={a.id} onClick={() => pick(a)} className="cursor-interaction"
                                                style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--user-border, var(--border))", background: "transparent", borderRadius: 10, padding: "8px 12px", cursor: "pointer", textAlign: "left" }}>
                                                <AudioOutlined style={{ opacity: 0.6 }} />
                                                <span style={{ flex: 1, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.title ?? a.id}</span>
                                                {a.data?.durationMs ? <Tag>{(a.data.durationMs / 1000).toFixed(1)}s</Tag> : null}
                                                <span style={{ fontSize: 12, color: "var(--primary, #4f7cff)" }}>选择</span>
                                            </button>
                                        ))}
                                    </div>
                                )}
                                {pages > 1 ? (
                                    <Space style={{ marginTop: 10, justifyContent: "center", width: "100%" }}>
                                        <Button size="small" disabled={page <= 1} onClick={() => { const p = page - 1; setPage(p); void load(p, query); }}>上一页</Button>
                                        <span style={{ fontSize: 12, opacity: 0.7 }}>{page} / {pages}</span>
                                        <Button size="small" disabled={page >= pages} onClick={() => { const p = page + 1; setPage(p); void load(p, query); }}>下一页</Button>
                                    </Space>
                                ) : null}
                            </div>
                        ),
                    },
                    ...(kind === "image" && imageModel ? [{
                        key: "generate",
                        label: "生成",
                        children: (
                            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                                <Input.TextArea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)}
                                    placeholder="描述想要的画面，例如：造纸工坊内景，木桌上摊着湿纸，暖光（生成后自动入库，可直接选用）" disabled={generating} />
                                <div>
                                    <Button type="primary" icon={<ThunderboltOutlined />} loading={generating} disabled={!prompt.trim()} onClick={() => void generate()}>
                                        生成图片（{genSize ?? "960x960"}）
                                    </Button>
                                </div>
                                {generating ? <Progress percent={70} size="small" status="active" /> : null}
                                <div style={{ fontSize: 12, opacity: 0.6 }}>走 {imageModel.split("::").pop()} 车道，生成结果自动注册进资产库，下次任何项目直接选。</div>
                            </div>
                        ),
                    }] : []),
                    {
                        key: "upload",
                        label: "上传",
                        children: (
                            <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "flex-start" }}>
                                <Upload accept={kind === "image" ? "image/*" : "audio/*"} showUploadList={false}
                                    beforeUpload={(file) => { void uploadFile(file as File); return false; }} disabled={uploading}>
                                    <Button icon={kind === "image" ? <PictureOutlined /> : <AudioOutlined />} loading={uploading}>
                                        选择本地{kind === "image" ? "图片" : "音频"}上传
                                    </Button>
                                </Upload>
                                <div style={{ fontSize: 12, opacity: 0.6 }}>上传后同样进资产库，之后无需重复上传。</div>
                            </div>
                        ),
                    },
                ]}
            />
        </AppModal>
    );
}
