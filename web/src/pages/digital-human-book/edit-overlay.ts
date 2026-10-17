import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

// 口播生产页可编辑字段的写回合同（与绘本成书 edit-overlay 同一模式）。
// seg-* / scene-* metadata 只挑可编辑/嵌套引用字段做逐字段覆盖——保存撞 409 重拉、
// 生成写回拉最新时，其他会话刚写回的顶层媒体引用（content/storageKey/assetId 等）
// 不会被本地旧 metadata 整份抹掉；digitalhuman-config 的 content 仍是整体覆盖。
// 生产页新增可编辑的 seg/scene 字段时必须同步 SEG_EDIT_KEYS / SCENE_EDIT_KEYS。

const SEG_EDIT_KEYS = ["line", "expression", "action", "camera", "sceneKey", "secondsHint", "videoPrompt", "extraRefs", "cards", "audio", "videoResourceId", "videoDurationMs", "videoLineHash", "takes"] as const;
const SCENE_EDIT_KEYS = ["sceneName", "promptEn", "frameStorageKey"] as const;

type EditOverlay = {
    segMeta: Map<string, Record<string, unknown>>;
    sceneMeta: Map<string, Record<string, unknown>>;
    configContent: string | null;
};

export function collectEditOverlay(project: CanvasProject): EditOverlay {
    const segMeta = new Map<string, Record<string, unknown>>();
    const sceneMeta = new Map<string, Record<string, unknown>>();
    let configContent: string | null = null;
    for (const node of project.nodes) {
        const md = (node.metadata ?? {}) as Record<string, unknown>;
        if (node.type === "video" && node.id.startsWith("seg-")) {
            const pick: Record<string, unknown> = {};
            for (const key of SEG_EDIT_KEYS) if (key in md) pick[key] = md[key];
            if (Object.keys(pick).length) segMeta.set(node.id, pick);
        } else if (node.type === "image" && node.id.startsWith("scene-")) {
            const pick: Record<string, unknown> = {};
            for (const key of SCENE_EDIT_KEYS) if (key in md) pick[key] = md[key];
            if (Object.keys(pick).length) sceneMeta.set(node.id, pick);
        } else if (node.id === "digitalhuman-config" && typeof md.content === "string") {
            configContent = md.content;
        }
    }
    return { segMeta, sceneMeta, configContent };
}

export function applyEditOverlay(nodes: CanvasProject["nodes"], overlay: EditOverlay): CanvasProject["nodes"] {
    return nodes.map((node) => {
        const meta = overlay.segMeta.get(node.id) ?? overlay.sceneMeta.get(node.id);
        if (meta) return { ...node, metadata: { ...(node.metadata ?? {}), ...meta } };
        if (node.id === "digitalhuman-config" && overlay.configContent) {
            return { ...node, metadata: { ...(node.metadata ?? {}), content: overlay.configContent } };
        }
        return node;
    });
}

export function withNodeMeta(doc: CanvasProject, nodeId: string, patch: (md: Record<string, unknown>) => Record<string, unknown>): CanvasProject {
    return { ...doc, nodes: doc.nodes.map((node) => (node.id === nodeId ? { ...node, metadata: patch({ ...(node.metadata ?? {}) }) } : node)) };
}
