import { CanvasNodeType, type CanvasMediaPerformanceMode, type CanvasNodeData } from "@/types/canvas";

const STORAGE_KEY = "canvas-media-performance-mode";

// The DOM budget is deliberately below the connection budget. Image-heavy
// canvases pay a texture/compositing profile per mounted card, even when the
// cards themselves are already virtualized spatially.
export const CANVAS_MAX_RENDERED_NODES = 720;
export const CANVAS_MAX_RENDERED_CONNECTIONS = 5000;

export function readCanvasMediaPerformanceMode(): CanvasMediaPerformanceMode {
    try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        return stored === "quality" || stored === "performance" ? stored : "auto";
    } catch {
        return "auto";
    }
}

export function persistCanvasMediaPerformanceMode(mode: CanvasMediaPerformanceMode) {
    try {
        window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
        // 浏览器禁用本地存储时保留当前会话内的选择。
    }
}

export function shouldReduceCanvasMediaEffects(mode: CanvasMediaPerformanceMode, nodes: CanvasNodeData[]) {
    if (mode === "performance") return true;
    if (mode === "quality") return false;
    // 触摸设备默认按低媒体预算渲染：手机屏幕小、解码和带宽都紧张，一屏放不下的大图
    // 没必要提前加载。鼠标设备仍按节点数量决定。
    if (isTouchFirstDevice()) return true;
    const mediaCount = nodes.filter((node) => node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio).length;
    return nodes.length >= 80 || mediaCount >= 32;
}

/** 触摸优先设备：手机、平板，以及带触屏的笔记本。maxTouchPoints 比媒体查询可靠。 */
export function isTouchFirstDevice() {
    if (typeof window === "undefined") return false;
    if (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0) return true;
    return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

export function canvasNodeRenderPadding(reduceMediaEffects: boolean, previouslyRendered: boolean) {
    if (previouslyRendered) return reduceMediaEffects ? 640 : 384;
    return reduceMediaEffects ? 128 : 192;
}

export function canvasNodeRenderBudget(scale: number) {
    if (scale < 0.14) return 280;
    if (scale < 0.28) return 420;
    return CANVAS_MAX_RENDERED_NODES;
}

export function resolveActiveCanvasMediaNodeId(selectedNodeIds: ReadonlySet<string>, nodeById: ReadonlyMap<string, CanvasNodeData>) {
    if (selectedNodeIds.size !== 1) return null;
    const nodeId = selectedNodeIds.values().next().value;
    if (!nodeId) return null;
    const type = nodeById.get(nodeId)?.type;
    return type === CanvasNodeType.Video || type === CanvasNodeType.Audio ? nodeId : null;
}
