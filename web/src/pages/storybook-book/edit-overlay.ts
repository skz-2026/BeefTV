import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { storybookLineHash } from "@/services/storybook-audio";

// 成书页可编辑字段的写回合同。
// panel-* metadata 只挑 PANEL_EDIT_KEYS 里的可编辑字段做逐字段覆盖——保存撞 409 重拉、
// 生成写回拉最新时，其他会话刚写回的图片引用（content/storageKey/assetId 等）不会被
// 本地旧 metadata 整份抹掉；storybook-config 的 content 仍是整体覆盖。
// 成书页新增可编辑的 panel 字段时必须同步 PANEL_EDIT_KEYS，否则冲突重试会丢该字段。

export type LineAudio = { storageKey: string; url: string; durationMs: number; textHash: string; mimeType?: string; bytes?: number };

const PANEL_EDIT_KEYS = ["panelTitle", "prompt", "narration", "dialogue"] as const;

type EditOverlay = {
    panelMeta: Map<string, Record<string, unknown>>;
    configContent: string | null;
};

export function collectEditOverlay(project: CanvasProject): EditOverlay {
    const panelMeta = new Map<string, Record<string, unknown>>();
    let configContent: string | null = null;
    for (const node of project.nodes) {
        const md = (node.metadata ?? {}) as Record<string, unknown>;
        if (node.id.startsWith("panel-") && node.type === "image") {
            const pick: Record<string, unknown> = {};
            for (const key of PANEL_EDIT_KEYS) if (key in md) pick[key] = md[key];
            if (Object.keys(pick).length) panelMeta.set(node.id, pick);
        } else if (node.id === "storybook-config" && typeof md.content === "string") {
            configContent = md.content;
        }
    }
    return { panelMeta, configContent };
}

export function applyEditOverlay(nodes: CanvasProject["nodes"], overlay: EditOverlay): CanvasProject["nodes"] {
    return nodes.map((node) => {
        const meta = overlay.panelMeta.get(node.id);
        if (meta) return { ...node, metadata: { ...(node.metadata ?? {}), ...meta } };
        if (node.id === "storybook-config" && overlay.configContent) {
            return { ...node, metadata: { ...(node.metadata ?? {}), content: overlay.configContent } };
        }
        return node;
    });
}

export function withPanelMeta(doc: CanvasProject, pid: string, patch: (md: Record<string, unknown>) => Record<string, unknown>): CanvasProject {
    return { ...doc, nodes: doc.nodes.map((node) => (node.id === `panel-${pid}` ? { ...node, metadata: patch({ ...(node.metadata ?? {}) }) } : node)) };
}

/** 行配音是否过期：文字或期望音色变化都会使已存配音失效 */
export function lineAudioStale(audio: LineAudio | undefined, text: string, voice?: string): boolean {
    return !audio || !audio.storageKey || audio.textHash !== storybookLineHash(text, voice);
}
