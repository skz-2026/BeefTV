import { explainGenerationError } from "@/lib/generation-error";
import type { GenerationTask } from "@/services/api/task-center";
import type { CanvasNodeData, CanvasNodeMetadata } from "@/types/canvas";

export function isDepthCaptureResultNode(node: CanvasNodeData) {
    return Boolean(node.metadata?.depthSourceNodeId);
}

export function canRecoverOrRetryDepthCapture(node: CanvasNodeData) {
    return isDepthCaptureResultNode(node) && ["failed", "cancelled", "succeeded"].includes(node.metadata?.taskStatus || "");
}

export function findDepthCaptureSourceNode(node: CanvasNodeData, nodes: CanvasNodeData[]) {
    const sourceNodeId = node.metadata?.depthSourceNodeId;
    return sourceNodeId ? nodes.find((candidate) => candidate.id === sourceNodeId) : undefined;
}

export function depthCaptureTaskMetadata(task: GenerationTask): CanvasNodeMetadata {
    const active = task.status === "queued" || task.status === "running";
    return {
        taskId: task.id,
        taskStatus: task.status,
        taskStage: task.stage,
        taskProgress: task.progress,
        taskProvider: task.provider,
        taskErrorCode: task.errorCode,
        taskOfficialStatus: task.officialStatus,
        generationErrorCode: undefined,
        model: task.model,
        taskProviderRequestId: task.providerRequestId,
        taskFailureDiagnostics: task.failureDiagnostics,
        taskCreatedAt: task.createdAt,
        taskUpdatedAt: task.updatedAt,
        taskCompletedAt: task.completedAt,
        generationErrorSummary: task.error,
        processingLabel: task.stage || "正在生成深度视频",
        ...(active ? { status: "loading", errorDetails: undefined } : {}),
    };
}

export function depthCaptureWaitFailureMetadata(error: unknown, observed?: GenerationTask | string): CanvasNodeMetadata {
    const task = typeof observed === "object" ? observed : undefined;
    if (typeof observed === "string" || task?.status === "queued" || task?.status === "running") {
        return { status: "loading", errorDetails: undefined, taskClientOperationTerminal: undefined, processingLabel: "暂时无法同步进度，请重新打开画布查看任务状态" };
    }
    return { status: "error", errorDetails: task?.error || (error instanceof Error ? error.message : typeof error === "string" ? error : "深度处理失败"), taskClientOperationTerminal: task?.status === "failed" || task?.status === "cancelled" };
}

export function canvasNodeFailureExplanation(node: CanvasNodeData) {
    const explanation = explainGenerationError({ code: node.metadata?.generationErrorCode || node.metadata?.taskErrorCode, message: node.metadata?.errorDetails }, { taskId: node.metadata?.taskId, model: node.metadata?.model, createdAt: node.metadata?.taskCreatedAt, stage: node.metadata?.taskStage });
    if (!canRecoverOrRetryDepthCapture(node)) return explanation;
    if (node.metadata?.taskStatus === "succeeded") {
        return { ...explanation, reason: "深度视频已生成，暂时未能显示在画布上", action: "点击「恢复结果」重新加载原任务", uncertain: false, retryable: true, blockAutomaticRetry: false };
    }
    return {
        ...explanation,
        ...(["unknown", "download_failed", "submission_uncertain"].includes(explanation.category) ? { reason: "深度处理失败", action: "请查看详情，检查深度组件和网络后重试" } : {}),
        uncertain: false,
        retryable: true,
        blockAutomaticRetry: false,
    };
}
