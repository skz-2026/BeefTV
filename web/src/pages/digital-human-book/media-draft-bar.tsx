import { Button, Image, Space } from "antd";
import { CheckOutlined, CloseOutlined } from "@ant-design/icons";

// 生成草稿预览条：页面内所有「提示词生成」（人物形象/场景图/站位首帧/参考图/配音/音色试听）
// 先进草稿态——预览满意点「使用」才写画布，不满意丢弃或改提示词重生成。量产批量链路不走此层。

export type MediaDraft = {
    id: string;
    kind: "image" | "audio";
    url: string;
    label: string;
    detail?: string;
    payload: { type: string } & Record<string, unknown>;
};

export function MediaDraftBar({ draft, busy, onUse, onDiscard }: {
    draft: MediaDraft | null;
    busy?: boolean;
    onUse: () => void;
    onDiscard: () => void;
}) {
    if (!draft) return null;
    return (
        <div style={{ position: "absolute", left: "50%", bottom: 18, transform: "translateX(-50%)", zIndex: 40, maxWidth: "min(92%, 760px)", width: "max-content" }}>
            <div
                role="status"
                style={{
                    display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderRadius: 12,
                    border: "1px solid var(--user-border, var(--border))",
                    background: "var(--card, #1a1d22)", boxShadow: "0 12px 40px rgba(0,0,0,.4)",
                    flexWrap: "wrap",
                }}
            >
                {draft.kind === "image" ? (
                    <Image src={draft.url} alt={draft.label} preview={{ mask: "放大" }} style={{ width: 60, height: 60, objectFit: "cover", borderRadius: 8, border: "1px solid var(--user-border, var(--border))" }} />
                ) : (
                    // eslint-disable-next-line jsx-a11y/media-has-caption
                    <audio src={draft.url} controls style={{ height: 36, width: 250 }} />
                )}
                <div style={{ minWidth: 110, maxWidth: 280 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{draft.label}</div>
                    {draft.detail ? <div style={{ fontSize: 12, opacity: 0.65, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2 }}>{draft.detail}</div> : null}
                </div>
                <Space size={6}>
                    <Button type="primary" size="small" icon={<CheckOutlined />} disabled={busy} onClick={onUse}>使用</Button>
                    <Button size="small" icon={<CloseOutlined />} onClick={onDiscard}>丢弃</Button>
                </Space>
            </div>
        </div>
    );
}
