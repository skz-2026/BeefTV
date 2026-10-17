import { isCanvasRevisionConflict } from "@/services/canvas-revision-conflict";

export class CanvasGenerationDurableAckError extends Error {
    readonly code: "canvas_conflict" | "result_apply_failed";
    readonly cause: unknown;

    constructor(cause: unknown) {
        super(isCanvasRevisionConflict(cause) ? "生成结果已保留，画布尚未更新" : "生成结果已保留，还没放回画布");
        this.name = "CanvasGenerationDurableAckError";
        this.code = isCanvasRevisionConflict(cause) ? "canvas_conflict" : "result_apply_failed";
        this.cause = cause;
    }
}

export class CanvasGenerationMaterializationError extends Error {
    readonly code = "download_failed";
    readonly cause: unknown;

    constructor(cause?: unknown) {
        super("生成结果还没取回，可以继续取回");
        this.name = "CanvasGenerationMaterializationError";
        this.cause = cause;
    }
}

export class CanvasGenerationTargetSaveError extends Error {
    constructor(cause?: unknown, message = "画布尚未保存，未开始生成。请先处理画布保存提示后重试。") {
        super(message, { cause });
        this.name = "CanvasGenerationTargetSaveError";
    }
}
