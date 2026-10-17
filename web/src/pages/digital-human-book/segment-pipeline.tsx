import { Tooltip } from "antd";
import { CheckCircleOutlined, ExclamationCircleOutlined, LoadingOutlined, MinusCircleOutlined } from "@ant-design/icons";
import type { ReactNode } from "react";

// 当前段的镜头流水线：台词 → 配音 → 场景图 → 站位首帧 → 段视频。
// 画布里靠节点连线能看懂依赖，生产页用这条状态链补齐同样的认知：
// 绿=就绪、橙=过期待重做、灰=未生成、半透明=上游缺失。点未就绪步骤直接
// 触发生成（走底部草稿预览，满意才落库）；点就绪步骤试听/看图/直达对应面板。

export type PipelineStepStatus = "done" | "stale" | "todo" | "blocked";

export type PipelineStep = {
    key: string;
    label: string;
    icon: ReactNode;
    status: PipelineStepStatus;
    /** 状态短语（如 "26 字"/"4.7s"/"未生成"），常显在步骤下方 */
    statusText: string;
    tooltip: string;
    loading?: boolean;
    disabled?: boolean;
    onAction?: () => void;
};

const STATUS_COLOR: Record<PipelineStepStatus, string> = {
    done: "#52c41a",
    stale: "#faad14",
    todo: "var(--muted, #8b929e)",
    blocked: "var(--muted, #8b929e)",
};

function statusMark(step: PipelineStep): ReactNode {
    if (step.loading) return <LoadingOutlined spin style={{ color: "var(--ant-color-primary, #4f7cff)" }} />;
    if (step.status === "done") return <CheckCircleOutlined style={{ color: STATUS_COLOR.done }} />;
    if (step.status === "stale") return <ExclamationCircleOutlined style={{ color: STATUS_COLOR.stale }} />;
    return <MinusCircleOutlined style={{ opacity: 0.4 }} />;
}

export function SegmentPipeline({ title, hint, steps }: { title: string; hint?: string; steps: PipelineStep[] }) {
    return (
        <div style={{ border: "1px solid var(--user-border, var(--border))", borderRadius: 10, padding: "8px 10px 10px", marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{title}</span>
                {hint ? <span style={{ fontSize: 11, opacity: 0.55 }}>{hint}</span> : null}
            </div>
            <div style={{ display: "flex", alignItems: "stretch", gap: 4 }}>
                {steps.map((step, i) => (
                    <div key={step.key} style={{ display: "flex", alignItems: "stretch", flex: 1, minWidth: 0 }}>
                        <Tooltip title={step.tooltip}>
                            <button
                                type="button"
                                aria-label={`${step.label}：${step.statusText}`}
                                onClick={step.onAction}
                                disabled={step.disabled}
                                style={{
                                    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-start",
                                    gap: 2, flex: 1, minWidth: 52, padding: "6px 3px", borderRadius: 8, cursor: step.disabled ? "not-allowed" : "pointer",
                                    border: `1px solid ${step.status === "done" ? "rgba(82,196,26,.45)" : step.status === "stale" ? "rgba(250,173,20,.5)" : "var(--user-border, var(--border))"}`,
                                    background: step.status === "done" ? "rgba(82,196,26,.08)" : step.status === "stale" ? "rgba(250,173,20,.08)" : "transparent",
                                    opacity: step.disabled ? 0.45 : 1,
                                    textAlign: "center",
                                }}
                            >
                                <span style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 13, color: STATUS_COLOR[step.status] }}>{step.icon}{statusMark(step)}</span>
                                <span style={{ fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}>{step.label}</span>
                                <span style={{ fontSize: 10, opacity: 0.7, lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>{step.statusText}</span>
                            </button>
                        </Tooltip>
                        {i < steps.length - 1 ? (
                            <span aria-hidden style={{ alignSelf: "center", color: "var(--muted, #8b929e)", fontSize: 10, padding: "0 1px", flex: "none" }}>→</span>
                        ) : null}
                    </div>
                ))}
            </div>
        </div>
    );
}
