import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { App, AutoComplete, Button, Input, Progress, Segmented, Select, Skeleton, Space, Tag, Tooltip } from "antd";
import { ArrowLeftOutlined, AudioOutlined, BookOutlined, DeleteOutlined, DownOutlined, DownloadOutlined, LoadingOutlined, PlusOutlined, RedoOutlined, ReloadOutlined, SaveOutlined, SoundOutlined, StopOutlined, ThunderboltOutlined, UndoOutlined, UpOutlined, VideoCameraOutlined } from "@ant-design/icons";

import { http } from "@/services/api/request";
import { createZip } from "@/lib/zip";
import { audioSpeechProfile } from "@/lib/audio-generation";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { resolveModelRequestConfig, useConfigStore } from "@/stores/use-config-store";
import { defaultStorybookAudioModel, fetchVoiceforgeVoices, isVoiceforgeModel, storybookAudioModelOptions, synthesizeStorybookLine, VOICEFORGE_FALLBACK_VOICES, type StorybookVoice } from "@/services/storybook-audio";
import { exportStorybookVideo, type StorybookVideoProgress } from "@/services/storybook-video";
import { applyEditOverlay, collectEditOverlay, lineAudioStale, withPanelMeta, type LineAudio } from "./edit-overlay";

// ---------- 绘本数据合同（画布节点承载） ----------
// storybook-config 文本节点 content：{ kind, title, subtitle, style, pageEnd, audio?, castVoices?, pages }
// panel-* 图片节点：metadata.narration = { text, audio? }，metadata.dialogue = [{ speaker, name, text, audio? }]
// 音频引用放在嵌套字段，顶层 storageKey/content 仍是图片本体（canvas_asset_guard 只校验顶层媒体引用）。
type DialogueLine = { speaker: string; name: string; text: string; audio?: LineAudio; /** 气泡在整页图上的归一化位置（缺失时按序自动摆放） */ x?: number; y?: number; w?: number; tail?: "bl" | "br" };

/** 无坐标对白的默认气泡摆放：两句左右交替、超过两行下移 */
function dialogueBubbleDefaults(index: number): { x: number; y: number; w: number; tail: "bl" | "br" } {
    return { x: index % 2 === 0 ? 0.06 : 0.52, y: 0.08 + Math.floor(index / 2) * 0.26, w: 0.42, tail: index % 2 === 0 ? "bl" : "br" };
}
type PanelNarration = { text: string; audio?: LineAudio };
type StorybookPage = { type: "cover" | "full" | "end"; panel?: string };
type StorybookAudioConfig = { model: string; narratorVoice: string; narratorInstructions: string; speed: string };
type StorybookConfig = {
    kind: "storybook-config";
    title: string;
    subtitle: string;
    style?: string;
    pageEnd: string;
    audio?: StorybookAudioConfig;
    castVoices?: Record<string, { voice: string; instructions: string }>;
    pages: StorybookPage[];
};
type PanelNode = {
    id: string;
    title: string;
    imageSrc: string | null;
    narration: PanelNarration;
    dialogue: DialogueLine[];
    nodeIndex: number;
    /** 生成合同（从节点 metadata 与连线解析），供重摇 */
    model: string;
    size: string;
    prompt: string;
    refStorageKeys: Array<{ storageKey: string; name: string }>;
};
type CastInfo = { key: string; name: string };

const DEFAULT_NARRATOR_INSTRUCTIONS = "温柔亲切的讲读者，像在给孩子讲睡前故事，语速平缓，吐字清晰";

const PAGE_GEOMETRY = {
    portrait: { w: 1654, h: 2339, textRatio: 0.24 },
    square: { w: 1654, h: 1654, textRatio: 0.22 },
} as const;
type Orientation = keyof typeof PAGE_GEOMETRY;
const PAPER = "#fbf6ec";
const INK = "#3a2f28";

function parseStorybook(canvas: CanvasProject): { config: StorybookConfig | null; panels: Map<string, PanelNode>; cast: CastInfo[] } {
    const castStorage = new Map<string, string>();
    const cast: CastInfo[] = [];
    for (const node of canvas.nodes) {
        const md = (node.metadata ?? {}) as Record<string, unknown>;
        if (node.id.startsWith("cast-")) {
            const key = node.id.slice("cast-".length);
            cast.push({ key, name: String(node.title ?? key).replace(/^角色卡·/, "") });
            if (typeof md.storageKey === "string") castStorage.set(node.id, md.storageKey);
        }
    }
    const panelRefs = new Map<string, string[]>();
    for (const conn of canvas.connections ?? []) {
        if (!conn.toNodeId?.startsWith("panel-")) continue;
        const list = panelRefs.get(conn.toNodeId) ?? [];
        if (conn.fromNodeId?.startsWith("cast-")) list.push(conn.fromNodeId);
        panelRefs.set(conn.toNodeId, list);
    }
    const panels = new Map<string, PanelNode>();
    let config: StorybookConfig | null = null;
    let index = 0;
    for (const node of canvas.nodes) {
        const nodeIndex = index++;
        const md = (node.metadata ?? {}) as Record<string, unknown>;
        if (node.type === "text" && node.id === "storybook-config") {
            try {
                const parsed = JSON.parse(String(md.content ?? "{}"));
                if (parsed?.kind === "storybook-config") config = parsed as StorybookConfig;
            } catch { /* 配置损坏时按无绘本处理 */ }
            continue;
        }
        if (node.type === "image" && node.id.startsWith("panel-")) {
            const pid = node.id.slice("panel-".length);
            const refs = panelRefs.get(node.id) ?? [];
            const rawNarration = (md.narration ?? {}) as { text?: string; audio?: LineAudio };
            panels.set(pid, {
                id: pid,
                title: String(md.panelTitle ?? node.title ?? pid),
                imageSrc: typeof md.content === "string" && md.content.startsWith("/api/") ? md.content : null,
                narration: { text: String(rawNarration.text ?? ""), ...(rawNarration.audio ? { audio: rawNarration.audio } : {}) },
                dialogue: Array.isArray(md.dialogue) ? (md.dialogue as DialogueLine[]).filter((d) => d && typeof d.text === "string") : [],
                nodeIndex,
                model: String(md.model ?? ""),
                size: String(md.size ?? "1152x1536"),
                prompt: String(md.prompt ?? ""),
                refStorageKeys: refs
                    .map((castId) => castStorage.get(castId))
                    .filter((key): key is string => !!key)
                    .map((key, i) => ({ storageKey: key, name: `ref-${i}.png` })),
            });
        }
    }
    if (config && !config.audio) {
        config.audio = { model: "", narratorVoice: "alloy", narratorInstructions: DEFAULT_NARRATOR_INSTRUCTIONS, speed: "0.9" };
    }
    return { config, panels, cast };
}

// ---------- 页面 ----------
type TaskSummary = { id: string; status: string; resultJson?: string | null; error?: string | null };
type AudioTarget = { kind: "narration" } | { kind: "dialogue"; index: number };

export default function StorybookBookPage() {
    const { id } = useParams();
    const navigate = useNavigate();
    const { message, modal } = App.useApp();
    const globalConfig = useConfigStore((state) => state.config);
    const [canvas, setCanvas] = useState<CanvasProject | null>(null);
    const [loading, setLoading] = useState(true);
    const [pageIndex, setPageIndex] = useState(0);
    const [rightTab, setRightTab] = useState<"lines" | "panel" | "audio" | "book">("lines");
    const [regenerating, setRegenerating] = useState<Map<string, string>>(new Map());
    const cancelRegenRef = useRef(new Set<string>());
    const batchStopRef = useRef(false);
    const [batching, setBatching] = useState<{ done: number; total: number; current: string } | null>(null);
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [exporting, setExporting] = useState<{ done: number; total: number } | null>(null);
    const [exportingVideo, setExportingVideo] = useState<StorybookVideoProgress | null>(null);
    const videoAbortRef = useRef<AbortController | null>(null);
    const [dubbing, setDubbing] = useState<{ done: number; total: number; current: string } | null>(null);
    /** 单行合成中的行标识（`${pid}:narration` / `${pid}:dlg:${i}`），驱动行级按钮 loading */
    const [dubbingLine, setDubbingLine] = useState<string | null>(null);
    const dubStopRef = useRef(false);
    const playingRef = useRef<HTMLAudioElement | null>(null);
    // 撤销/重做：栈存"每次编辑前"的文档快照；mergeKey 合并连续编辑（600ms 同一目标）
    const historyRef = useRef<{ stack: CanvasProject[]; ptr: number; lastKey: string; lastAt: number }>({ stack: [], ptr: -1, lastKey: "", lastAt: 0 });
    const [, setHistoryVersion] = useState(0);
    const canvasRef = useRef<CanvasProject | null>(null);
    canvasRef.current = canvas;

    const load = useCallback(async () => {
        if (!id) return;
        setLoading(true);
        try {
            const res = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`);
            suppressHistoryRef.current = true;
            setCanvas(res.project);
            setDirty(false);
            historyRef.current = { stack: [res.project], ptr: 0, lastKey: "", lastAt: 0 };
        } catch (error) {
            message.error(`读取画布失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setLoading(false);
        }
    }, [id, message]);

    useEffect(() => { void load(); }, [load]);

    const parsed = useMemo(() => (canvas ? parseStorybook(canvas) : { config: null, panels: new Map<string, PanelNode>(), cast: [] as CastInfo[] }), [canvas]);
    const { config, panels, cast } = parsed;

    const orientation: Orientation = useMemo(() => {
        for (const p of panels.values()) {
            const [w, h] = p.size.split("x").map(Number);
            if (w && h && w === h) return "square";
            return "portrait";
        }
        return "portrait";
    }, [panels]);
    const geo = PAGE_GEOMETRY[orientation];

    /** 保存：panel metadata 与 storybook-config 整体覆盖到最新文档，409 时重拉重试 */
    const save = useCallback(async (docArg?: CanvasProject) => {
        const doc0 = docArg ?? canvas;
        if (!doc0 || !id) return;
        setSaving(true);
        try {
            const overlay = collectEditOverlay(doc0);
            let saved = false;
            let lastRevision: number | undefined;
            for (let attempt = 0; attempt < 3 && !saved; attempt++) {
                const fresh = attempt === 0
                    ? { project: doc0 }
                    : await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`);
                const doc = fresh.project;
                const nodes = applyEditOverlay(doc.nodes, overlay);
                try {
                    const res = await http.put<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`, { project: { ...doc, nodes } });
                    lastRevision = res.project?.revision;
                    saved = true;
                } catch { /* revision 冲突，重拉 */ }
            }
            if (!saved) throw new Error("连续冲突");
            if (typeof lastRevision === "number") {
                const rev = lastRevision;
                setCanvas((prev) => (prev ? { ...prev, revision: rev } : prev));
            }
            setDirty(false);
        } catch (error) {
            message.error(`保存失败（画布可能在别处已更新，请刷新后重试）：${error instanceof Error ? error.message : String(error)}`);
            throw error;
        } finally {
            setSaving(false);
        }
    }, [canvas, id, message]);

    // 历史：编辑函数标记 pendingKey（600ms 内合并），load/写回/撤销恢复时置 suppress 跳过
    const pendingKeyRef = useRef("");
    const suppressHistoryRef = useRef(false);
    useEffect(() => {
        if (!canvas) return;
        if (suppressHistoryRef.current) { suppressHistoryRef.current = false; return; }
        const h = historyRef.current;
        const now = Date.now();
        if (pendingKeyRef.current && pendingKeyRef.current === h.lastKey && now - h.lastAt < 600) {
            h.stack[h.ptr] = canvas;
            h.lastAt = now;
        } else {
            h.stack = h.stack.slice(0, h.ptr + 1);
            h.stack.push(canvas);
            h.ptr = h.stack.length - 1;
            h.lastKey = pendingKeyRef.current;
            h.lastAt = now;
        }
        setHistoryVersion((v) => v + 1);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canvas]);
    const undo = useCallback(() => {
        const h = historyRef.current;
        if (h.ptr <= 0) return;
        h.ptr -= 1;
        suppressHistoryRef.current = true;
        setCanvas(h.stack[h.ptr]);
        h.lastKey = "";
        setHistoryVersion((v) => v + 1);
        setDirty(true);
    }, []);
    const redo = useCallback(() => {
        const h = historyRef.current;
        if (h.ptr + 1 >= h.stack.length) return;
        h.ptr += 1;
        suppressHistoryRef.current = true;
        setCanvas(h.stack[h.ptr]);
        h.lastKey = "";
        setHistoryVersion((v) => v + 1);
        setDirty(true);
    }, []);
    const canUndo = historyRef.current.ptr > 0;
    const canRedo = historyRef.current.ptr + 1 < historyRef.current.stack.length;

    // ---------- 结构编辑：storybook-config 的所有结构操作改在本地，随「保存」写回 ----------
    const updateConfig = useCallback((mutate: (cfg: StorybookConfig) => void) => {
        pendingKeyRef.current = "";
        setCanvas((prev) => {
            if (!prev) return prev;
            const nodes = prev.nodes.map((node) => {
                if (node.id !== "storybook-config") return node;
                const md = { ...(node.metadata ?? {}) } as Record<string, unknown>;
                try {
                    const cfg = JSON.parse(String(md.content ?? "{}"));
                    if (cfg?.kind === "storybook-config") {
                        mutate(cfg);
                        md.content = JSON.stringify(cfg);
                    }
                } catch { /* 配置损坏忽略 */ }
                return { ...node, metadata: md };
            });
            return { ...prev, nodes };
        });
        setDirty(true);
    }, []);

    const updatePanelMeta = useCallback((panelId: string, patch: Record<string, unknown>) => {
        pendingKeyRef.current = `panel-meta:${panelId}`;
        setCanvas((prev) => (prev ? withPanelMeta(prev, panelId, (md) => ({ ...md, ...patch })) : prev));
        setDirty(true);
    }, []);

    const updateNarrationText = useCallback((panelId: string, text: string) => {
        pendingKeyRef.current = `narration:${panelId}`;
        setCanvas((prev) => (prev ? withPanelMeta(prev, panelId, (md) => ({ ...md, narration: { ...((md.narration as PanelNarration) ?? { text: "" }), text } })) : prev));
        setDirty(true);
    }, []);

    const updateDialogue = useCallback((panelId: string, index: number, patch: Partial<DialogueLine>) => {
        pendingKeyRef.current = `dialogue:${panelId}:${index}`;
        setCanvas((prev) => {
            if (!prev) return prev;
            return withPanelMeta(prev, panelId, (md) => {
                const dialogue = Array.isArray(md.dialogue) ? [...(md.dialogue as DialogueLine[])] : [];
                dialogue[index] = { ...dialogue[index], ...patch };
                return { ...md, dialogue };
            });
        });
        setDirty(true);
    }, []);

    const addDialogue = useCallback((panelId: string) => {
        pendingKeyRef.current = "";
        setCanvas((prev) => {
            if (!prev) return prev;
            return withPanelMeta(prev, panelId, (md) => ({
                ...md,
                dialogue: [...(Array.isArray(md.dialogue) ? md.dialogue : []), { speaker: cast[0]?.key ?? "", name: cast[0]?.name ?? "", text: "" }],
            }));
        });
        setDirty(true);
    }, [cast]);

    const removeDialogue = useCallback((panelId: string, index: number) => {
        pendingKeyRef.current = "";
        setCanvas((prev) => {
            if (!prev) return prev;
            return withPanelMeta(prev, panelId, (md) => {
                const dialogue = Array.isArray(md.dialogue) ? [...(md.dialogue as DialogueLine[])] : [];
                dialogue.splice(index, 1);
                return { ...md, dialogue };
            });
        });
        setDirty(true);
    }, []);

    /** 气泡拖拽：pointer capture 归一化坐标，松手即写回 dialogue.x/y（随保存持久化） */
    const startBubbleDrag = useCallback((e: React.PointerEvent<HTMLDivElement>, panelId: string, index: number, ox: number, oy: number) => {
        e.stopPropagation();
        const frame = (e.currentTarget as HTMLElement).parentElement;
        if (!frame) return;
        const startX = e.clientX;
        const startY = e.clientY;
        let last = { x: ox, y: oy };
        const move = (ev: PointerEvent) => {
            last = {
                x: Number(Math.min(0.58, Math.max(0, ox + (ev.clientX - startX) / frame.clientWidth)).toFixed(3)),
                y: Number(Math.min(0.86, Math.max(0, oy + (ev.clientY - startY) / frame.clientHeight)).toFixed(3)),
            };
            updateDialogue(panelId, index, last);
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    }, [updateDialogue]);

    const movePage = useCallback((delta: 1 | -1) => {
        if (!config) return;
        const to = pageIndex + delta;
        if (to < 0 || to >= config.pages.length) return;
        updateConfig((cfg) => { [cfg.pages[pageIndex], cfg.pages[to]] = [cfg.pages[to], cfg.pages[pageIndex]]; });
        setPageIndex(to);
    }, [config, pageIndex, updateConfig]);

    const insertPageAfter = useCallback((type: StorybookPage["type"]) => {
        updateConfig((cfg) => {
            const newPage: StorybookPage = type === "end" ? { type } : { type, panel: "" };
            cfg.pages.splice(pageIndex + 1, 0, newPage);
        });
        setPageIndex(pageIndex + 1);
    }, [pageIndex, updateConfig]);

    const removePage = useCallback(() => {
        if (!config || config.pages.length <= 1) return;
        const pg = config.pages[pageIndex];
        const label = pg.type === "cover" ? "封面" : pg.type === "end" ? "封底" : `第 ${pageIndex + 1} 页`;
        modal.confirm({
            title: `删除${label}？`,
            content: pg.panel ? `本页引用的帧 ${pg.panel} 会回到「未入册」池，不会被删除。` : "页面配置将从 storybook-config 移除。",
            okButtonProps: { danger: true },
            okText: "删除",
            cancelText: "取消",
            onOk: () => {
                updateConfig((cfg) => { cfg.pages.splice(pageIndex, 1); });
                setPageIndex(Math.min(pageIndex, config.pages.length - 2));
            },
        });
    }, [config, pageIndex, modal, updateConfig]);

    const setPagePanel = useCallback((panelId: string) => updateConfig((cfg) => {
        const pg = cfg.pages[pageIndex];
        if (pg && pg.type !== "end") pg.panel = panelId;
    }), [pageIndex, updateConfig]);

    const addPanelToBook = useCallback((pid: string) => updateConfig((cfg) => {
        // 插到封底之前；没有封底则追加
        const endIdx = cfg.pages.findIndex((pg) => pg.type === "end");
        const page: StorybookPage = { type: "full", panel: pid };
        if (endIdx >= 0) cfg.pages.splice(endIdx, 0, page);
        else cfg.pages.push(page);
    }), [updateConfig]);

    const setBookField = useCallback((key: "title" | "subtitle" | "pageEnd", value: string) => updateConfig((cfg) => {
        cfg[key] = value;
    }), [updateConfig]);

    // ---------- 帧重摇：画布同款任务链路（canvas_image），完成后走 generated-assets 原子写回 ----------
    /** 轮询任务到终态；isCancelled 为真时抛"已取消"。连续 5 次轮询失败或超时抛错 */
    const pollTaskUntilDone = useCallback(async (taskId: string, isCancelled: () => boolean): Promise<TaskSummary> => {
        let pollErrors = 0;
        for (let i = 0; i < 200; i++) {
            await new Promise((r) => setTimeout(r, 3000));
            if (isCancelled()) throw new Error("已取消");
            try {
                const t = await http.get<TaskSummary>(`/tasks/${encodeURIComponent(taskId)}`);
                pollErrors = 0;
                if (t.status === "succeeded" || t.status === "failed" || t.status === "cancelled") return t;
            } catch { pollErrors++; if (pollErrors >= 5) break; }
        }
        throw new Error("生成超时");
    }, []);

    const regeneratePanel = useCallback(async (pid: string): Promise<boolean> => {
        const doc = canvasRef.current;
        if (!doc || !id) return false;
        const parsedNow = parseStorybook(doc);
        const panel = parsedNow.panels.get(pid);
        if (!panel || !panel.model) { message.error("该页缺少模型配置"); return false; }
        const [channelId, modelName] = panel.model.includes("::") ? panel.model.split("::") : ["", panel.model];
        cancelRegenRef.current.delete(pid);
        setRegenerating((prev) => new Map(prev).set(pid, "pending"));
        try {
            // 渠道 baseUrl 从工作区模型配置解析（本地渠道直连形态；不带 channelId，走自定义通道校验路径）
            let baseUrl = "";
            try {
                const cfg = await http.get<{ config: { channels?: Array<{ id: string; baseUrl?: string }> } }>("/workspace/model-config");
                baseUrl = cfg.config?.channels?.find((c) => c.id === channelId)?.baseUrl ?? "";
            } catch { /* 渠道解析失败时留空，后端按逻辑模型解析 */ }
            const payload = {
                projectId: id,
                type: "canvas_image",
                operation: "image",
                prompt: panel.prompt,
                model: panel.model,
                input: {
                    mode: "image",
                    ...(baseUrl ? { config: { baseUrl, apiKey: "local-gateway", interfaceType: "openai-image", model: modelName, size: panel.size } } : {}),
                    referenceImages: panel.refStorageKeys,
                    referenceVideos: [],
                    referenceAudios: [],
                    metadata: { nodeId: `panel-${pid}`, sourceNodeId: `panel-${pid}`, resolvedCharacterVersions: [] },
                },
            };
            const created = await http.post<{ id?: string }>("/tasks", payload);
            const taskId = created.id;
            if (!taskId) throw new Error("任务创建失败");
            if (cancelRegenRef.current.has(pid)) {
                void http.post(`/tasks/${encodeURIComponent(taskId)}/cancel`).catch(() => undefined);
                message.info(`已取消 ${pid} 的生成`);
                return false;
            }
            setRegenerating((prev) => new Map(prev).set(pid, taskId));
            let done: TaskSummary;
            try {
                done = await pollTaskUntilDone(taskId, () => cancelRegenRef.current.has(pid));
            } catch (pollError) {
                if (cancelRegenRef.current.has(pid)) { message.info(`已取消 ${pid} 的生成`); return false; }
                throw pollError;
            }
            if (done.status !== "succeeded") {
                throw new Error(done.status === "cancelled" ? "任务已取消" : (done.error?.slice(0, 160) || "生成超时"));
            }
            const images = JSON.parse(done.resultJson ?? "{}").images as Array<{ resourceId?: string; bytes?: number; width?: number; height?: number }> | undefined;
            const img = images?.[0];
            const rid = img?.resourceId;
            if (!rid) throw new Error("任务成功但没有图片");
            // 写回画布：媒体节点顶层媒体引用必须走 generated-assets 通道（asset+文档原子提交）。
            // 撞 revision 时拉最新重试；本地未保存编辑通过 overlay 叠加保留。
            const overlay = collectEditOverlay(doc);
            let written = false;
            for (let attempt = 0; attempt < 3 && !written; attempt++) {
                const fresh = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`);
                const latest = fresh.project;
                const assetId = "generation_" + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
                const now = new Date().toISOString();
                const imagePatch = {
                    content: `/api/resources/${rid}/file`,
                    storageKey: `resource:${rid}`,
                    status: "success" as const,
                    assetId,
                    bytes: img?.bytes,
                    naturalWidth: img?.width,
                    naturalHeight: img?.height,
                };
                // 画布侧生成会把节点标题顶成提示词开头,写回时按建册格式归位(P01 第1页)
                const nodes = applyEditOverlay(latest.nodes, overlay).map((node) => (node.id === `panel-${pid}`
                    ? { ...node, title: `${pid} ${parsedNow.panels.get(pid)?.title ?? ""}`.trim(), metadata: { ...(node.metadata ?? {}), ...imagePatch } }
                    : node));
                const asset = {
                    id: assetId,
                    kind: "image",
                    category: "material",
                    status: "ready",
                    primaryVersionId: crypto.randomUUID().replace(/-/g, ""),
                    title: `${pid} ${parsedNow.panels.get(pid)?.title ?? ""}`.trim(),
                    createdAt: now,
                    updatedAt: now,
                    coverUrl: `/api/resources/${rid}/file`,
                    source: "generation-task",
                    data: {
                        bytes: img?.bytes ?? 0,
                        dataUrl: `/api/resources/${rid}/file`,
                        height: img?.height ?? 0,
                        mimeType: "image/png",
                        storageKey: `resource:${rid}`,
                        width: img?.width ?? 0,
                    },
                    metadata: { generationEffectKey: `storybook-regen:${pid}:${now}`, nodeId: `panel-${pid}`, outputIndex: 0, source: "generation-task" },
                    tags: [],
                };
                try {
                    const res = await http.put<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}/generated-assets`, { project: { ...latest, nodes }, assets: [asset] });
                    const rev = res.project?.revision;
                    // 本地只合并目标帧的图片字段，其余本地编辑原样保留
                    setCanvas((prev) => {
                        if (!prev) return prev;
                        const localNodes = prev.nodes.map((n) => (n.id === `panel-${pid}`
                            ? { ...n, metadata: { ...(n.metadata ?? {}), ...imagePatch } }
                            : n));
                        return { ...prev, ...(typeof rev === "number" ? { revision: rev } : {}), nodes: localNodes };
                    });
                    written = true;
                } catch { /* revision 冲突，拉最新重试 */ }
            }
            if (!written) throw new Error("画布写入连续冲突（画布页可能正在同步），请稍后再试");
            message.success(`${pid} 已重新生成`);
            return true;
        } catch (error) {
            message.error(`重摇 ${pid} 失败：${error instanceof Error ? error.message : String(error)}`);
            return false;
        } finally {
            cancelRegenRef.current.delete(pid);
            setRegenerating((prev) => { const next = new Map(prev); next.delete(pid); return next; });
        }
    }, [id, message, pollTaskUntilDone]);

    const cancelRegen = useCallback((pid: string) => {
        cancelRegenRef.current.add(pid);
        const tid = regenerating.get(pid);
        if (tid && tid !== "pending") void http.post(`/tasks/${encodeURIComponent(tid)}/cancel`).catch(() => undefined);
    }, [regenerating]);

    // ---------- 批量生成缺帧：按册内顺序串行重摇（本地网关一次一张），可中途停止 ----------
    const generateMissing = useCallback(async () => {
        const doc = canvasRef.current;
        if (!doc) return;
        const parsedNow = parseStorybook(doc);
        const referenced = new Set(parsedNow.config?.pages.flatMap((pg) => (pg.panel ? [pg.panel] : [])) ?? []);
        const missing: string[] = [];
        const noModel: string[] = [];
        for (const p of parsedNow.panels.values()) {
            if (!referenced.has(p.id) || p.imageSrc) continue;
            if (p.model) missing.push(p.id); else noModel.push(p.id);
        }
        if (noModel.length) message.warning(`${noModel.join("、")} 缺少模型配置，已跳过`);
        if (!missing.length) { message.info("没有待生成的页图"); return; }
        batchStopRef.current = false;
        setBatching({ done: 0, total: missing.length, current: missing[0] });
        let ok = 0;
        let fail = 0;
        let stopped = false;
        for (let i = 0; i < missing.length; i++) {
            if (batchStopRef.current) { stopped = true; break; }
            setBatching({ done: i, total: missing.length, current: missing[i] });
            if (await regeneratePanel(missing[i])) ok++; else fail++;
        }
        setBatching(null);
        if (stopped) message.info(`已停止批量生成（完成 ${ok} 页图）`);
        else message.success(`批量生成完成：成功 ${ok} 页图${fail ? `，失败 ${fail} 页图` : ""}`);
    }, [regeneratePanel, message]);

    const stopBatch = useCallback(() => {
        batchStopRef.current = true;
        if (batching) cancelRegen(batching.current);
    }, [batching, cancelRegen]);

    // ---------- 配音 ----------
    const audioModelOptions = useMemo(() => storybookAudioModelOptions(globalConfig), [globalConfig]);
    const audioCfg = config?.audio;
    const effectiveAudioModel = audioCfg?.model || defaultStorybookAudioModel(globalConfig, audioModelOptions);
    const audioProfile = useMemo(() => audioSpeechProfile(effectiveAudioModel), [effectiveAudioModel]);
    const isForge = isVoiceforgeModel(effectiveAudioModel);
    // 预置音色语义（音色下拉走 /voices 实时列表 + 未绑定时稳定错开）适用所有本机 TTS 渠道：
    // voiceforge（9890）与网关 indextts2（8765）都返回预置音色列表。
    // 注意 instructions 的显隐仍按 isForge 判断——只有 CosyVoice voiceforge 会把指令朗读进音频。
    const audioRequestConfig = useMemo(() => resolveModelRequestConfig(globalConfig, effectiveAudioModel), [globalConfig, effectiveAudioModel]);
    const usesPresetVoices = isForge || (/tts/i.test(audioRequestConfig.model) && /127\.0\.0\.1|localhost|::1/i.test(audioRequestConfig.baseUrl));

    // 声线工坊预置音色：描述固化的音色，每次合成听感一致；未列出的 voice 名（如 alloy）逐次漂移不可用。
    // 中转白名单未放行 /voices 时回落到内置建议列表（AutoComplete 仍可手动输入任意音色名）。
    const [forgeVoices, setForgeVoices] = useState<string[] | null>(null);
    useEffect(() => {
        if (!usesPresetVoices) { setForgeVoices(null); return; }
        let cancelled = false;
        (async () => {
            const rc = resolveModelRequestConfig(globalConfig, effectiveAudioModel);
            const voices = await fetchVoiceforgeVoices(rc).catch(() => VOICEFORGE_FALLBACK_VOICES);
            if (!cancelled) setForgeVoices(voices);
        })();
        return () => { cancelled = true; };
    }, [usesPresetVoices, effectiveAudioModel, globalConfig.channels]);

    const voiceOptions = useMemo(
        () => (usesPresetVoices && forgeVoices?.length ? forgeVoices.map((v) => ({ value: v, label: v })) : audioProfile.voices),
        [usesPresetVoices, forgeVoices, audioProfile],
    );

    const updateAudioConfig = useCallback((patch: Partial<StorybookAudioConfig>) => updateConfig((cfg) => {
        cfg.audio = { ...(cfg.audio ?? { model: "", narratorVoice: "alloy", narratorInstructions: DEFAULT_NARRATOR_INSTRUCTIONS, speed: "0.9" }), ...patch };
    }), [updateConfig]);

    const updateCastVoice = useCallback((key: string, patch: Partial<{ voice: string; instructions: string }>) => updateConfig((cfg) => {
        cfg.castVoices = { ...(cfg.castVoices ?? {}) };
        cfg.castVoices[key] = { voice: cfg.castVoices[key]?.voice || "alloy", instructions: cfg.castVoices[key]?.instructions || "", ...patch };
    }), [updateConfig]);

    /** 声线工坊音色解析：显式绑定优先；未绑定/存量 alloy 时落到稳定预置音色（讲读者固定、角色按序错开） */
    const resolveForgeVoice = useCallback((bound: string, offset: number): string => {
        const list = forgeVoices?.length ? forgeVoices : VOICEFORGE_FALLBACK_VOICES;
        if (bound && list.includes(bound)) return bound;
        return list[((offset % list.length) + list.length) % list.length];
    }, [forgeVoices]);

    const narratorVoiceOf = useCallback((): StorybookVoice => {
        const voice = usesPresetVoices ? resolveForgeVoice(audioCfg?.narratorVoice || "", 0) : (audioCfg?.narratorVoice || "alloy");
        return { voice, instructions: audioCfg?.narratorInstructions || DEFAULT_NARRATOR_INSTRUCTIONS };
    }, [audioCfg, usesPresetVoices, resolveForgeVoice]);

    const castVoiceOf = useCallback((speaker: string, name: string): StorybookVoice => {
        const cv = config?.castVoices?.[speaker];
        const bound = cv?.voice && cv.voice !== "alloy" ? cv.voice : "";
        if (bound) return { voice: bound, instructions: cv?.instructions || `${name || speaker}的说话语气` };
        if (usesPresetVoices) {
            const idx = Math.max(0, cast.findIndex((c) => c.key === speaker));
            return { voice: resolveForgeVoice("", idx + 1), instructions: cv?.instructions || "" };
        }
        return narratorVoiceOf();
    }, [cast, config, usesPresetVoices, narratorVoiceOf, resolveForgeVoice]);

    /** 首次配音时把解析出的音色显式落库：面板可见、可改，不随音色列表顺序漂移 */
    const ensureVoiceBindings = useCallback(() => {
        updateConfig((c) => {
            const nv = narratorVoiceOf();
            if (!c.audio?.model || !c.audio.narratorVoice) {
                c.audio = { model: effectiveAudioModel, narratorVoice: nv.voice, narratorInstructions: c.audio?.narratorInstructions || DEFAULT_NARRATOR_INSTRUCTIONS, speed: c.audio?.speed || "0.9" };
            }
            c.castVoices = { ...(c.castVoices ?? {}) };
            for (const cc of cast) {
                const bound = c.castVoices[cc.key]?.voice;
                if (!bound || bound === "alloy") {
                    c.castVoices[cc.key] = { voice: castVoiceOf(cc.key, cc.name).voice, instructions: c.castVoices[cc.key]?.instructions || "" };
                }
            }
        });
    }, [cast, castVoiceOf, effectiveAudioModel, narratorVoiceOf, updateConfig]);

    const playAudio = useCallback(async (storageKey: string) => {
        playingRef.current?.pause();
        try {
            // blob: url 刷新即失效，播放时一律按 storageKey 现取（IndexedDB/资源 API 双路径）
            const { getMediaBlob } = await import("@/services/file-storage");
            const blob = await getMediaBlob(storageKey);
            if (!blob) throw new Error("音频文件不在本地缓存");
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            playingRef.current = audio;
            audio.onended = () => URL.revokeObjectURL(url);
            void audio.play().catch(() => message.warning("浏览器阻止了自动播放，请再点一次"));
        } catch (error) {
            message.error(`试听失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }, [message]);

    /** 合成一行并写回画布（普通 PUT，音频是嵌套引用不触发媒体守卫），随后自动保存 */
    const synthAndCommit = useCallback(async (pid: string, target: AudioTarget): Promise<boolean> => {
        const doc = canvasRef.current;
        if (!doc || !effectiveAudioModel) return false;
        ensureVoiceBindings();
        const panel = parseStorybook(doc).panels.get(pid);
        if (!panel) return false;
        const text = target.kind === "narration" ? panel.narration.text : panel.dialogue[target.index]?.text ?? "";
        if (!text.trim()) { message.warning("台词为空，先写点内容"); return false; }
        const voice = target.kind === "narration"
            ? narratorVoiceOf()
            : castVoiceOf(panel.dialogue[target.index].speaker, panel.dialogue[target.index].name);
        const lineKey = target.kind === "narration" ? `${pid}:narration` : `${pid}:dlg:${target.index}`;
        setDubbingLine(lineKey);
        try {
            const audio = await synthesizeStorybookLine({
                config: globalConfig,
                model: effectiveAudioModel,
                text,
                voice,
                speed: audioCfg?.speed || undefined,
            });
            const latest = canvasRef.current;
            if (!latest) return false;
            const next = withPanelMeta(latest, pid, (md) => {
                if (target.kind === "narration") return { ...md, narration: { ...((md.narration as PanelNarration) ?? { text: "" }), audio } };
                const dialogue = Array.isArray(md.dialogue) ? [...(md.dialogue as DialogueLine[])] : [];
                // 合成期间行可能被删掉，此时丢弃结果而不是写出越界空行
                if (!dialogue[target.index]) return md;
                dialogue[target.index] = { ...dialogue[target.index], audio };
                return { ...md, dialogue };
            });
            suppressHistoryRef.current = true;
            setCanvas(next);
            // 本地后端保存很快时 React 可能还没重渲染,同步更新 ref 防止下一行读到过期文档丢音频
            canvasRef.current = next;
            await save(next);
            // 批量配音有顶部汇总提示，单行操作给行级成功反馈
            if (!dubStopRef.current && !dubbing) message.success(target.kind === "narration" ? "旁白已配音" : "对白已配音");
            return true;
        } catch (error) {
            if (!(error instanceof DOMException && error.name === "AbortError")) {
                message.error(`配音失败：${error instanceof Error ? error.message : String(error)}`);
            }
            return false;
        } finally {
            setDubbingLine(null);
        }
    }, [audioCfg, castVoiceOf, dubbing, effectiveAudioModel, ensureVoiceBindings, globalConfig, message, narratorVoiceOf, save]);

    // ---------- 批量配音：按页序串行合成缺失/过期行，可中途停止 ----------
    const generateAllAudio = useCallback(async () => {
        const doc = canvasRef.current;
        if (!doc || !effectiveAudioModel) {
            message.error("没有可用音频模型，请先在「配音」面板选择或到「模型配置」添加渠道");
            return;
        }
        const parsedNow = parseStorybook(doc);
        const cfgNow = parsedNow.config;
        if (!cfgNow) return;
        ensureVoiceBindings();
        const order: string[] = (cfgNow.pages ?? []).flatMap((pg) => (pg.panel ? [pg.panel] : []));
        const targets: Array<{ pid: string; target: AudioTarget; label: string }> = [];
        for (const pid of order) {
            const panel = parsedNow.panels.get(pid);
            if (!panel) continue;
            if (panel.narration.text && lineAudioStale(panel.narration.audio, panel.narration.text, narratorVoiceOf().voice)) {
                targets.push({ pid, target: { kind: "narration" }, label: `${pid} 旁白` });
            }
            panel.dialogue.forEach((line, i) => {
                if (line.text.trim() && lineAudioStale(line.audio, line.text, castVoiceOf(line.speaker, line.name).voice)) {
                    targets.push({ pid, target: { kind: "dialogue", index: i }, label: `${pid} 对白${i + 1}` });
                }
            });
        }
        if (!targets.length) { message.info("没有待配音的台词"); return; }
        dubStopRef.current = false;
        setDubbing({ done: 0, total: targets.length, current: targets[0].label });
        let ok = 0;
        let fail = 0;
        let stopped = false;
        for (let i = 0; i < targets.length; i++) {
            if (dubStopRef.current) { stopped = true; break; }
            setDubbing({ done: i, total: targets.length, current: targets[i].label });
            if (await synthAndCommit(targets[i].pid, targets[i].target)) ok++; else fail++;
        }
        setDubbing(null);
        if (stopped) message.info(`已停止配音（完成 ${ok} 条）`);
        else if (fail) message.warning(`配音完成：成功 ${ok} 条，失败 ${fail} 条`);
        else message.success(`配音完成（${ok} 条，已随存画布）`);
    }, [castVoiceOf, effectiveAudioModel, ensureVoiceBindings, message, narratorVoiceOf, synthAndCommit]);

    // ---------- 导出：页面渲染（DOM 同几何的 canvas 2D） ----------
    const renderPageCanvas = useCallback(async (pageIdx: number): Promise<HTMLCanvasElement | null> => {
        if (!config) return null;
        const page = config.pages[pageIdx];
        if (!page) return null;
        const canvasEl = document.createElement("canvas");
        canvasEl.width = geo.w;
        canvasEl.height = geo.h;
        const ctx = canvasEl.getContext("2d");
        if (!ctx) return null;
        const kai = "'KaiTi','STKaiti','楷体',serif";
        ctx.fillStyle = PAPER;
        ctx.fillRect(0, 0, geo.w, geo.h);
        const loadImg = (src: string) => new Promise<HTMLImageElement | null>((resolve) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = src;
        });
        const wrapText = (text: string, font: string, maxW: number) => {
            ctx.font = font;
            const out: string[] = [];
            for (const para of text.split("\n")) {
                let cur = "";
                for (const ch of para) {
                    if (ctx.measureText(cur + ch).width > maxW && cur) { out.push(cur); cur = ch; } else cur += ch;
                }
                out.push(cur);
            }
            return out;
        };
        const roundRectPath = (c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
            c.beginPath();
            c.moveTo(x + r, y);
            c.arcTo(x + w, y, x + w, y + h, r);
            c.arcTo(x + w, y + h, x, y + h, r);
            c.arcTo(x, y + h, x, y, r);
            c.arcTo(x, y, x + w, y, r);
            c.closePath();
        };
        // 单行长文字（书名/副题/封底语）不换行，按页宽自适应缩号到放得下为止
        const fitFont = (text: string, base: number, min: number, weight = "") => {
            let fs = base;
            const setFont = () => { ctx.font = `${weight ? `${weight} ` : ""}${fs}px ${kai}`; };
            setFont();
            const maxW = geo.w * 0.88;
            while (fs > min && ctx.measureText(text).width > maxW) { fs -= 4; setFont(); }
        };
        const panel = page.panel ? panels.get(page.panel) : undefined;
        // 整页大图(contain 居中)，旁白与对白全部叠加在图上（与 DOM 视图同合同）
        if (panel?.imageSrc) {
            const img = await loadImg(panel.imageSrc);
            if (img) {
                const r = Math.min(geo.w / img.width, geo.h / img.height);
                const iw = img.width * r, ih = img.height * r;
                ctx.drawImage(img, (geo.w - iw) / 2, (geo.h - ih) / 2, iw, ih);
            } else {
                ctx.fillStyle = "#e3dcc9";
                ctx.fillRect(0, 0, geo.w, geo.h);
            }
        } else if (page.type !== "end") {
            ctx.fillStyle = "#e3dcc9";
            ctx.fillRect(0, 0, geo.w, geo.h);
            ctx.fillStyle = "#9a8f78";
            ctx.font = `44px ${kai}`;
            ctx.textAlign = "center";
            ctx.fillText(panel ? `${panel.id} ${panel.title}（待生成）` : "（本页未绑定插画帧）", geo.w / 2, geo.h / 2);
        }
        ctx.textAlign = "center";
        if (page.type === "cover") {
            // 封面题字：顶部渐变纸色带淡出到画面，不硬切主体
            const grad = ctx.createLinearGradient(0, 0, 0, geo.h * 0.3);
            grad.addColorStop(0, "rgba(251,246,236,0.96)");
            grad.addColorStop(0.6, "rgba(251,246,236,0.8)");
            grad.addColorStop(1, "rgba(251,246,236,0)");
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, geo.w, geo.h * 0.3);
            ctx.fillStyle = INK;
            fitFont(config.title || "未命名绘本", 104, 52, "bold");
            ctx.fillText(config.title || "未命名绘本", geo.w / 2, geo.h * 0.11);
            if (config.subtitle) {
                fitFont(config.subtitle, 46, 26);
                ctx.fillStyle = "#6d5f4c";
                ctx.fillText(config.subtitle, geo.w / 2, geo.h * 0.175);
            }
        } else if (page.type === "full") {
            // 对白气泡：叠加在整页图上，坐标与 DOM 视图同一合同（缺失时按序自动摆放）
            const drawBubble = (line: DialogueLine, i: number) => {
                if (!line.text) return;
                const d = dialogueBubbleDefaults(i);
                const bx = (line.x ?? d.x) * geo.w;
                const by = (line.y ?? d.y) * geo.h;
                const bw = (line.w ?? d.w) * geo.w;
                const text = (line.name ? `${line.name}：` : "") + line.text;
                let fs = Math.max(30, Math.min(52, Math.round(bw / 13)));
                const pad = fs * 0.55;
                let lines = wrapText(text, `${fs}px ${kai}`, bw - pad * 2);
                while (lines.length > 4 && fs > 26) {
                    fs -= 4;
                    lines = wrapText(text, `${fs}px ${kai}`, bw - pad * 2);
                }
                const lh = fs * 1.42;
                const bh = lines.length * lh + pad * 1.7;
                ctx.save();
                ctx.fillStyle = "rgba(255,255,255,0.95)";
                ctx.strokeStyle = "rgba(43,38,33,0.8)";
                ctx.lineWidth = 4;
                roundRectPath(ctx, bx, by, bw, bh, 20);
                ctx.fill();
                ctx.stroke();
                // 尾巴（旋转方块法，与漫画气泡同技巧）
                const tail = line.tail ?? d.tail;
                const tx = tail === "bl" ? bx + bw * 0.2 : bx + bw * 0.8;
                const ty = by + bh;
                ctx.beginPath();
                ctx.moveTo(tx - 16, ty - 2);
                ctx.lineTo(tx + (tail === "bl" ? 6 : 26), ty + 30);
                ctx.lineTo(tx + 16, ty - 2);
                ctx.closePath();
                ctx.fillStyle = "rgba(255,255,255,0.95)";
                ctx.fill();
                ctx.beginPath();
                ctx.moveTo(tx - 16, ty - 2);
                ctx.lineTo(tx + (tail === "bl" ? 6 : 26), ty + 30);
                ctx.lineTo(tx + 16, ty - 2);
                ctx.stroke();
                ctx.fillStyle = INK;
                ctx.font = `${fs}px ${kai}`;
                lines.forEach((ln, li) => ctx.fillText(ln, bx + bw / 2, by + pad * 0.9 + fs + li * lh));
                ctx.restore();
            };
            (panel?.dialogue ?? []).forEach((line, i) => drawBubble(line, i));
            // 旁白：底部渐变纸色条，行数自适应缩号（预算 24% 页高），不遮主体
            if (panel?.narration.text) {
                const padX = Math.round(geo.w * 0.07);
                const maxW = geo.w - padX * 2;
                let fs = 56;
                let lines = wrapText(panel.narration.text, `${fs}px ${kai}`, maxW);
                while (lines.length > 3 && fs > 34) {
                    fs -= 4;
                    lines = wrapText(panel.narration.text, `${fs}px ${kai}`, maxW);
                }
                const lh = fs * 1.5;
                const stripH = Math.min(Math.round(geo.h * 0.24), Math.round(lines.length * lh + fs * 1.7));
                const grad = ctx.createLinearGradient(0, geo.h - stripH, 0, geo.h);
                grad.addColorStop(0, "rgba(251,246,236,0)");
                grad.addColorStop(0.35, "rgba(251,246,236,0.85)");
                grad.addColorStop(1, "rgba(251,246,236,0.97)");
                ctx.fillStyle = grad;
                ctx.fillRect(0, geo.h - stripH, geo.w, stripH);
                ctx.fillStyle = INK;
                ctx.font = `${fs}px ${kai}`;
                const baseY = geo.h - (stripH - lines.length * lh) / 2 - fs * 0.32;
                lines.forEach((ln, li) => ctx.fillText(ln, geo.w / 2, baseY + li * lh));
            }
            // 页码（封面占第 0 位，正文页码从 1 计）
            if (pageIdx > 0) {
                ctx.fillStyle = "rgba(122,108,88,0.85)";
                ctx.font = `32px ${kai}`;
                ctx.fillText(`- ${pageIdx} -`, geo.w - 100, geo.h - 34);
            }
        } else {
            ctx.fillStyle = INK;
            fitFont(config.pageEnd || "—— 完 ——", 88, 40, "bold");
            ctx.fillText(config.pageEnd || "—— 完 ——", geo.w / 2, geo.h / 2 - 40);
            fitFont(config.title || "", 44, 24);
            ctx.fillStyle = "#6d5f4c";
            ctx.fillText(config.title || "", geo.w / 2, geo.h / 2 + 70);
        }
        return canvasEl;
    }, [config, panels, geo]);

    const downloadBlob = useCallback((blob: Blob, name: string) => {
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
    }, []);

    /** 导出完成度门禁：导出前亮出缺图/未绑帧/缺配音/配音过期，确认后才继续（防占位灰页混进成品） */
    const confirmExportReadiness = useCallback(async (scope: "zip" | "video"): Promise<boolean> => {
        if (!config) return false;
        const pageLabel = (i: number, type: StorybookPage["type"]) => (type === "cover" ? "封面" : type === "end" ? "封底" : `第 ${i} 页`);
        const missingImgPages: string[] = [];
        const unboundPages: string[] = [];
        for (let i = 0; i < config.pages.length; i++) {
            const pg = config.pages[i];
            if (pg.type === "end") continue;
            const panel = pg.panel ? panels.get(pg.panel) : undefined;
            if (!panel) unboundPages.push(pageLabel(i, pg.type));
            else if (!panel.imageSrc) missingImgPages.push(`${pageLabel(i, pg.type)}（${pg.panel}）`);
        }
        let missingAudio = 0;
        let staleAudio = 0;
        if (scope === "video") {
            for (const pg of config.pages) {
                const panel = pg.panel ? panels.get(pg.panel) : undefined;
                if (!panel) continue;
                if (panel.narration.text) {
                    if (!panel.narration.audio) missingAudio++;
                    else if (lineAudioStale(panel.narration.audio, panel.narration.text, narratorVoiceOf().voice)) staleAudio++;
                }
                for (const line of panel.dialogue) {
                    if (!line.text.trim()) continue;
                    if (!line.audio) missingAudio++;
                    else if (lineAudioStale(line.audio, line.text, castVoiceOf(line.speaker, line.name).voice)) staleAudio++;
                }
            }
        }
        if (!missingImgPages.length && !unboundPages.length && !missingAudio && !staleAudio) return true;
        const issues: string[] = [];
        if (missingImgPages.length) issues.push(`${missingImgPages.length} 页插画未生成，导出会是占位灰页：${missingImgPages.slice(0, 6).join("、")}${missingImgPages.length > 6 ? " 等" : ""}`);
        if (unboundPages.length) issues.push(`${unboundPages.length} 页未绑定插画帧：${unboundPages.slice(0, 6).join("、")}${unboundPages.length > 6 ? " 等" : ""}`);
        if (missingAudio) issues.push(`${missingAudio} 句台词未配音，视频里对应页按默认停留处理`);
        if (staleAudio) issues.push(`${staleAudio} 句台词文字已改、配音过期，视频不会用过期配音`);
        return await new Promise<boolean>((resolve) => {
            modal.confirm({
                title: scope === "video" ? "导出有声视频前有未完成项" : "导出全册 ZIP 前有未完成项",
                content: (<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>{issues.map((s) => <div key={s}>· {s}</div>)}</div>),
                okText: "仍要导出",
                cancelText: "先去补齐",
                onOk: () => resolve(true),
                onCancel: () => resolve(false),
            });
        });
    }, [castVoiceOf, config, modal, narratorVoiceOf, panels]);

    const exportPagePng = useCallback(async () => {
        const canvasEl = await renderPageCanvas(pageIndex);
        if (!canvasEl) return;
        const blob = await new Promise<Blob | null>((resolve) => canvasEl.toBlob(resolve, "image/png"));
        if (!blob) return;
        try {
            downloadBlob(blob, `storybook-page-${String(pageIndex + 1).padStart(2, "0")}.png`);
            message.success(`已导出第 ${pageIndex + 1} 页`);
        } catch {
            message.info("浏览器拦截了自动下载");
        }
    }, [renderPageCanvas, pageIndex, downloadBlob, message]);

    const exportAllZip = useCallback(async () => {
        if (!config) return;
        if (!(await confirmExportReadiness("zip"))) return;
        setExporting({ done: 0, total: config.pages.length });
        try {
            const files: Array<{ name: string; data: BlobPart }> = [];
            for (let i = 0; i < config.pages.length; i++) {
                const canvasEl = await renderPageCanvas(i);
                if (!canvasEl) continue;
                const blob = await new Promise<Blob | null>((resolve) => canvasEl.toBlob(resolve, "image/png"));
                if (blob) files.push({ name: `page-${String(i + 1).padStart(2, "0")}.png`, data: blob });
                setExporting({ done: i + 1, total: config.pages.length });
            }
            const zipBlob = await createZip(files);
            downloadBlob(zipBlob, `${(config.title || "storybook").replace(/[\\/:*?"<>|]/g, "_")}.zip`);
            message.success(`已导出全部 ${files.length} 页（zip）`);
        } catch (error) {
            message.error(`导出失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setExporting(null);
        }
    }, [config, confirmExportReadiness, renderPageCanvas, downloadBlob, message]);

    // ---------- 有声视频导出：页 PNG + 行音频 → 时间线 → ffmpeg.wasm MP4 ----------
    const exportVideo = useCallback(async () => {
        if (!config) return;
        if (!__BEEFTV_HEAVY_MEDIA_ENABLED__) {
            message.error("精简版未包含 FFmpeg 本地媒体工具，无法导出视频");
            return;
        }
        if (!(await confirmExportReadiness("video"))) return;
        const controller = new AbortController();
        videoAbortRef.current = controller;
        setExportingVideo({ phase: "render", percent: 0, detail: "渲染页面" });
        try {
            const videoPages: Array<{ png: Blob; audio: Array<{ storageKey: string; durationMs: number }> }> = [];
            let silentPages = 0;
            for (let i = 0; i < config.pages.length; i++) {
                controller.signal.throwIfAborted();
                setExportingVideo({ phase: "render", percent: Math.round((i / config.pages.length) * 40), detail: `渲染第 ${i + 1}/${config.pages.length} 页` });
                const canvasEl = await renderPageCanvas(i);
                if (!canvasEl) continue;
                const png = await new Promise<Blob | null>((resolve) => canvasEl.toBlob(resolve, "image/png"));
                if (!png) continue;
                const pg = config.pages[i];
                const panel = pg.panel ? panels.get(pg.panel) : undefined;
                const audio: Array<{ storageKey: string; durationMs: number }> = [];
                if (panel?.narration.audio && !lineAudioStale(panel.narration.audio, panel.narration.text, narratorVoiceOf().voice)) {
                    audio.push({ storageKey: panel.narration.audio.storageKey, durationMs: panel.narration.audio.durationMs });
                }
                for (const line of panel?.dialogue ?? []) {
                    if (line.audio && !lineAudioStale(line.audio, line.text, castVoiceOf(line.speaker, line.name).voice)) {
                        audio.push({ storageKey: line.audio.storageKey, durationMs: line.audio.durationMs });
                    }
                }
                if (!audio.length) silentPages++;
                videoPages.push({ png, audio });
            }
            if (!videoPages.length) throw new Error("没有可导出的页面");
            const height = orientation === "square" ? 1080 : 1528;
            const blob = await exportStorybookVideo({
                pages: videoPages,
                width: 1080,
                height,
                signal: controller.signal,
                onProgress: (p) => setExportingVideo({
                    phase: p.phase,
                    percent: p.phase === "render" ? 40 + Math.round(p.percent * 0.2) : 60 + Math.round(p.percent * 0.4),
                    detail: p.detail,
                }),
            });
            downloadBlob(blob, `${(config.title || "storybook").replace(/[\\/:*?"<>|]/g, "_")}-有声绘本.mp4`);
            message.success(`有声绘本视频已导出${silentPages ? `（${silentPages} 页无声，按默认停留）` : ""}`);
        } catch (error) {
            if (controller.signal.aborted) message.info("已取消视频导出");
            else message.error(`视频导出失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            videoAbortRef.current = null;
            setExportingVideo(null);
        }
    }, [castVoiceOf, config, confirmExportReadiness, narratorVoiceOf, orientation, panels, renderPageCanvas, downloadBlob, message]);

    // 键盘：←/→ 翻页；Ctrl+Z 撤销、Ctrl+Shift+Z / Ctrl+Y 重做（输入框内跳过）
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!config) return;
            const target = e.target instanceof HTMLElement ? e.target : null;
            const inEditor = !!target?.closest("input, textarea, select, [contenteditable='true']");
            if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "z" || e.key === "Z")) {
                if (inEditor) return;
                e.preventDefault();
                if (e.shiftKey) redo(); else undo();
                return;
            }
            if ((e.ctrlKey || e.metaKey) && (e.key === "y" || e.key === "Y")) {
                if (inEditor) return;
                e.preventDefault();
                redo();
                return;
            }
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            if (e.key === "ArrowLeft" && pageIndex > 0) setPageIndex(pageIndex - 1);
            if (e.key === "ArrowRight" && pageIndex < config.pages.length - 1) setPageIndex(pageIndex + 1);
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [config, pageIndex, undo, redo]);

    // 结构删减后收敛页码，防止越界
    useEffect(() => {
        if (config && pageIndex >= config.pages.length) setPageIndex(Math.max(0, config.pages.length - 1));
    }, [config, pageIndex]);

    // ---------- 误关防护：有未保存编辑或任务进行中时，拦截刷新/关闭并确认页内跳转 ----------
    const busy = !!batching || !!dubbing || !!exporting || !!exportingVideo || regenerating.size > 0;
    useEffect(() => {
        if (!dirty && !busy) return;
        const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
        window.addEventListener("beforeunload", onBeforeUnload);
        return () => window.removeEventListener("beforeunload", onBeforeUnload);
    }, [dirty, busy]);

    const navigateGuarded = useCallback((to: string) => {
        const leave = () => navigate(to);
        if (!dirty && !busy) { leave(); return; }
        modal.confirm({
            title: "离开绘本成书页？",
            content: dirty
                ? "有未保存的编辑（台词、气泡位置、书册结构等），离开将丢失本次改动。"
                : "有生成/配音/导出任务正在进行，离开会中断当前任务（已完成的帧图与配音都已保存，回来可续跑）。",
            okText: "仍要离开",
            cancelText: "留下",
            onOk: leave,
        });
    }, [busy, dirty, modal, navigate]);

    if (loading) {
        return <div style={{ padding: 24 }}><Skeleton active paragraph={{ rows: 10 }} /></div>;
    }
    if (!canvas || !config || config.pages.length === 0) {
        return (
            <div style={{ padding: 48, color: "var(--muted, #8b929e)" }}>
                该画布没有绘本配置（缺少 storybook-config 节点或页面为空）。
            </div>
        );
    }

    const safeIndex = Math.min(pageIndex, config.pages.length - 1);
    const page = config.pages[safeIndex];
    const pagePanel = page.panel ? panels.get(page.panel) : undefined;
    const referencedPanelIds = new Set(config.pages.flatMap((pg) => (pg.panel ? [pg.panel] : [])));
    const unreferencedPanels = [...panels.values()].filter((p) => !referencedPanelIds.has(p.id));
    const missingPanels = [...panels.values()].filter((p) => referencedPanelIds.has(p.id) && !p.imageSrc);
    const panelOptions = [...panels.values()].map((p) => ({ value: p.id, label: `${p.id} ${p.title}${referencedPanelIds.has(p.id) && p.id !== page.panel ? "（已入册）" : ""}` }));
    const lineStats = (() => {
        let total = 0;
        let done = 0;
        for (const p of panels.values()) {
            if (p.narration.text) { total++; if (!lineAudioStale(p.narration.audio, p.narration.text, narratorVoiceOf().voice)) done++; }
            for (const line of p.dialogue) {
                if (line.text.trim()) { total++; if (!lineAudioStale(line.audio, line.text, castVoiceOf(line.speaker, line.name).voice)) done++; }
            }
        }
        return { total, done };
    })();
    const doneImages = [...panels.values()].filter((p) => p.imageSrc).length;
    const castOptions = cast.map((c) => ({ value: c.key, label: c.name }));

    const sideLabel: Record<string, string> = { cover: "封面", full: `第 ${safeIndex} 页`, end: "封底" };

    return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
            {/* 顶栏 */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderBottom: "1px solid var(--border, #2a2d33)", flexWrap: "wrap" }}>
                <Button icon={<ArrowLeftOutlined />} onClick={() => navigateGuarded("/storybook-books")} />
                <span style={{ fontWeight: 700 }}>{config.title || canvas.title}</span>
                {config.subtitle ? <span style={{ opacity: 0.6, fontSize: 13 }}>{config.subtitle}</span> : null}
                <Tag>{doneImages}/{panels.size} 页图</Tag>
                <Tag color={lineStats.total && lineStats.done >= lineStats.total ? "green" : "default"}><AudioOutlined /> 配音 {lineStats.done}/{lineStats.total}</Tag>
                {dirty ? <Tag color="orange">未保存</Tag> : null}
                <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <Tooltip title="撤销（Ctrl+Z）"><Button icon={<UndoOutlined />} disabled={!canUndo || saving} onClick={undo} /></Tooltip>
                    <Tooltip title="重做（Ctrl+Shift+Z）"><Button icon={<RedoOutlined />} disabled={!canRedo || saving} onClick={redo} /></Tooltip>
                    {batching ? (
                        <Button danger icon={<StopOutlined />} onClick={stopBatch}>停止 {batching.done + 1}/{batching.total}</Button>
                    ) : (
                        <Button icon={<ThunderboltOutlined />} disabled={saving} onClick={() => void generateMissing()}>生成缺帧{missingPanels.length ? `（${missingPanels.length}）` : ""}</Button>
                    )}
                    <Button onClick={() => navigateGuarded(`/canvas/${encodeURIComponent(id ?? "")}`)}>打开画布</Button>
                    <Button icon={<ReloadOutlined />} onClick={() => void load()} />
                    <Button icon={<SaveOutlined />} type="primary" loading={saving} disabled={!dirty} onClick={() => void save()}>保存</Button>
                    <Button icon={<DownloadOutlined />} onClick={() => void exportPagePng()}>本页 PNG</Button>
                    <Button icon={<DownloadOutlined />} disabled={!!exporting} onClick={() => void exportAllZip()}>全册 ZIP</Button>
                    {exportingVideo ? (
                        <Button danger icon={<StopOutlined />} onClick={() => videoAbortRef.current?.abort()}>停止视频 {exportingVideo.percent}%</Button>
                    ) : (
                        <Button icon={<VideoCameraOutlined />} onClick={() => void exportVideo()}>导出有声视频</Button>
                    )}
                    {exporting ? <Tag>导出中 {exporting.done}/{exporting.total}</Tag> : null}
                    {exportingVideo ? <Tag color="processing">{exportingVideo.phase === "render" ? "渲染" : "编码"} {exportingVideo.percent}% {exportingVideo.detail}</Tag> : null}
                    {dubbing ? <Tag color="processing">配音中 {dubbing.done + 1}/{dubbing.total} {dubbing.current}</Tag> : null}
                </div>
            </div>
            {dubbing ? <Progress percent={Math.round(((dubbing.done + (dubbing.done < dubbing.total ? 0.5 : 1)) / dubbing.total) * 100)} size="small" showInfo={false} style={{ padding: "0 16px" }} /> : null}

            <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
                {/* 左侧页导航 */}
                <div style={{ width: 120, borderRight: "1px solid var(--border, #2a2d33)", padding: 8, display: "flex", flexDirection: "column", gap: 4, overflowY: "auto" }}>
                    {config.pages.map((pg, i) => (
                        <Button
                            key={i}
                            size="small"
                            block
                            type={i === pageIndex ? "primary" : "text"}
                            onClick={() => setPageIndex(i)}
                            title={pg.panel ? `${pg.panel} ${panels.get(pg.panel)?.title ?? ""}` : (pg.type === "cover" ? "封面" : pg.type === "end" ? "封底" : "正文页")}
                        >
                            {pg.type === "cover" ? "封面" : pg.type === "end" ? "封底" : `第 ${i} 页`}
                        </Button>
                    ))}
                </div>

                {/* 中央页视图（与导出 canvas 同几何） */}
                <div style={{ flex: 1, display: "flex", alignItems: "flex-start", justifyContent: "center", overflow: "auto", padding: 20 }}>
                    <div style={{ width: "min(100%, 540px)", aspectRatio: `${geo.w} / ${geo.h}`, background: PAPER, borderRadius: 6, boxShadow: "0 4px 18px rgba(0,0,0,0.25)", position: "relative", display: "flex", flexDirection: "column", overflow: "hidden" }}>
                        {page.type === "end" ? (
                            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, color: INK }}>
                                <div style={{ fontFamily: "'KaiTi','STKaiti','楷体',serif", fontSize: "clamp(22px, 5cqw, 44px)", fontWeight: 700 }}>{config.pageEnd || "—— 完 ——"}</div>
                                <div style={{ fontFamily: "'KaiTi','STKaiti','楷体',serif", fontSize: "clamp(12px, 2.4cqw, 22px)", opacity: 0.7 }}>{config.title}</div>
                            </div>
                        ) : (
                            <>
                                <div style={{ position: "absolute", inset: 0, background: "#e3dcc9" }}>
                                    {pagePanel?.imageSrc ? (
                                        <img src={pagePanel.imageSrc} alt={pagePanel.title} style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }} />
                                    ) : (
                                        <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, color: "#9a8f78", fontFamily: "'KaiTi','STKaiti',serif" }}>
                                            <BookOutlined style={{ fontSize: 30 }} />
                                            <div style={{ fontSize: 16 }}>{pagePanel ? `${pagePanel.id} ${pagePanel.title}` : "本页未绑定插画帧"}</div>
                                            <Tag>待生成</Tag>
                                        </div>
                                    )}
                                    {regenerating.get(page.panel ?? "") ? (
                                        <div style={{ position: "absolute", inset: 0, background: "rgba(20,22,26,0.55)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, color: "#fff", fontSize: 13 }}>
                                            <LoadingOutlined style={{ fontSize: 26 }} />
                                            重新生成中…
                                        </div>
                                    ) : null}
                                    {page.type === "cover" ? (
                                        <div
                                            style={{
                                                position: "absolute", top: 0, left: 0, right: 0, padding: "5% 6% 9%",
                                                background: "linear-gradient(to bottom, rgba(251,246,236,0.95) 0%, rgba(251,246,236,0.78) 62%, rgba(251,246,236,0) 100%)",
                                                textAlign: "center", color: INK,
                                            }}
                                        >
                                            <div style={{ fontFamily: "'KaiTi','STKaiti','楷体',serif", fontWeight: 700, fontSize: "clamp(26px, 6cqw, 56px)", lineHeight: 1.25 }}>{config.title || "未命名绘本"}</div>
                                            {config.subtitle ? <div style={{ fontFamily: "'KaiTi','STKaiti',serif", fontSize: "clamp(13px, 2.6cqw, 24px)", opacity: 0.75, marginTop: 8 }}>{config.subtitle}</div> : null}
                                        </div>
                                    ) : null}
                                    {page.type === "full" && pagePanel?.narration.text ? (
                                        <div
                                            style={{
                                                position: "absolute", left: 0, right: 0, bottom: 0, padding: "6% 7% 3.4%",
                                                background: "linear-gradient(to bottom, rgba(251,246,236,0) 0%, rgba(251,246,236,0.72) 26%, rgba(251,246,236,0.94) 100%)",
                                                textAlign: "center", color: INK,
                                                fontFamily: "'KaiTi','STKaiti','楷体',serif",
                                                fontSize: "clamp(15px, 3.2cqw, 30px)", lineHeight: 1.5,
                                                textShadow: "0 0 6px rgba(251,246,236,0.9)",
                                            }}
                                        >
                                            {pagePanel.narration.text}
                                        </div>
                                    ) : null}
                                    {page.type === "full" && pagePanel
                                        ? pagePanel.dialogue.filter((l) => l.text).map((line, i) => {
                                            const d = dialogueBubbleDefaults(i);
                                            const x = line.x ?? d.x;
                                            const y = line.y ?? d.y;
                                            const w = line.w ?? d.w;
                                            const tail = line.tail ?? d.tail;
                                            return (
                                                <div
                                                    key={i}
                                                    onPointerDown={(e) => startBubbleDrag(e, pagePanel.id, i, x, y)}
                                                    style={{
                                                        position: "absolute", left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`,
                                                        background: "rgba(255,255,255,0.95)", border: "2px solid rgba(43,38,33,0.8)", borderRadius: 14,
                                                        padding: "2.4% 3%", cursor: "grab", touchAction: "none",
                                                        fontFamily: "'KaiTi','STKaiti','楷体',serif",
                                                        fontSize: "clamp(11px, 2.2cqw, 21px)", lineHeight: 1.42, color: INK, textAlign: "center",
                                                        boxShadow: "0 2px 8px rgba(43,38,33,0.25)", userSelect: "none",
                                                    }}
                                                >
                                                    {line.name ? <span style={{ color: "#8a6a3a", marginRight: 4 }}>{line.name}：</span> : null}{line.text}
                                                    <span
                                                        aria-hidden
                                                        style={{
                                                            position: "absolute", width: 12, height: 12, background: "rgba(255,255,255,0.95)",
                                                            transform: "rotate(45deg)", bottom: -7,
                                                            ...(tail === "bl" ? { left: "16%", borderLeft: "2px solid rgba(43,38,33,0.8)", borderBottom: "2px solid rgba(43,38,33,0.8)" } : { right: "16%", borderRight: "2px solid rgba(43,38,33,0.8)", borderBottom: "2px solid rgba(43,38,33,0.8)" }),
                                                        }}
                                                    />
                                                </div>
                                            );
                                        })
                                        : null}
                                </div>
                            </>
                        )}
                    </div>
                </div>

                {/* 右侧编辑面板 */}
                <div style={{ width: 320, borderLeft: "1px solid var(--border, #2a2d33)", padding: 12, overflowY: "auto" }}>
                    <Segmented
                        block
                        value={rightTab}
                        onChange={(v) => setRightTab(v as typeof rightTab)}
                        options={[
                            { value: "lines", label: "台词" },
                            { value: "panel", label: "帧" },
                            { value: "audio", label: "配音" },
                            { value: "book", label: "书册" },
                        ]}
                        style={{ marginBottom: 12 }}
                    />

                    {rightTab === "lines" ? (
                        pagePanel ? (
                            <Space direction="vertical" size={12} style={{ width: "100%" }}>
                                <div style={{ fontSize: 13, opacity: 0.7 }}>{sideLabel[page.type]} · {pagePanel.id} {pagePanel.title}</div>
                                <div>
                                    <div style={{ marginBottom: 4, fontSize: 13, fontWeight: 600 }}>旁白（画外音）</div>
                                    <Input.TextArea
                                        rows={3}
                                        value={pagePanel.narration.text}
                                        onChange={(e) => updateNarrationText(pagePanel.id, e.target.value)}
                                        placeholder="这一页的旁白，1-2 句"
                                    />
                                    <Space style={{ marginTop: 6 }}>
                                        {pagePanel.narration.audio && !lineAudioStale(pagePanel.narration.audio, pagePanel.narration.text, narratorVoiceOf().voice) ? (
                                            <>
                                                <Tag color="green">已配音 {Math.round(pagePanel.narration.audio.durationMs / 100) / 10}s</Tag>
                                                <Button size="small" icon={<SoundOutlined />} onClick={() => void playAudio(pagePanel.narration.audio!.storageKey)}>试听</Button>
                                            </>
                                        ) : pagePanel.narration.audio ? <Tag color="orange">文字已改，配音过期</Tag> : <Tag>未配音</Tag>}
                                        <Button size="small" icon={<AudioOutlined />} loading={dubbingLine === `${pagePanel.id}:narration`} onClick={() => void synthAndCommit(pagePanel.id, { kind: "narration" })}>配音</Button>
                                    </Space>
                                </div>
                                <div>
                                    <div style={{ marginBottom: 4, fontSize: 13, fontWeight: 600 }}>角色对白</div>
                                    {cast.length === 0 ? <div style={{ fontSize: 12, opacity: 0.6 }}>本册没有角色卡，无法添加对白（可在画布添加 cast-* 节点）。</div> : null}
                                    {pagePanel.dialogue.map((line, i) => (
                                        <div key={i} style={{ border: "1px solid var(--border, #2a2d33)", borderRadius: 8, padding: 8, marginBottom: 8 }}>
                                            <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                                                <Select
                                                    size="small"
                                                    style={{ width: 110 }}
                                                    value={line.speaker}
                                                    options={castOptions}
                                                    onChange={(speaker) => {
                                                        const c = cast.find((x) => x.key === speaker);
                                                        updateDialogue(pagePanel.id, i, { speaker, name: c?.name ?? "" });
                                                    }}
                                                />
                                                <Input.TextArea
                                                    size="small"
                                                    autoSize={{ minRows: 1, maxRows: 3 }}
                                                    value={line.text}
                                                    onChange={(e) => updateDialogue(pagePanel.id, i, { text: e.target.value })}
                                                    placeholder="角色说的话"
                                                />
                                            </div>
                                            <Space>
                                                {line.audio && !lineAudioStale(line.audio, line.text, castVoiceOf(line.speaker, line.name).voice) ? (
                                                    <>
                                                        <Tag color="green">已配音 {Math.round(line.audio.durationMs / 100) / 10}s</Tag>
                                                        <Button size="small" icon={<SoundOutlined />} onClick={() => void playAudio(line.audio!.storageKey)}>试听</Button>
                                                    </>
                                                ) : line.audio ? <Tag color="orange">文字已改，配音过期</Tag> : <Tag>未配音</Tag>}
                                                <Button size="small" icon={<AudioOutlined />} loading={dubbingLine === `${pagePanel.id}:dlg:${i}`} onClick={() => void synthAndCommit(pagePanel.id, { kind: "dialogue", index: i })}>配音</Button>
                                                <Button size="small" danger icon={<DeleteOutlined />} onClick={() => removeDialogue(pagePanel.id, i)} />
                                            </Space>
                                        </div>
                                    ))}
                                    {cast.length > 0 ? <Button size="small" icon={<PlusOutlined />} onClick={() => addDialogue(pagePanel.id)}>添加对白</Button> : null}
                                </div>
                            </Space>
                        ) : (
                            <div style={{ fontSize: 13, opacity: 0.7 }}>{sideLabel[page.type]}没有绑定插画帧，先到「书册」或「帧」面板绑定。</div>
                        )
                    ) : null}

                    {rightTab === "panel" ? (
                        <Space direction="vertical" size={12} style={{ width: "100%" }}>
                            <div style={{ fontSize: 13, opacity: 0.7 }}>{sideLabel[page.type]}</div>
                            {page.type !== "end" ? (
                                <div>
                                    <div style={{ marginBottom: 4, fontSize: 13 }}>本页插画帧</div>
                                    <Select
                                        style={{ width: "100%" }}
                                        value={page.panel}
                                        options={[{ value: "", label: "（空）" }, ...panelOptions]}
                                        onChange={setPagePanel}
                                        showSearch
                                        optionFilterProp="label"
                                    />
                                </div>
                            ) : null}
                            {pagePanel ? (
                                <>
                                    <div>
                                        <div style={{ marginBottom: 4, fontSize: 13 }}>帧标题</div>
                                        <Input value={pagePanel.title} onChange={(e) => updatePanelMeta(pagePanel.id, { panelTitle: e.target.value })} />
                                    </div>
                                    <div>
                                        <div style={{ marginBottom: 4, fontSize: 13 }}>画面提示词（重摇读取）</div>
                                        <Input.TextArea rows={5} value={pagePanel.prompt} onChange={(e) => updatePanelMeta(pagePanel.id, { prompt: e.target.value })} />
                                    </div>
                                    <Space wrap>
                                        <Tag>{pagePanel.size}</Tag>
                                        <Tag>{pagePanel.refStorageKeys.length ? `角色参考 ${pagePanel.refStorageKeys.length}` : "无角色参考"}</Tag>
                                    </Space>
                                    {regenerating.get(pagePanel.id) ? (
                                        <Button danger icon={<StopOutlined />} onClick={() => cancelRegen(pagePanel.id)}>取消生成</Button>
                                    ) : (
                                        <Button icon={<ThunderboltOutlined />} onClick={() => void regeneratePanel(pagePanel.id)}>重新生成本页图</Button>
                                    )}
                                    <Button onClick={() => navigateGuarded(`/canvas/${encodeURIComponent(id ?? "")}`)}>在画布中打开</Button>
                                </>
                            ) : null}
                        </Space>
                    ) : null}

                    {rightTab === "audio" ? (
                        <Space direction="vertical" size={12} style={{ width: "100%" }}>
                            <div>
                                <div style={{ marginBottom: 4, fontSize: 13, fontWeight: 600 }}>音频模型</div>
                                <Select
                                    style={{ width: "100%" }}
                                    value={effectiveAudioModel || undefined}
                                    options={audioModelOptions.map((o) => ({ value: o.value, label: o.label }))}
                                    onChange={(model) => updateAudioConfig({ model })}
                                    placeholder="选择音频模型"
                                    notFoundContent="没有可用音频渠道。本地声线工坊：到「模型配置」添加渠道，地址 http://127.0.0.1:9890/v1、模型 voiceforge，本机免 API Key"
                                />
                                {audioModelOptions.length === 0 ? (
                                    <div style={{ fontSize: 12, color: "#d46b08", marginTop: 4 }}>
                                        没有可用音频渠道。本地 TTS：到「模型配置」添加音频渠道（地址 http://127.0.0.1:8765/v1、协议 OpenAI Audio、模型 indextts2），本机免 API Key。
                                    </div>
                                ) : null}
                                {usesPresetVoices ? <Tag color="green" style={{ marginTop: 6 }}>本地 TTS · 免费 · 预置音色</Tag> : null}
                            </div>
                            {audioProfile.showVoice ? (
                                <div>
                                    <div style={{ marginBottom: 4, fontSize: 13 }}>讲读者音色（旁白/画外音）</div>
                                    <AutoComplete
                                        style={{ width: "100%" }}
                                        value={usesPresetVoices ? narratorVoiceOf().voice : (audioCfg?.narratorVoice || "alloy")}
                                        options={voiceOptions}
                                        onChange={(narratorVoice) => updateAudioConfig({ narratorVoice })}
                                        placeholder="音色名"
                                    />
                                    {usesPresetVoices ? (
                                        <div style={{ fontSize: 12, opacity: 0.6, marginTop: 4 }}>
                                            预置音色由本地 TTS 固化，每次合成听感一致；可手动输入任意预置音色名（male-low / male-calm 等为男声）。
                                        </div>
                                    ) : null}
                                </div>
                            ) : null}
                            {audioProfile.showInstructions && !isForge ? (
                                <div>
                                    <div style={{ marginBottom: 4, fontSize: 13 }}>讲读语气（instructions）</div>
                                    <Input.TextArea
                                        rows={2}
                                        value={audioCfg?.narratorInstructions ?? ""}
                                        onChange={(e) => updateAudioConfig({ narratorInstructions: e.target.value })}
                                        placeholder={DEFAULT_NARRATOR_INSTRUCTIONS}
                                    />
                                </div>
                            ) : null}
                            {audioProfile.showSpeed ? (
                                <div>
                                    <div style={{ marginBottom: 4, fontSize: 13 }}>语速</div>
                                    <Select style={{ width: "100%" }} value={audioCfg?.speed || "0.9"} options={audioProfile.speedOptions.map((s) => ({ value: s, label: s }))} onChange={(speed) => updateAudioConfig({ speed })} />
                                </div>
                            ) : null}
                            {cast.length > 0 ? (
                                <div>
                                    <div style={{ marginBottom: 4, fontSize: 13, fontWeight: 600 }}>角色音色（对白）</div>
                                    {cast.map((c) => (
                                        <div key={c.key} style={{ border: "1px solid var(--border, #2a2d33)", borderRadius: 8, padding: 8, marginBottom: 8 }}>
                                            <div style={{ fontSize: 13, marginBottom: 6 }}>{c.name}</div>
                                            {audioProfile.showVoice ? (
                                                <AutoComplete
                                                    size="small"
                                                    style={{ width: "100%", marginBottom: 6 }}
                                                    value={usesPresetVoices ? castVoiceOf(c.key, c.name).voice : (config?.castVoices?.[c.key]?.voice || "alloy")}
                                                    options={voiceOptions}
                                                    onChange={(voice) => updateCastVoice(c.key, { voice })}
                                                    placeholder="音色名"
                                                />
                                            ) : null}
                                            {audioProfile.showInstructions && !isForge ? (
                                                <Input
                                                    size="small"
                                                    value={config?.castVoices?.[c.key]?.instructions ?? ""}
                                                    onChange={(e) => updateCastVoice(c.key, { instructions: e.target.value })}
                                                    placeholder={`${c.name}的说话语气（留空走讲读者）`}
                                                />
                                            ) : null}
                                        </div>
                                    ))}
                                </div>
                            ) : null}
                            {dubbing ? (
                                <Button danger icon={<StopOutlined />} block onClick={() => { dubStopRef.current = true; }}>停止配音（{dubbing.done}/{dubbing.total}）</Button>
                            ) : (
                                <Button type="primary" icon={<AudioOutlined />} block disabled={!effectiveAudioModel} onClick={() => void generateAllAudio()}>生成全部配音</Button>
                            )}
                            <div style={{ fontSize: 12, opacity: 0.6 }}>
                                配音按行保存进画布（旁白用讲读者音色，对白按说话人分音色）；文字改动后对应行标记过期，需重配。导出有声视频按各页音频时长自动排版。
                            </div>
                        </Space>
                    ) : null}

                    {rightTab === "book" ? (
                        <Space direction="vertical" size={12} style={{ width: "100%" }}>
                            <div>
                                <div style={{ marginBottom: 4, fontSize: 13 }}>书名</div>
                                <Input value={config.title} onChange={(e) => setBookField("title", e.target.value)} />
                            </div>
                            <div>
                                <div style={{ marginBottom: 4, fontSize: 13 }}>副题</div>
                                <Input value={config.subtitle} onChange={(e) => setBookField("subtitle", e.target.value)} />
                            </div>
                            <div>
                                <div style={{ marginBottom: 4, fontSize: 13 }}>封底语</div>
                                <Input value={config.pageEnd} onChange={(e) => setBookField("pageEnd", e.target.value)} />
                            </div>
                            <Space wrap>
                                <Tag>{orientation === "square" ? "方形开本" : "竖版开本"}</Tag>
                                <Tag>{config.pages.length} 页</Tag>
                            </Space>
                            <Space wrap>
                                <Button size="small" icon={<UpOutlined />} disabled={pageIndex === 0} onClick={() => movePage(-1)}>上移</Button>
                                <Button size="small" icon={<DownOutlined />} disabled={pageIndex >= config.pages.length - 1} onClick={() => movePage(1)}>下移</Button>
                                <Button size="small" danger icon={<DeleteOutlined />} disabled={config.pages.length <= 1} onClick={removePage}>删页</Button>
                            </Space>
                            <Space wrap>
                                <Button size="small" icon={<PlusOutlined />} onClick={() => insertPageAfter("full")}>插入正文页</Button>
                                <Button size="small" icon={<PlusOutlined />} onClick={() => insertPageAfter("cover")}>插入封面</Button>
                                <Button size="small" icon={<PlusOutlined />} onClick={() => insertPageAfter("end")}>插入封底</Button>
                            </Space>
                            {unreferencedPanels.length ? (
                                <div>
                                    <div style={{ marginBottom: 4, fontSize: 13, fontWeight: 600 }}>未入册帧</div>
                                    {unreferencedPanels.map((p) => (
                                        <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                                            <span style={{ fontSize: 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.id} {p.title}</span>
                                            <Button size="small" onClick={() => addPanelToBook(p.id)}>入册</Button>
                                        </div>
                                    ))}
                                </div>
                            ) : null}
                        </Space>
                    ) : null}
                </div>
            </div>
        </div>
    );
}
