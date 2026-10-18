import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { App, Button, Input, Select, Skeleton, Space, Tag, Tooltip } from "antd";
import { ArrowLeftOutlined, BlockOutlined, BookOutlined, DeleteOutlined, DownOutlined, DownloadOutlined, EditOutlined, LeftOutlined, LoadingOutlined, PictureOutlined, PlusOutlined, RedoOutlined, ReloadOutlined, RightOutlined, SaveOutlined, StopOutlined, ThunderboltOutlined, UndoOutlined, UpOutlined } from "@ant-design/icons";

import { http } from "@/services/api/request";
import { createZip } from "@/lib/zip";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

// ---------- 漫画数据合同（画布节点承载） ----------
// comic-config 文本节点 content：{ kind, subtitle, chapter, chapterEnd, pages }
// panel-* 图片节点：metadata.dialogue = Bubble[]，metadata.panelTitle/panelScene
type BubbleType = "speech" | "caption" | "thought" | "note";
type Bubble = {
    type: BubbleType;
    text: string;
    /** speech/thought/note：左上角归一化坐标与宽度 */
    x?: number;
    y?: number;
    w?: number;
    /** speech 尾巴指向（说话人大致方向） */
    tail?: "tl" | "tr" | "bl" | "br";
    /** caption：top | bottom */
    pos?: "top" | "bottom";
    /** note：竖排（卷宗字） */
    vertical?: boolean;
};
type ComicPage =
    | { type: "title" }
    | { type: "grid"; layout: GridLayoutId; panels: string[]; end?: boolean }
    | { type: "wide2" | "twoV"; panels: string[]; end?: boolean };
type ComicConfig = { subtitle: string; chapter: string; chapterEnd: string; pages: ComicPage[]; /* @deprecated 曾用于 StoryDiffusion 整页一致性生成（已下线）；保留字段兼容已存数据 */ roles?: string };

// ---------- 漫画式动态分格模板（渲染与导出共用同一几何） ----------
// areas 行×列命名格子；cols/rows 为相对占比。大格承载开场/闪回/高潮/章末。
type GridLayoutId = "quad" | "hero-top" | "hero-bottom" | "hero-left" | "1+2" | "top2+1";
type GridLayoutSpec = { cols: number[]; rows: number[]; areas: string[][] };
const GRID_LAYOUTS: Record<GridLayoutId, GridLayoutSpec> = {
    quad: { cols: [1, 1], rows: [1, 1], areas: [["a", "b"], ["c", "d"]] },
    "hero-top": { cols: [1, 1], rows: [1.25, 1], areas: [["a", "a"], ["b", "c"]] },
    "hero-bottom": { cols: [1, 1], rows: [1, 1.25], areas: [["a", "b"], ["c", "c"]] },
    "hero-left": { cols: [1.25, 1], rows: [1, 1], areas: [["a", "b"], ["a", "c"]] },
    "1+2": { cols: [1, 1], rows: [1.3, 1], areas: [["a", "a"], ["b", "c"]] },
    "top2+1": { cols: [1, 1], rows: [1, 1.3], areas: [["a", "b"], ["c", "c"]] },
};
function layoutRects(spec: GridLayoutSpec, x: number, y: number, w: number, h: number, gap: number): Record<string, { x: number; y: number; w: number; h: number }> {
    const colSum = spec.cols.reduce((a, b) => a + b, 0);
    const rowSum = spec.rows.reduce((a, b) => a + b, 0);
    const innerW = w - gap * (spec.cols.length - 1);
    const innerH = h - gap * (spec.rows.length - 1);
    const xs = spec.cols.map((_, i) => x + spec.cols.slice(0, i).reduce((a, b) => a + b, 0) / colSum * innerW + i * gap);
    const ys = spec.rows.map((_, j) => y + spec.rows.slice(0, j).reduce((a, b) => a + b, 0) / rowSum * innerH + j * gap);
    const ws = spec.cols.map((c) => c / colSum * innerW);
    const hs = spec.rows.map((r) => r / rowSum * innerH);
    const out: Record<string, { x: number; y: number; w: number; h: number }> = {};
    spec.areas.forEach((row, j) => row.forEach((cell, i) => {
        if (out[cell]) return; // 跨行/跨列取起点
        // span:向右/向下吞并同名格
        let spanC = 1, spanR = 1;
        while (i + spanC < row.length && row[i + spanC] === cell) spanC++;
        while (j + spanR < spec.areas.length && spec.areas[j + spanR][i] === cell) spanR++;
        out[cell] = {
            x: xs[i], y: ys[j],
            w: ws[i] + (spanC - 1) * gap + ws.slice(i + 1, i + spanC).reduce((a, b) => a + b, 0),
            h: hs[j] + (spanR - 1) * gap + hs.slice(j + 1, j + spanR).reduce((a, b) => a + b, 0),
        };
    }));
    return out;
}
function layoutGridStyle(spec: GridLayoutSpec): React.CSSProperties {
    return {
        display: "grid",
        gridTemplateColumns: spec.cols.map((c) => `${c}fr`).join(" "),
        gridTemplateRows: spec.rows.map((r) => `${r}fr`).join(" "),
        gridTemplateAreas: spec.areas.map((row) => `"${row.join(" ")}"`).join(" "),
    };
}
const LAYOUT_OPTIONS: Array<{ value: GridLayoutId; label: string }> = [
    { value: "1+2", label: "上大下二" },
    { value: "top2+1", label: "上二下大" },
    { value: "hero-top", label: "通栏大格上" },
    { value: "hero-bottom", label: "通栏大格下" },
    { value: "hero-left", label: "左侧大格" },
    { value: "quad", label: "四等分" },
];
const PAGE_TYPE_OPTIONS: Array<{ value: ComicPage["type"]; label: string }> = [
    { value: "grid", label: "格页" },
    { value: "wide2", label: "上下横幅" },
    { value: "twoV", label: "双竖+章末" },
    { value: "title", label: "扉页" },
];
type PanelNode = {
    id: string;
    title: string;
    scene: string;
    imageSrc: string | null;
    dialogue: Bubble[];
    nodeIndex: number;
    /** 生成合同（从节点 metadata 与连线解析），供重摇 */
    model: string;
    size: string;
    prompt: string;
    refStorageKeys: Array<{ storageKey: string; name: string }>;
};

/** 各页型的分格槽位数（grid 按版式去重格名计算） */
function pageSlotCount(page: ComicPage): number {
    if (page.type === "title") return 0;
    if (page.type === "grid") return new Set((GRID_LAYOUTS[page.layout] ?? GRID_LAYOUTS.quad).areas.flat()).size;
    return 2;
}
function pagePanelsOf(page: ComicPage): string[] {
    return page.type === "title" ? [] : page.panels;
}

const PAGE_W = 1654;
const PAGE_H = 2339;
const PAPER = "#f0eadb";
const INK = "#2b2621";

function parseComic(canvas: CanvasProject): { config: ComicConfig | null; panels: Map<string, PanelNode> } {
    const castStorage = new Map<string, string>();
    for (const node of canvas.nodes) {
        const md = (node.metadata ?? {}) as Record<string, unknown>;
        if (node.id.startsWith("cast-") && typeof md.storageKey === "string") castStorage.set(node.id, md.storageKey);
    }
    const panelRefs = new Map<string, string[]>();
    for (const conn of canvas.connections ?? []) {
        if (!conn.toNodeId?.startsWith("panel-")) continue;
        const list = panelRefs.get(conn.toNodeId) ?? [];
        if (conn.fromNodeId?.startsWith("cast-")) list.push(conn.fromNodeId);
        panelRefs.set(conn.toNodeId, list);
    }
    const panels = new Map<string, PanelNode>();
    let config: ComicConfig | null = null;
    canvas.nodes.forEach((node, index) => {
        const md = (node.metadata ?? {}) as Record<string, unknown>;
        if (node.type === "text" && node.id === "comic-config") {
            try {
                const parsed = JSON.parse(String(md.content ?? "{}"));
                if (parsed?.kind === "comic-config") config = parsed as ComicConfig;
            } catch { /* 配置损坏时按无漫画处理 */ }
            return;
        }
        if (node.type === "image" && node.id.startsWith("panel-")) {
            const pid = node.id.slice("panel-".length);
            const refs = panelRefs.get(node.id) ?? [];
            panels.set(pid, {
                id: pid,
                title: String(md.panelTitle ?? node.title ?? pid),
                scene: String(md.panelScene ?? ""),
                imageSrc: typeof md.content === "string" && md.content.startsWith("/api/") ? md.content : null,
                dialogue: Array.isArray(md.dialogue) ? (md.dialogue as Bubble[]) : [],
                nodeIndex: index,
                model: String(md.model ?? ""),
                size: String(md.size ?? "1152x1536"),
                prompt: String(md.prompt ?? ""),
                refStorageKeys: refs
                    .map((castId) => castStorage.get(castId))
                    .filter((key): key is string => !!key)
                    .map((key, i) => ({ storageKey: key, name: `ref-${i}.png` })),
            });
        }
    });
    return { config, panels };
}

// ---------- 成书页可编辑字段的写回合同 ----------
// 成书页能改的东西集中在 panel-* 节点 metadata 与 comic-config content；写回时把这些字段
// 整体覆盖到最新文档（revision 冲突则重拉重试），既不丢本地未保存编辑，也不动其他节点。
type EditOverlay = {
    panelMeta: Map<string, Record<string, unknown>>;
    configContent: string | null;
};
function collectEditOverlay(project: CanvasProject): EditOverlay {
    const panelMeta = new Map<string, Record<string, unknown>>();
    let configContent: string | null = null;
    for (const node of project.nodes) {
        const md = (node.metadata ?? {}) as Record<string, unknown>;
        if (node.id.startsWith("panel-") && node.type === "image") panelMeta.set(node.id, md);
        else if (node.id === "comic-config" && typeof md.content === "string") configContent = md.content;
    }
    return { panelMeta, configContent };
}
function applyEditOverlay(nodes: CanvasProject["nodes"], overlay: EditOverlay): CanvasProject["nodes"] {
    return nodes.map((node) => {
        const meta = overlay.panelMeta.get(node.id);
        if (meta) return { ...node, metadata: { ...(node.metadata ?? {}), ...meta } };
        if (node.id === "comic-config" && overlay.configContent) {
            return { ...node, metadata: { ...(node.metadata ?? {}), content: overlay.configContent } };
        }
        return node;
    });
}

// ---------- 气泡渲染（CSS，与导出 canvas 共享同一坐标合同） ----------
function BubbleView({ bubble, selected, onSelect, onMove, onDoubleClick }: { bubble: Bubble; selected: boolean; onSelect: () => void; onMove?: (patch: Partial<Bubble>) => void; onDoubleClick?: () => void }) {
    const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
        e.stopPropagation();
        onSelect();
        // click 会紧随 pointerdown 冒泡到页框把编辑面板关掉——这里吞掉单击/双击冒泡
        const swallow = (ev: MouseEvent) => ev.stopPropagation();
        const el = e.currentTarget;
        el.addEventListener("click", swallow, { capture: true, once: true });
        el.addEventListener("dblclick", swallow, { capture: true, once: true });
        setTimeout(() => { el.removeEventListener("click", swallow, { capture: true }); el.removeEventListener("dblclick", swallow, { capture: true }); }, 600);
        if (!onMove || bubble.type === "caption") return; // 通栏旁白条固定在格顶/底，不拖拽
        const frame = (e.currentTarget as HTMLElement).parentElement;
        if (!frame) return;
        const startX = e.clientX, startY = e.clientY;
        const ox = bubble.x ?? 0.1, oy = bubble.y ?? 0.1;
        const move = (ev: PointerEvent) => {
            const nx = Math.min(0.9, Math.max(0, ox + (ev.clientX - startX) / frame.clientWidth));
            const ny = Math.min(0.9, Math.max(0, oy + (ev.clientY - startY) / frame.clientHeight));
            onMove({ x: Number(nx.toFixed(3)), y: Number(ny.toFixed(3)) });
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    };
    const common: React.CSSProperties = {
        position: "absolute",
        cursor: onMove && bubble.type !== "caption" ? "grab" : "pointer",
        outline: selected ? "2px dashed #4a90d9" : undefined,
        outlineOffset: 2,
        touchAction: "none",
    };
    if (bubble.type === "caption") {
        const top = bubble.pos !== "bottom";
        return (
            <div
                onPointerDown={startDrag} onDoubleClick={(e) => { e.stopPropagation(); onDoubleClick?.(); }}
                style={{
                    ...common,
                    left: "2.5%", right: "2.5%", top: top ? "1%" : undefined, bottom: top ? undefined : "1%",
                    background: "rgba(248,244,232,0.9)",
                    border: "1px solid rgba(120,106,82,0.85)",
                    borderRadius: 6,
                    padding: "1.6% 3.2%",
                    fontFamily: "'KaiTi','STKaiti','楷体',serif",
                    fontSize: "clamp(12.5px, 2.3cqw, 24px)",
                    lineHeight: 1.55,
                    color: "#483a28",
                    textAlign: "center",
                    whiteSpace: "pre-wrap",
                    boxSizing: "border-box",
                }}
            >
                {bubble.text}
            </div>
        );
    }
    if (bubble.type === "thought") {
        return (
            <div
                onPointerDown={startDrag} onDoubleClick={(e) => { e.stopPropagation(); onDoubleClick?.(); }}
                style={{
                    ...common,
                    left: `${(bubble.x ?? 0.35) * 100}%`, top: `${(bubble.y ?? 0.05) * 100}%`, width: `${(bubble.w ?? 0.55) * 100}%`,
                    background: "rgba(250,250,248,0.94)",
                    border: `1.5px solid rgba(43,38,33,0.8)`,
                    borderRadius: "50% / 42%",
                    padding: "4% 4.5%",
                    boxShadow: "0 2px 8px rgba(43,38,33,0.18)",
                    fontFamily: "'KaiTi','STKaiti','楷体',serif",
                    fontSize: "clamp(12.5px, 2.2cqw, 23px)",
                    lineHeight: 1.5,
                    color: "#46403a",
                    textAlign: "center",
                    whiteSpace: "pre-wrap",
                    boxSizing: "border-box",
                }}
            >
                {bubble.text}
            </div>
        );
    }
    if (bubble.type === "note") {
        return (
            <div
                onPointerDown={startDrag} onDoubleClick={(e) => { e.stopPropagation(); onDoubleClick?.(); }}
                style={{
                    ...common,
                    left: `${(bubble.x ?? 0.15) * 100}%`, top: `${(bubble.y ?? 0.35) * 100}%`, width: bubble.vertical ? undefined : `${(bubble.w ?? 0.7) * 100}%`,
                    background: "rgba(246,240,222,0.72)",
                    border: "1px solid rgba(140,124,96,0.9)",
                    padding: "2% 2.5%",
                    fontFamily: "'KaiTi','STKaiti','楷体',serif",
                    fontSize: "clamp(12.5px, 2.3cqw, 24px)",
                    lineHeight: 1.55,
                    color: "#1e285a",
                    whiteSpace: "pre-wrap",
                    ...(bubble.vertical ? { writingMode: "vertical-rl" as const, letterSpacing: "0.35em" } : {}),
                    boxSizing: "border-box",
                }}
            >
                {bubble.text}
            </div>
        );
    }
    // speech：白底圆角框 + 尾巴（小三角）
    // 旋转方块法:45° 方形一半探出气泡边缘,底色盖住气泡边框,自身两侧描边构成尖角——无缝
    const BUBBLE_BG = "rgba(253,251,244,0.97)";
    const tailOffset: Record<string, React.CSSProperties> = {
        tl: { top: -8, left: "13%", borderLeft: `2px solid rgba(43,38,33,0.85)`, borderTop: `2px solid rgba(43,38,33,0.85)` },
        tr: { top: -8, right: "13%", borderLeft: `2px solid rgba(43,38,33,0.85)`, borderTop: `2px solid rgba(43,38,33,0.85)` },
        bl: { bottom: -8, left: "13%", borderRight: `2px solid rgba(43,38,33,0.85)`, borderBottom: `2px solid rgba(43,38,33,0.85)` },
        br: { bottom: -8, right: "13%", borderRight: `2px solid rgba(43,38,33,0.85)`, borderBottom: `2px solid rgba(43,38,33,0.85)` },
    };
    return (
        <div
            onPointerDown={startDrag} onDoubleClick={(e) => { e.stopPropagation(); onDoubleClick?.(); }}
            style={{
                ...common,
                left: `${(bubble.x ?? 0.1) * 100}%`, top: `${(bubble.y ?? 0.1) * 100}%`, width: `${(bubble.w ?? 0.5) * 100}%`,
                background: BUBBLE_BG,
                border: `2px solid rgba(43,38,33,0.85)`,
                borderRadius: 16,
                boxShadow: "0 2px 10px rgba(43,38,33,0.22)",
                padding: "3.2% 4.2%",
                fontFamily: "'KaiTi','STKaiti','楷体',serif",
                fontSize: "clamp(13px, 2.4cqw, 25px)",
                fontWeight: 600,
                lineHeight: 1.5,
                color: INK,
                textAlign: "center",
                whiteSpace: "pre-wrap",
                boxSizing: "border-box",
            }}
        >
            {bubble.tail ? <span aria-hidden style={{ position: "absolute", width: 15, height: 15, background: BUBBLE_BG, transform: "rotate(45deg)", ...tailOffset[bubble.tail] }} /> : null}
            {bubble.text}
        </div>
    );
}

function PanelFrame({ panel, editingKey, regenerating, onSelectBubble, onMoveBubble, onDoubleClickBubble, onSelectPanel, selected }: { panel: PanelNode; editingKey: string | null; regenerating: boolean; onSelectBubble: (key: string) => void; onMoveBubble: (index: number, patch: Partial<Bubble>) => void; onDoubleClickBubble: (index: number) => void; onSelectPanel: () => void; selected: boolean }) {
    return (
        <div
            onClick={(e) => { e.stopPropagation(); onSelectPanel(); }}
            style={{ position: "relative", containerType: "inline-size", background: "#d8d2c2", border: `2px solid ${selected ? "#4a90d9" : INK}`, overflow: "hidden", height: "100%", outline: selected ? "2px solid #4a90d9" : undefined, outlineOffset: 1 }}
        >
            {panel.imageSrc ? (
                <img src={panel.imageSrc} alt={panel.title} style={{ width: "100%", height: "100%", objectFit: "contain", background: PAPER, display: "block" }} />
            ) : (
                <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, color: "#787062", fontFamily: "'KaiTi','STKaiti',serif" }}>
                    <BookOutlined style={{ fontSize: 28 }} />
                    <div style={{ fontSize: 18 }}>{panel.id}</div>
                    <div style={{ fontSize: 13 }}>{panel.title}</div>
                    <Tag>待生成</Tag>
                </div>
            )}
            {panel.dialogue.map((b, i) => (
                <BubbleView key={i} bubble={b} selected={editingKey === `${panel.id}:${i}`} onSelect={() => onSelectBubble(`${panel.id}:${i}`)} onMove={(patch) => onMoveBubble(i, patch)} onDoubleClick={() => onDoubleClickBubble(i)} />
            ))}
            {regenerating ? (
                <div style={{ position: "absolute", inset: 0, background: "rgba(20,22,26,0.55)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, color: "#fff", fontSize: 13 }}>
                    <LoadingOutlined style={{ fontSize: 26 }} />
                    重新生成中…
                </div>
            ) : null}
        </div>
    );
}

// ---------- 页面 ----------
type TaskSummary = { id: string; status: string; resultJson?: string | null; error?: string | null };

export default function ComicBookPage() {
    const { id } = useParams();
    const navigate = useNavigate();
    const { message, modal } = App.useApp();
    const [canvas, setCanvas] = useState<CanvasProject | null>(null);
    const [loading, setLoading] = useState(true);
    const [pageIndex, setPageIndex] = useState(0);
    const [editing, setEditing] = useState<{ panelId: string; bubbleIndex: number } | null>(null);
    const [selectedPanel, setSelectedPanel] = useState<string | null>(null);
    const [regenerating, setRegenerating] = useState<Map<string, string>>(new Map());
    // 单帧重摇取消标记（UI 发 cancel，轮询循环见标记即退）；批量生成的停止标记
    const cancelRegenRef = useRef(new Set<string>());
    const batchStopRef = useRef(false);
    const [batching, setBatching] = useState<{ done: number; total: number; current: string } | null>(null);
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [exportPreview, setExportPreview] = useState<string | null>(null);
    const [exporting, setExporting] = useState<{ done: number; total: number } | null>(null);
    const [focusEditToken, setFocusEditToken] = useState(0);
    const editTextareaRef = useRef<HTMLTextAreaElement>(null);
    // 撤销/重做：栈存"每次编辑前"的文档快照；mergeKey 合并连续拖拽（600ms 同一气泡）
    const historyRef = useRef<{ stack: CanvasProject[]; ptr: number; lastKey: string; lastAt: number }>({ stack: [], ptr: -1, lastKey: "", lastAt: 0 });
    const [historyVersion, setHistoryVersion] = useState(0);
    const pageBoxRef = useRef<HTMLDivElement>(null);

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

    const { config, panels } = useMemo(() => (canvas ? parseComic(canvas) : { config: null, panels: new Map<string, PanelNode>() }), [canvas]);

    const save = useCallback(async () => {
        if (!canvas || !id) return;
        setSaving(true);
        try {
            // 本页可编辑字段集中在 panel-* metadata 与 comic-config content；画布页可能同时开着，
            // 409 时拉最新重试，覆盖层始终取当前本地文档
            const overlay = collectEditOverlay(canvas);
            let saved = false;
            let lastRevision: number | undefined;
            for (let attempt = 0; attempt < 3 && !saved; attempt++) {
                const fresh = attempt === 0
                    ? { project: canvas }
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
            message.success("已保存到画布（台词 / 帧配置 / 页面结构）");
        } catch (error) {
            message.error(`保存失败（画布可能在别处已更新，请刷新后重试）：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setSaving(false);
        }
    }, [canvas, id, message]);

    // 历史：stack 存历次编辑后的文档快照，ptr 指向当前；编辑函数只标记 pendingKey（拖拽 600ms 内合并），
    // load/写回/撤销恢复时置 suppress 跳过记录
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

    const updateBubble = useCallback((panelId: string, index: number, patch: Partial<Bubble>) => {
        pendingKeyRef.current = `bubble:${panelId}:${index}`;
        setCanvas((prev) => {
            if (!prev) return prev;
            const nodes = prev.nodes.map((node) => {
                if (node.id !== `panel-${panelId}`) return node;
                const md = { ...(node.metadata ?? {}) } as Record<string, unknown>;
                const dialogue = Array.isArray(md.dialogue) ? [...(md.dialogue as Bubble[])] : [];
                dialogue[index] = { ...dialogue[index], ...patch };
                md.dialogue = dialogue;
                return { ...node, metadata: md };
            });
            return { ...prev, nodes };
        });
        setDirty(true);
    }, []);

    // 键盘：←/→ 翻页；Ctrl+Z 撤销、Ctrl+Shift+Z / Ctrl+Y 重做（输入框内跳过，保留文本编辑自带撤销）
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
            if (e.key === "ArrowLeft" && pageIndex > 0) { setPageIndex(pageIndex - 1); setEditing(null); }
            if (e.key === "ArrowRight" && pageIndex < config.pages.length - 1) { setPageIndex(pageIndex + 1); setEditing(null); }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [config, pageIndex, undo, redo]);

    // 双击气泡后聚焦右侧文字编辑
    useEffect(() => {
        if (focusEditToken) editTextareaRef.current?.focus();
    }, [focusEditToken]);

    // ---------- comic-config 结构编辑：版式/页型/页序/增删页/分格槽位/书册元信息 ----------
    // 所有结构操作都改在本地 comic-config 节点上，随「保存」整体写回；撤销/重做自动生效
    const updateComicConfig = useCallback((mutate: (cfg: ComicConfig) => void) => {
        pendingKeyRef.current = "";
        setCanvas((prev) => {
            if (!prev) return prev;
            const nodes = prev.nodes.map((node) => {
                if (node.id !== "comic-config") return node;
                const md = { ...(node.metadata ?? {}) } as Record<string, unknown>;
                try {
                    const cfg = JSON.parse(String(md.content ?? "{}"));
                    if (cfg?.kind === "comic-config") {
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

    const changePageLayout = useCallback((layout: GridLayoutId) => updateComicConfig((cfg) => {
        const pg = cfg.pages[pageIndex];
        if (pg?.type === "grid") pg.layout = layout;
    }), [pageIndex, updateComicConfig]);

    const changePageType = useCallback((type: ComicPage["type"]) => updateComicConfig((cfg) => {
        const pg = cfg.pages[pageIndex];
        if (!pg) return;
        if (type === "title") { cfg.pages[pageIndex] = { type }; return; }
        const panels = pagePanelsOf(pg);
        const end = pg.type === "title" ? undefined : pg.end;
        cfg.pages[pageIndex] = type === "grid"
            ? { type, layout: pg.type === "grid" ? pg.layout : "quad", panels, end }
            : { type, panels, end };
    }), [pageIndex, updateComicConfig]);

    const togglePageEnd = useCallback(() => updateComicConfig((cfg) => {
        const pg = cfg.pages[pageIndex];
        if (pg && pg.type !== "title") pg.end = !pg.end;
    }), [pageIndex, updateComicConfig]);

    const movePage = useCallback((delta: 1 | -1) => {
        if (!config) return;
        const to = pageIndex + delta;
        if (to < 0 || to >= config.pages.length) return;
        updateComicConfig((cfg) => { [cfg.pages[pageIndex], cfg.pages[to]] = [cfg.pages[to], cfg.pages[pageIndex]]; });
        setPageIndex(to);
    }, [config, pageIndex, updateComicConfig]);

    const insertPageAfter = useCallback((type: ComicPage["type"]) => {
        updateComicConfig((cfg) => {
            const page: ComicPage = type === "title"
                ? { type }
                : type === "grid" ? { type, layout: "quad", panels: [] } : { type, panels: [] };
            cfg.pages.splice(pageIndex + 1, 0, page);
        });
        setPageIndex(pageIndex + 1);
        setEditing(null);
        setSelectedPanel(null);
    }, [pageIndex, updateComicConfig]);

    const removePage = useCallback(() => {
        if (!config || config.pages.length <= 1) return;
        const pg = config.pages[pageIndex];
        const label = pg.type === "title" ? "扉页" : `第 ${pageIndex + 1} 页`;
        modal.confirm({
            title: `删除${label}？`,
            content: pg.type !== "title" && pg.panels.length
                ? `本页 ${pg.panels.length} 帧会回到「未入册」池，不会被删除。`
                : "页面配置将从 comic-config 移除。",
            okButtonProps: { danger: true },
            okText: "删除",
            cancelText: "取消",
            onOk: () => {
                updateComicConfig((cfg) => { cfg.pages.splice(pageIndex, 1); });
                setPageIndex(Math.min(pageIndex, config.pages.length - 2));
                setEditing(null);
                setSelectedPanel(null);
            },
        });
    }, [config, pageIndex, modal, updateComicConfig]);

    /** 槽位换帧：替换语义——被换下的帧回未入册池；选他页帧=移动（原页移除） */
    const setSlotPanel = useCallback((slot: number, pid: string | null) => updateComicConfig((cfg) => {
        const pg = cfg.pages[pageIndex];
        if (!pg || pg.type === "title") return;
        const cur = [...pg.panels];
        let placed = -1;
        if (pid) {
            if (slot < cur.length) { cur[slot] = pid; placed = slot; }
            else { cur.push(pid); placed = cur.length - 1; }
        } else if (slot < cur.length) {
            cur.splice(slot, 1);
        }
        if (placed >= 0) {
            for (let i = cur.length - 1; i >= 0; i--) if (cur[i] === pid && i !== placed) cur.splice(i, 1);
        }
        for (const other of cfg.pages) {
            if (other === pg || other.type === "title") continue;
            const idx = other.panels.indexOf(pid ?? "");
            if (idx >= 0) other.panels.splice(idx, 1);
        }
        pg.panels = cur;
    }), [pageIndex, updateComicConfig]);

    const moveSlot = useCallback((slot: number, delta: 1 | -1) => updateComicConfig((cfg) => {
        const pg = cfg.pages[pageIndex];
        if (!pg || pg.type === "title") return;
        const to = slot + delta;
        if (to < 0 || to >= pg.panels.length) return;
        [pg.panels[slot], pg.panels[to]] = [pg.panels[to], pg.panels[slot]];
    }), [pageIndex, updateComicConfig]);

    /** 未入册帧入册：当前页 → 顺延找空位 → 都满则追加新格页 */
    const addPanelToBook = useCallback((pid: string) => updateComicConfig((cfg) => {
        const capacity = (pg: ComicPage) => pageSlotCount(pg) - pagePanelsOf(pg).length;
        let idx = cfg.pages.findIndex((pg, i) => i >= pageIndex && pg.type !== "title" && capacity(pg) > 0);
        if (idx < 0) idx = cfg.pages.findIndex((pg, i) => i < pageIndex && pg.type !== "title" && capacity(pg) > 0);
        if (idx < 0) { cfg.pages.push({ type: "grid", layout: "quad", panels: [pid] }); return; }
        const target = cfg.pages[idx];
        if (target.type !== "title") target.panels.push(pid);
    }), [pageIndex, updateComicConfig]);

    const setBookField = useCallback((key: "subtitle" | "chapter" | "chapterEnd", value: string) => updateComicConfig((cfg) => {
        cfg[key] = value;
    }), [updateComicConfig]);

    /** 帧配置编辑（标题/场景/提示词/尺寸），重摇读取的就是这些字段 */
    const updatePanelMeta = useCallback((panelId: string, patch: Record<string, unknown>) => {
        pendingKeyRef.current = `panel-meta:${panelId}`;
        setCanvas((prev) => {
            if (!prev) return prev;
            const nodes = prev.nodes.map((node) => (node.id === `panel-${panelId}`
                ? { ...node, metadata: { ...(node.metadata ?? {}), ...patch } }
                : node));
            return { ...prev, nodes };
        });
        setDirty(true);
    }, []);

    // 台词增删（改在本地 nodes，随「保存」写回）
    const addBubble = useCallback((panelId: string, bubble: Bubble) => {
        pendingKeyRef.current = "";
        setCanvas((prev) => {
            if (!prev) return prev;
            const nodes = prev.nodes.map((node) => {
                if (node.id !== `panel-${panelId}`) return node;
                const md = { ...(node.metadata ?? {}) } as Record<string, unknown>;
                md.dialogue = [...(Array.isArray(md.dialogue) ? md.dialogue : []), bubble];
                return { ...node, metadata: md };
            });
            return { ...prev, nodes };
        });
        setDirty(true);
    }, []);

    const removeBubble = useCallback((panelId: string, index: number) => {
        pendingKeyRef.current = "";
        setCanvas((prev) => {
            if (!prev) return prev;
            const nodes = prev.nodes.map((node) => {
                if (node.id !== `panel-${panelId}`) return node;
                const md = { ...(node.metadata ?? {}) } as Record<string, unknown>;
                const dialogue = Array.isArray(md.dialogue) ? [...(md.dialogue as Bubble[])] : [];
                dialogue.splice(index, 1);
                md.dialogue = dialogue;
                return { ...node, metadata: md };
            });
            return { ...prev, nodes };
        });
        setEditing(null);
        setDirty(true);
    }, []);

    // ---------- 帧重摇：画布同款任务链路（canvas_image + 逻辑模型），完成后写回节点并刷新 ----------
    // 返回是否成功（批量生成复用）。写回走 generated-assets（媒体节点必须带 asset 原子提交），
    // 提交前把本地未保存的台词/帧配置/comic-config 叠加到最新文档，重摇不再覆盖本地编辑。
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
        if (!canvas || !id) return false;
        const panel = parseComic(canvas).panels.get(pid);
        if (!panel || !panel.model) { message.error("该帧缺少模型配置"); return false; }
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
            // POST/GET /tasks 的 data 均为任务对象本身
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
            // 写回画布：媒体节点带 assetId，必须走 generated-assets 通道（新 asset + 文档原子提交），
            // 直接 PUT 画布会被 canvas_asset_guard 拒（媒体与素材库不一致）。画布页可能同时开着，
            // 撞 revision 时拉最新重试。
            const overlay = collectEditOverlay(canvas);
            let written = false;
            for (let attempt = 0; attempt < 3 && !written; attempt++) {
                const fresh = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`);
                const doc = fresh.project;
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
                const nodes = applyEditOverlay(doc.nodes, overlay).map((node) => (node.id === `panel-${pid}`
                    ? { ...node, metadata: { ...(node.metadata ?? {}), ...imagePatch } }
                    : node));
                const asset = {
                    id: assetId,
                    kind: "image",
                    category: "material",
                    status: "ready",
                    primaryVersionId: crypto.randomUUID().replace(/-/g, ""),
                    title: `${pid} ${panels.get(pid)?.title ?? ""}`.trim(),
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
                    metadata: { generationEffectKey: `comic-regen:${pid}:${now}`, nodeId: `panel-${pid}`, outputIndex: 0, source: "generation-task" },
                    tags: [],
                };
                try {
                    // 两步写回（后端已退役 generated-assets 原子通道）
                    await http.put(`/assets/${encodeURIComponent(asset.id)}`, { asset });
                    const res = await http.put<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`, { project: { ...doc, nodes }, assets: [] });
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
    }, [canvas, id, message, panels, pollTaskUntilDone]);

    const cancelRegen = useCallback((pid: string) => {
        cancelRegenRef.current.add(pid);
        const tid = regenerating.get(pid);
        if (tid && tid !== "pending") void http.post(`/tasks/${encodeURIComponent(tid)}/cancel`).catch(() => undefined);
    }, [regenerating]);

    // ---------- 整页重做：本页每帧依次走「重新生成本帧」同款链路（各自模型+角色参考卡），串行防显存挤兑 ----------
    const generatePage = useCallback(async (): Promise<boolean> => {
        if (!config) return false;
        const page = config.pages[pageIndex];
        if (!page || page.type === "title") return false;
        const pids = pagePanelsOf(page).filter((pid) => panels.has(pid));
        if (!pids.length) { message.error("本页没有可生成的帧"); return false; }
        let ok = 0;
        let fail = 0;
        for (const pid of pids) {
            // 任一帧点了取消即停止后续帧
            if (pids.some((p) => cancelRegenRef.current.has(p))) break;
            if (await regeneratePanel(pid)) ok++; else fail++;
        }
        const stopped = pids.some((p) => cancelRegenRef.current.has(p));
        pids.forEach((p) => cancelRegenRef.current.delete(p));
        if (stopped) message.info(`已停止整页重做（完成 ${ok} 帧）`);
        else if (fail) message.warning(`整页重做完成：成功 ${ok} 帧，失败 ${fail} 帧`);
        else message.success(`第 ${pageIndex + 1} 页整页重做完成（${ok} 帧）`);
        return fail === 0;
    }, [config, pageIndex, panels, message, regeneratePanel]);

    // ---------- 批量生成缺帧：按册内顺序串行重摇（本地网关一次一张），可中途停止 ----------
    const generateMissing = useCallback(async () => {
        if (!config || !canvas || batching) return;
        const all = parseComic(canvas).panels;
        const referenced = new Set(config.pages.flatMap((pg) => pagePanelsOf(pg)));
        const noModel: string[] = [];
        const missing: string[] = [];
        for (const p of all.values()) {
            if (!referenced.has(p.id) || p.imageSrc) continue;
            if (p.model) missing.push(p.id); else noModel.push(p.id);
        }
        if (noModel.length) message.warning(`${noModel.join("、")} 缺少模型配置，已跳过`);
        if (!missing.length) { message.info("没有待生成的帧"); return; }
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
        if (stopped) message.info(`已停止批量生成（完成 ${ok} 帧）`);
        else message.success(`批量生成完成：成功 ${ok} 帧${fail ? `，失败 ${fail} 帧` : ""}`);
    }, [config, canvas, batching, regeneratePanel, message]);

    const stopBatch = useCallback(() => {
        batchStopRef.current = true;
        if (batching) cancelRegen(batching.current);
    }, [batching, cancelRegen]);

    const renderPageCanvas = useCallback(async (pageIdx: number) => {
        if (!config) return null;
        const page = config.pages[pageIdx];
        const canvasEl = document.createElement("canvas");
        canvasEl.width = PAGE_W;
        canvasEl.height = PAGE_H;
        const ctx = canvasEl.getContext("2d");
        if (!ctx || !page) return null;
        ctx.fillStyle = PAPER;
        ctx.fillRect(0, 0, PAGE_W, PAGE_H);
        const kai = "'KaiTi','STKaiti','楷体',serif";
        const loadImg = (src: string) => new Promise<HTMLImageElement | null>((resolve) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = src;
        });
        const drawPanel = async (pid: string, x: number, y: number, w: number, h: number) => {
            const panel = panels.get(pid);
            ctx.strokeStyle = INK;
            ctx.lineWidth = 3;
            let rect = { x, y, w, h };
            if (panel?.imageSrc) {
                const img = await loadImg(panel.imageSrc);
                if (img) {
                    const r = Math.min(w / img.width, h / img.height);
                    const iw = img.width * r, ih = img.height * r;
                    const dx = x + (w - iw) / 2, dy = y + (h - ih) / 2;
                    ctx.drawImage(img, dx, dy, iw, ih);
                    ctx.strokeRect(dx, dy, iw, ih);
                    rect = { x: dx, y: dy, w: iw, h: ih };
                } else {
                    ctx.fillStyle = "#d8d2c2";
                    ctx.fillRect(x, y, w, h);
                    ctx.strokeRect(x, y, w, h);
                }
            } else {
                ctx.fillStyle = "#d8d2c2";
                ctx.fillRect(x, y, w, h);
                ctx.strokeRect(x, y, w, h);
                ctx.fillStyle = "#787062";
                ctx.font = `40px ${kai}`;
                ctx.textAlign = "center";
                ctx.fillText(panel ? `${panel.id} ${panel.title}（待生成）` : pid, x + w / 2, y + h / 2);
            }
            if (panel) for (const b of panel.dialogue) drawBubble(ctx, b, rect, kai);
        };
        const drawBubble = (c: CanvasRenderingContext2D, b: Bubble, r: { x: number; y: number; w: number; h: number }, kaiFont: string) => {
            const fs = Math.max(24, Math.min(34, Math.round(r.w / 34)));
            if (b.type === "caption") {
                const font = `${fs + 2}px ${kaiFont}`;
                const lines = wrapText(b.text, font, r.w - fs * 3);
                const lh = fs * 1.55, barh = lines.length * lh + fs;
                const by = b.pos === "top" ? r.y + 10 : r.y + r.h - barh - 10;
                c.save();
                c.fillStyle = "rgba(248,244,232,0.88)";
                c.strokeStyle = "rgba(120,106,82,0.9)";
                c.lineWidth = 2;
                roundRectPath(c, r.x + 10, by, r.w - 20, barh, 8);
                c.fill(); c.stroke();
                c.fillStyle = "#483a28";
                c.font = font;
                c.textAlign = "center";
                lines.forEach((ln, i) => c.fillText(ln, r.x + r.w / 2, by + fs * 0.9 + i * lh + fs * 0.35));
                c.restore();
                return;
            }
            if (b.type === "note") {
                c.save();
                const font = `${fs + 2}px ${kaiFont}`;
                if (b.vertical) {
                    const chars = b.text.replace(/\s/g, "");
                    const perCol = Math.max(4, Math.floor((r.h * 0.55) / (fs * 1.4)));
                    const cols = Array.from({ length: Math.ceil(chars.length / perCol) }, (_, i) => chars.slice(i * perCol, (i + 1) * perCol));
                    const totalW = cols.length * fs * 1.6 + fs;
                    const bx = r.x + r.w * (b.x ?? 0.6) - totalW;
                    const by = r.y + r.h * (b.y ?? 0.15);
                    const bh = perCol * fs * 1.4;
                    c.fillStyle = "rgba(246,240,222,0.75)";
                    c.fillRect(bx - fs / 2, by - fs / 2, totalW, bh + fs);
                    c.fillStyle = "#1e285a";
                    c.font = font;
                    c.textAlign = "center";
                    cols.forEach((col, ci) => {
                        const cx = bx + totalW - fs / 2 - ci * fs * 1.6 - fs / 2;
                        col.split("").forEach((ch, ii) => c.fillText(ch, cx, by + fs * 0.9 + ii * fs * 1.4));
                    });
                } else {
                    const bw = r.w * (b.w ?? 0.7), pad = fs * 0.8;
                    const lines = wrapText(b.text, font, bw - pad * 2);
                    const lh = fs * 1.5, bh = lines.length * lh + pad * 2;
                    const bx = r.x + r.w * (b.x ?? 0.15), by = r.y + r.h * (b.y ?? 0.4);
                    c.fillStyle = "rgba(246,240,222,0.78)";
                    c.strokeStyle = "rgba(140,124,96,0.9)";
                    c.lineWidth = 2;
                    c.fillRect(bx, by, bw, bh);
                    c.strokeRect(bx, by, bw, bh);
                    c.fillStyle = "#1e285a";
                    c.font = font;
                    c.textAlign = "left";
                    lines.forEach((ln, i) => c.fillText(ln, bx + pad, by + pad + fs * 0.55 + i * lh));
                }
                c.restore();
                return;
            }
            // speech / thought
            const bw = r.w * (b.w ?? 0.5);
            const fs2 = Math.max(22, Math.min(30, Math.round(r.w / 36)));
            const font = `${fs2 + 1}px ${kaiFont}`;
            const pad = fs2 * 0.7;
            const lines = wrapText(b.text, font, bw - pad * 2);
            const lh = fs2 * 1.45;
            let bh = lines.length * lh + pad * 2;
            let bx = r.x + r.w * (b.x ?? 0.1);
            let by = r.y + r.h * (b.y ?? 0.1);
            if (b.type === "thought") bh += fs2 * 1.4; // 椭圆留边
            bx = Math.min(Math.max(bx, r.x + 8), r.x + r.w - bw - 8);
            by = Math.min(Math.max(by, r.y + 8), r.y + r.h - bh - 8);
            c.save();
            c.fillStyle = b.type === "thought" ? "rgba(250,250,248,0.94)" : "rgba(255,255,255,0.97)";
            c.strokeStyle = INK;
            c.lineWidth = 3;
            if (b.type === "thought") {
                c.beginPath();
                c.ellipse(bx + bw / 2, by + bh / 2, bw / 2, bh / 2, 0, 0, Math.PI * 2);
                c.fill(); c.stroke();
                c.beginPath();
                c.arc(bx + bw / 2 - 24, by + bh + 14, 6, 0, Math.PI * 2);
                c.arc(bx + bw / 2 - 36, by + bh + 28, 4, 0, Math.PI * 2);
                c.fill(); c.stroke();
            } else {
                roundRectPath(c, bx, by, bw, bh, 14);
                c.fill(); c.stroke();
                if (b.tail) {
                    const tx = b.tail.includes("l") ? bx + bw * 0.18 : bx + bw * 0.82;
                    const ty = b.tail[0] === "t" ? by : by + bh;
                    const dy = b.tail[0] === "t" ? -42 : 42;
                    c.beginPath();
                    c.moveTo(tx, ty);
                    c.lineTo(tx + (b.tail.includes("l") ? -26 : 26), ty + dy);
                    c.lineTo(tx + (b.tail.includes("l") ? 16 : -16), ty);
                    c.closePath();
                    c.fillStyle = "rgba(255,255,255,0.97)";
                    c.fill();
                    c.beginPath();
                    c.moveTo(tx, ty);
                    c.lineTo(tx + (b.tail.includes("l") ? -26 : 26), ty + dy);
                    c.stroke();
                }
            }
            c.fillStyle = b.type === "thought" ? "#46403a" : INK;
            c.font = font;
            c.textAlign = "center";
            lines.forEach((ln, i) => c.fillText(ln, bx + bw / 2, by + pad + fs2 * 0.42 + i * lh + (b.type === "thought" ? fs2 * 0.7 : 0)));
            c.restore();
        };
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
        if (page.type === "title") {
            ctx.fillStyle = INK;
            ctx.textAlign = "center";
            ctx.font = `54px ${kai}`;
            ctx.fillText(config.subtitle, PAGE_W / 2, 560);
            ctx.font = `110px ${kai}`;
            ctx.fillText(config.chapter, PAGE_W / 2, 760);
            ctx.fillRect(PAGE_W / 2 - 300, 830, 600, 4);
            ctx.font = `40px ${kai}`;
            ctx.fillStyle = "#5a5042";
            ctx.fillText("梦非虚妄，乃心之实相。", PAGE_W / 2, 960);
            ctx.fillText("文思之力，可载道，亦可成魔。", PAGE_W / 2, 1040);
        } else if (page.type === "grid") {
            const spec = GRID_LAYOUTS[page.layout] ?? GRID_LAYOUTS.quad;
            const m = 36, gap = 26, top = 100;
            const rects = layoutRects(spec, m, top, PAGE_W - m * 2, PAGE_H - top - m - (page.end ? 150 : 0), gap);
            const slots = ["a", "b", "c", "d"];
            for (let i = 0; i < Math.min(slots.length, page.panels.length); i++) {
                const r = rects[slots[i]];
                if (r) await drawPanel(page.panels[i], r.x, r.y, r.w, r.h);
            }
        } else if (page.type === "wide2" || page.type === "twoV") {
            const m = 36, gap = 30, top = 100;
            if (page.type === "wide2") {
                const gh = (PAGE_H - top - m - gap) / 2;
                await drawPanel(page.panels[0], m, top, PAGE_W - m * 2, gh);
                await drawPanel(page.panels[1], m, top + gh + gap, PAGE_W - m * 2, gh);
            } else {
                const gw = (PAGE_W - m * 2 - gap) / 2, gh = PAGE_H - top - m - 320;
                await drawPanel(page.panels[0], m, top, gw, gh);
                await drawPanel(page.panels[1], m + gw + gap, top, gw, gh);
                ctx.fillStyle = INK;
                ctx.font = `56px ${kai}`;
                ctx.textAlign = "center";
                ctx.fillText(config.chapterEnd, PAGE_W / 2, PAGE_H - 300);
            }
        }
        // 页眉页码
        if (page.type !== "title") {
            ctx.fillStyle = "#6e6454";
            ctx.font = `30px ${kai}`;
            ctx.textAlign = "center";
            ctx.fillText(config.chapter, PAGE_W / 2, 44);
            ctx.fillText(`- ${pageIdx + 1} -`, PAGE_W - 90, PAGE_H - 52);
        }
        return canvasEl;
    }, [config, panels]);

    const downloadBlob = useCallback((blob: Blob, name: string) => {
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
    }, []);

    const exportPagePng = useCallback(async () => {
        const canvasEl = await renderPageCanvas(pageIndex);
        if (!canvasEl) return;
        const blob = await new Promise<Blob | null>((resolve) => canvasEl.toBlob(resolve, "image/png"));
        if (!blob) return;
        setExportPreview(canvasEl.toDataURL("image/png"));
        try {
            downloadBlob(blob, `page-${String(pageIndex + 1).padStart(2, "0")}.png`);
            message.success(`已导出第 ${pageIndex + 1} 页`);
        } catch {
            message.info("浏览器拦截了自动下载，已在右侧展示导出预览，可右键另存");
        }
    }, [renderPageCanvas, pageIndex, downloadBlob, message]);

    const exportAllZip = useCallback(async () => {
        if (!config) return;
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
            downloadBlob(zipBlob, `${(config.chapter || "comic").replace(/[\\/:*?"<>|]/g, "_")}.zip`);
            message.success(`已导出全部 ${files.length} 页（zip）`);
        } catch (error) {
            message.error(`导出失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setExporting(null);
        }
    }, [config, renderPageCanvas, downloadBlob, message]);

    const exportLongStrip = useCallback(async () => {
        if (!config) return;
        setExporting({ done: 0, total: config.pages.length });
        try {
            const pages: HTMLCanvasElement[] = [];
            for (let i = 0; i < config.pages.length; i++) {
                const canvasEl = await renderPageCanvas(i);
                if (canvasEl) pages.push(canvasEl);
                setExporting({ done: i + 1, total: config.pages.length });
            }
            const gap = 24;
            const strip = document.createElement("canvas");
            strip.width = PAGE_W;
            strip.height = pages.length * PAGE_H + (pages.length - 1) * gap;
            const sctx = strip.getContext("2d");
            if (!sctx) throw new Error("canvas 不可用");
            sctx.fillStyle = "#1a1c20";
            sctx.fillRect(0, 0, strip.width, strip.height);
            pages.forEach((p, i) => sctx.drawImage(p, 0, i * (PAGE_H + gap)));
            const blob = await new Promise<Blob | null>((resolve) => strip.toBlob(resolve, "image/png"));
            if (!blob) throw new Error("长图编码失败");
            setExportPreview(strip.toDataURL("image/png"));
            downloadBlob(blob, `${(config.chapter || "comic").replace(/[\\/:*?"<>|]/g, "_")}-长图.png`);
            message.success(`已导出整章长图（${pages.length} 页拼接）`);
        } catch (error) {
            message.error(`导出失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setExporting(null);
        }
    }, [config, renderPageCanvas, downloadBlob, message]);

    if (loading) {
        return <div style={{ padding: 24 }}><Skeleton active paragraph={{ rows: 10 }} /></div>;
    }
    if (!canvas || !config || config.pages.length === 0) {
        return (
            <div style={{ padding: 48, color: "var(--muted, #8b929e)" }}>
                该画布没有漫画集配置（缺少 comic-config 节点或页面为空）。
            </div>
        );
    }

    const page = config.pages[pageIndex];
    const referencedPanelIds = new Set(config.pages.flatMap((pg) => pagePanelsOf(pg)));
    const missingPanels = [...panels.values()].filter((p) => referencedPanelIds.has(p.id) && !p.imageSrc);
    const editingPanel = editing ? panels.get(editing.panelId) : null;
    const editingBubble = editingPanel && editing ? (editingPanel.dialogue[editing.bubbleIndex] ?? null) : null;

    return (
        <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--background, #14161a)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", borderBottom: "1px solid var(--border, #2a2d33)", flexWrap: "wrap" }}>
                <Button icon={<ArrowLeftOutlined />} onClick={() => history.back()} aria-label="返回" />
                <span style={{ fontWeight: 600, fontSize: 15 }}>{config.subtitle} · {config.chapter}</span>
                <Tag color="blue">{panels.size} 帧</Tag>
                {dirty && <Tag color="orange">未保存</Tag>}
                <Space style={{ marginLeft: "auto" }} wrap>
                    {page.type === "grid" ? (
                        <Select
                            size="small"
                            style={{ width: 130 }}
                            value={page.layout}
                            onChange={(v) => changePageLayout(v as GridLayoutId)}
                            options={LAYOUT_OPTIONS.map((o) => ({ value: o.value, label: `版式：${o.label}` }))}
                        />
                    ) : null}
                    <Button icon={<UndoOutlined />} disabled={!canUndo} title="撤销 (Ctrl+Z)" onClick={undo} />
                    <Button icon={<RedoOutlined />} disabled={!canRedo} title="重做 (Ctrl+Shift+Z)" onClick={redo} />
                    {batching ? (
                        <>
                            <Tag color="processing">批量生成 {Math.min(batching.done + 1, batching.total)}/{batching.total} · {batching.current}</Tag>
                            <Button icon={<StopOutlined />} onClick={stopBatch}>停止</Button>
                        </>
                    ) : (
                        <Button
                            icon={<ThunderboltOutlined />}
                            disabled={!missingPanels.length}
                            title={missingPanels.length ? `串行生成 ${missingPanels.length} 个缺帧（按册内顺序）` : "没有待生成的帧"}
                            onClick={() => void generateMissing()}
                        >
                            生成缺帧{missingPanels.length ? ` (${missingPanels.length})` : ""}
                        </Button>
                    )}
                    {page.type !== "title" && pagePanelsOf(page).length > 0 ? (
                        <Button
                            icon={<BlockOutlined />}
                            title="本页每帧依次用各自模型重做（带角色卡的帧走参考图锚定），串行执行"
                            loading={pagePanelsOf(page).some((pid) => regenerating.has(pid))}
                            onClick={() => void generatePage()}
                        >
                            整页重做
                        </Button>
                    ) : null}
                    <Button icon={<ReloadOutlined />} onClick={() => { if (id) navigate(`/canvas/${id}`); }}>打开画布</Button>
                    <Button icon={<ReloadOutlined />} onClick={() => void load()}>刷新</Button>
                    <Button icon={<SaveOutlined />} type="primary" loading={saving} disabled={!dirty} onClick={() => void save()}>保存</Button>
                    <Button icon={<DownloadOutlined />} onClick={() => void exportPagePng()}>导出本页</Button>
                    <Button icon={<DownloadOutlined />} loading={!!exporting} onClick={() => void exportAllZip()}>导出全部(zip)</Button>
                    <Button icon={<DownloadOutlined />} loading={!!exporting} onClick={() => void exportLongStrip()}>导出长图</Button>
                    {exporting ? <Tag color="processing">导出中 {exporting.done}/{exporting.total}</Tag> : null}
                </Space>
            </div>
            <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
                <div style={{ width: 132, overflowY: "auto", borderRight: "1px solid var(--border, #2a2d33)", padding: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                    {config.pages.map((p, i) => (
                        <button
                            key={i}
                            onClick={() => { setPageIndex(i); setEditing(null); }}
                            aria-pressed={i === pageIndex}
                            style={{
                                border: i === pageIndex ? "2px solid #4a90d9" : "1px solid var(--border, #3a3d43)",
                                borderRadius: 6, background: PAPER, color: "#4a4136",
                                padding: "14px 4px", fontSize: 12, cursor: "pointer", fontFamily: "'KaiTi',serif",
                            }}
                        >
                            {p.type === "title" ? "扉页" : `${i + 1}`}
                        </button>
                    ))}
                </div>
                <div style={{ flex: 1, overflow: "auto", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: 20 }}>
                    <div
                        ref={pageBoxRef}
                        onClick={() => setEditing(null)}
                        onDoubleClick={() => setSelectedPanel(null)}
                        style={{
                            width: "min(100%, 620px)", aspectRatio: `${PAGE_W}/${PAGE_H}`, background: PAPER,
                            boxShadow: "0 12px 40px rgba(0,0,0,0.5)", borderRadius: 4, padding: "4.5% 2.2% 3% 2.2%",
                            boxSizing: "border-box", display: "flex", flexDirection: "column", gap: "2%",
                        }}
                    >
                        {page.type === "title" ? (
                            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 18, color: INK, fontFamily: "'KaiTi','STKaiti',serif" }}>
                                <div style={{ fontSize: "clamp(18px, 3.4cqw, 30px)", opacity: 0.85 }}>{config.subtitle}</div>
                                <div style={{ fontSize: "clamp(26px, 6cqw, 54px)", fontWeight: 700 }}>{config.chapter}</div>
                                <div style={{ width: "38%", height: 2, background: INK }} />
                                <div style={{ fontSize: "clamp(14px, 2.6cqw, 22px)", color: "#5a5042", textAlign: "center", lineHeight: 1.9 }}>
                                    梦非虚妄，乃心之实相。<br />文思之力，可载道，亦可成魔。
                                </div>
                            </div>
                        ) : (() => {
                            // 漫画式动态分格 / 横幅页
                            const isWide = page.type === "wide2";
                            const isTwoV = page.type === "twoV";
                            const spec = page.type === "grid" ? (GRID_LAYOUTS[page.layout] ?? GRID_LAYOUTS.quad) : null;
                            return (
                            <div style={{
                                flex: 1, display: "grid", minHeight: 0, gap: "1.6%",
                                ...(isWide ? { gridTemplateColumns: "1fr", gridTemplateRows: "1fr 1fr" } : isTwoV ? { gridTemplateColumns: "1fr 1fr" } : spec ? layoutGridStyle(spec) : {}),
                            }}>
                                {page.panels.filter((pid) => panels.has(pid)).map((pid, i) => {
                                    const slot = ["a", "b", "c", "d"][i];
                                    return (
                                        <div key={pid} style={{ position: "relative", minHeight: 0, ...(spec ? { gridArea: slot } : {}) }}>
                                            <PanelFrame
                                                panel={panels.get(pid)!}
                                                editingKey={editing ? `${editing.panelId}:${editing.bubbleIndex}` : null}
                                                regenerating={regenerating.has(pid)}
                                                selected={selectedPanel === pid}
                                                onSelectBubble={(key) => { const [panelId, idx] = key.split(":"); setEditing({ panelId, bubbleIndex: Number(idx) }); setSelectedPanel(panelId); }}
                                                onMoveBubble={(idx, patch) => updateBubble(pid, idx, patch)}
                                            onDoubleClickBubble={(idx) => { setEditing({ panelId: pid, bubbleIndex: idx }); setSelectedPanel(pid); setFocusEditToken(Date.now()); }}
                                                onSelectPanel={() => { setSelectedPanel(pid); setEditing(null); }}
                                            />
                                        </div>
                                    );
                                })}
                                {page.end ? (
                                    <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "2.5% 0", fontFamily: "'KaiTi',serif", color: INK, fontSize: "clamp(16px, 3cqw, 26px)" }}>
                                        {config.chapterEnd}
                                    </div>
                                ) : null}
                            </div>
                            );
                        })()}
                    </div>
                </div>
                {editingBubble && editing ? (
                    <div style={{ width: 300, borderLeft: "1px solid var(--border, #2a2d33)", padding: 16, overflowY: "auto" }}>
                        <div style={{ fontWeight: 600, marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
                            <EditOutlined /> 编辑台词 · {editing.panelId}
                        </div>
                        <div style={{ fontSize: 12, opacity: 0.65, marginBottom: 12 }}>{editingPanel?.title}</div>                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                            <div>
                                <div style={{ fontSize: 12, marginBottom: 4 }}>类型</div>
                                <Select<BubbleType>
                                    style={{ width: "100%" }}
                                    value={editingBubble.type}
                                    options={[
                                        { value: "speech", label: "对白气泡" },
                                        { value: "caption", label: "旁白条" },
                                        { value: "thought", label: "内心独白" },
                                        { value: "note", label: "纸笺/卷宗字" },
                                    ]}
                                    onChange={(v) => updateBubble(editing.panelId, editing.bubbleIndex, { type: v })}
                                />
                            </div>
                            <div>
                                <div style={{ fontSize: 12, marginBottom: 4 }}>文字</div>
                                <Input.TextArea
                                    ref={editTextareaRef as never}
                                    rows={4}
                                    value={editingBubble.text}
                                    onChange={(e) => updateBubble(editing.panelId, editing.bubbleIndex, { text: e.target.value })}
                                />
                            </div>
                            <Button danger size="small" onClick={() => removeBubble(editing.panelId, editing.bubbleIndex)}>删除这条台词</Button>
                            {editingBubble.type === "caption" ? (
                                <div>
                                    <div style={{ fontSize: 12, marginBottom: 4 }}>位置</div>
                                    <Select
                                        style={{ width: "100%" }}
                                        value={editingBubble.pos ?? "bottom"}
                                        options={[{ value: "top", label: "格顶" }, { value: "bottom", label: "格底" }]}
                                        onChange={(v) => updateBubble(editing.panelId, editing.bubbleIndex, { pos: v })}
                                    />
                                </div>
                            ) : (
                                <>
                                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}>
                                        <label style={{ fontSize: 12 }}>X {((editingBubble.x ?? 0.1) * 100).toFixed(0)}%
                                            <input type="range" min={0} max={90} value={Math.round((editingBubble.x ?? 0.1) * 100)} onChange={(e) => updateBubble(editing.panelId, editing.bubbleIndex, { x: Number(e.target.value) / 100 })} style={{ width: "100%" }} />
                                        </label>
                                        <label style={{ fontSize: 12 }}>Y {((editingBubble.y ?? 0.1) * 100).toFixed(0)}%
                                            <input type="range" min={0} max={90} value={Math.round((editingBubble.y ?? 0.1) * 100)} onChange={(e) => updateBubble(editing.panelId, editing.bubbleIndex, { y: Number(e.target.value) / 100 })} style={{ width: "100%" }} />
                                        </label>
                                        <label style={{ fontSize: 12 }}>宽 {((editingBubble.w ?? 0.5) * 100).toFixed(0)}%
                                            <input type="range" min={15} max={90} value={Math.round((editingBubble.w ?? 0.5) * 100)} onChange={(e) => updateBubble(editing.panelId, editing.bubbleIndex, { w: Number(e.target.value) / 100 })} style={{ width: "100%" }} />
                                        </label>
                                    </div>
                                    {editingBubble.type === "speech" ? (
                                        <div>
                                            <div style={{ fontSize: 12, marginBottom: 4 }}>尾巴指向（说话人方向）</div>
                                            <Select
                                                style={{ width: "100%" }}
                                                value={editingBubble.tail ?? "bl"}
                                                options={[
                                                    { value: "tl", label: "左上" }, { value: "tr", label: "右上" },
                                                    { value: "bl", label: "左下" }, { value: "br", label: "右下" },
                                                ]}
                                                onChange={(v) => updateBubble(editing.panelId, editing.bubbleIndex, { tail: v })}
                                            />
                                        </div>
                                    ) : null}
                                    {editingBubble.type === "note" ? (
                                        <Tooltip title="卷宗/古文用竖排（右起）">
                                            <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
                                                <input type="checkbox" checked={!!editingBubble.vertical} onChange={(e) => updateBubble(editing.panelId, editing.bubbleIndex, { vertical: e.target.checked })} />
                                                竖排文字
                                            </label>
                                        </Tooltip>
                                    ) : null}
                                </>
                            )}
                        </div>
                    </div>
                ) : selectedPanel && panels.get(selectedPanel) ? (() => {
                    const sp = panels.get(selectedPanel)!;
                    const busy = regenerating.has(sp.id);
                    const curPg = config.pages[pageIndex];
                    const slotIdx = curPg && curPg.type !== "title" ? curPg.panels.indexOf(sp.id) : -1;
                    const atPage = config.pages.findIndex((pg) => pg.type !== "title" && pg.panels.includes(sp.id));
                    const labelStyle: React.CSSProperties = { fontSize: 12, marginBottom: 4, opacity: 0.75 };
                    return (
                        <div style={{ width: 300, borderLeft: "1px solid var(--border, #2a2d33)", padding: 16, overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
                            <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
                                <PictureOutlined /> 帧 · {sp.id}
                            </div>
                            <Space wrap size={4}>
                                {atPage >= 0 ? <Tag color="blue">第 {atPage + 1} 页</Tag> : <Tag color="orange">未入册</Tag>}
                                <Tag>{sp.model.split("::")[1] ?? sp.model}</Tag>
                                {sp.refStorageKeys.length ? <Tag color="geekblue">{sp.refStorageKeys.length} 张角色参考</Tag> : null}
                            </Space>
                            <div>
                                <div style={labelStyle}>帧标题</div>
                                <Input size="small" value={sp.title} onChange={(e) => updatePanelMeta(sp.id, { panelTitle: e.target.value })} />
                            </div>
                            <div>
                                <div style={labelStyle}>场景备注</div>
                                <Input size="small" value={sp.scene} placeholder="场次/情绪提示" onChange={(e) => updatePanelMeta(sp.id, { panelScene: e.target.value })} />
                            </div>
                            <div>
                                <div style={labelStyle}>提示词（重摇按当前内容执行）</div>
                                <Input.TextArea
                                    rows={6}
                                    value={sp.prompt}
                                    onChange={(e) => updatePanelMeta(sp.id, { prompt: e.target.value })}
                                    style={{ fontSize: 12 }}
                                />
                            </div>
                            <div>
                                <div style={labelStyle}>尺寸</div>
                                <Input size="small" value={sp.size} style={{ width: 140 }} onChange={(e) => updatePanelMeta(sp.id, { size: e.target.value })} />
                            </div>
                            {busy ? (
                                <Button icon={<StopOutlined />} onClick={() => cancelRegen(sp.id)}>取消生成</Button>
                            ) : (
                                <Button type="primary" danger icon={<ThunderboltOutlined />} onClick={() => void regeneratePanel(sp.id)}>
                                    重新生成本帧
                                </Button>
                            )}
                            <div style={{ fontSize: 12, opacity: 0.65 }}>走画布同款生成链路（随机种子），完成后自动更新到画布与本页。</div>
                            <Space wrap>
                                <Button size="small" onClick={() => addBubble(sp.id, { type: "speech", text: "新对白", x: 0.1, y: 0.08, w: 0.45, tail: "bl" })}>+对白</Button>
                                <Button size="small" onClick={() => addBubble(sp.id, { type: "caption", pos: "bottom", text: "新旁白" })}>+旁白</Button>
                                <Button size="small" onClick={() => addBubble(sp.id, { type: "thought", text: "内心……", x: 0.4, y: 0.06, w: 0.5 })}>+内心</Button>
                            </Space>
                            {slotIdx >= 0 ? (
                                <div>
                                    <div style={labelStyle}>本页位置（第 {slotIdx + 1} 格）</div>
                                    <Space wrap>
                                        <Button size="small" icon={<LeftOutlined />} disabled={slotIdx === 0} onClick={() => moveSlot(slotIdx, -1)}>左移</Button>
                                        <Button size="small" disabled={slotIdx >= (curPg && curPg.type !== "title" ? curPg.panels.length - 1 : 0)} onClick={() => moveSlot(slotIdx, 1)}>右移<RightOutlined /></Button>
                                        <Button size="small" danger icon={<DeleteOutlined />} onClick={() => setSlotPanel(slotIdx, null)}>移出本页</Button>
                                    </Space>
                                </div>
                            ) : (
                                <Button size="small" icon={<PlusOutlined />} onClick={() => addPanelToBook(sp.id)}>加入成书</Button>
                            )}
                            <Button size="small" type="text" icon={<ReloadOutlined />} style={{ alignSelf: "flex-start" }} onClick={() => { if (id) navigate(`/canvas/${id}`); }}>在画布中打开</Button>
                        </div>
                    );
                })() : (() => {
                    const usedIds = new Set(config.pages.flatMap((pg) => pagePanelsOf(pg)));
                    const unusedPanels = [...panels.values()].filter((p) => !usedIds.has(p.id));
                    const curPanels = pagePanelsOf(page);
                    const slotCount = pageSlotCount(page);
                    const rows = Math.max(slotCount, curPanels.length);
                    const sectionTitle: React.CSSProperties = { fontWeight: 600, display: "flex", alignItems: "center", gap: 6 };
                    const labelStyle: React.CSSProperties = { fontSize: 12, marginBottom: 4, opacity: 0.75 };
                    return (
                        <div style={{ width: 300, borderLeft: "1px solid var(--border, #2a2d33)", padding: 16, overflowY: "auto", fontSize: 13, display: "flex", flexDirection: "column", gap: 14 }}>
                            <div style={sectionTitle}><BookOutlined /> 成书信息</div>
                            <div>
                                <div style={labelStyle}>书名副标题</div>
                                <Input size="small" value={config.subtitle} onChange={(e) => setBookField("subtitle", e.target.value)} />
                            </div>
                            <div>
                                <div style={labelStyle}>章节名</div>
                                <Input size="small" value={config.chapter} onChange={(e) => setBookField("chapter", e.target.value)} />
                            </div>
                            <div>
                                <div style={labelStyle}>章末语</div>
                                <Input size="small" value={config.chapterEnd} onChange={(e) => setBookField("chapterEnd", e.target.value)} />
                            </div>
                            <div style={sectionTitle}>本页 · {page.type === "title" ? "扉页" : `第 ${pageIndex + 1} 页 / ${config.pages.length} 页`}</div>
                            <Select size="small" style={{ width: "100%" }} value={page.type} options={PAGE_TYPE_OPTIONS} onChange={changePageType} />
                            {page.type === "grid" ? (
                                <Select size="small" style={{ width: "100%" }} value={page.layout} options={LAYOUT_OPTIONS} onChange={(v) => changePageLayout(v as GridLayoutId)} />
                            ) : null}
                            {page.type !== "title" ? (
                                <Button size="small" aria-pressed={!!page.end} onClick={togglePageEnd}>{page.end ? "✓ 显示章末条" : "显示章末条"}</Button>
                            ) : null}
                            <Space wrap size={4}>
                                <Button size="small" icon={<UpOutlined />} disabled={pageIndex === 0} onClick={() => movePage(-1)}>上移</Button>
                                <Button size="small" disabled={pageIndex >= config.pages.length - 1} onClick={() => movePage(1)}>下移<DownOutlined /></Button>
                                <Button size="small" danger icon={<DeleteOutlined />} disabled={config.pages.length <= 1} onClick={removePage}>删页</Button>
                            </Space>
                            <div>
                                <div style={labelStyle}>在本页后插入</div>
                                <Space wrap size={4}>
                                    {PAGE_TYPE_OPTIONS.map((t) => (
                                        <Button key={t.value} size="small" icon={<PlusOutlined />} onClick={() => insertPageAfter(t.value)}>{t.label}</Button>
                                    ))}
                                </Space>
                            </div>
                            {page.type !== "title" ? (
                                <>
                                    <div style={sectionTitle}>分格槽位（{slotCount} 格）</div>
                                    {Array.from({ length: rows }).map((_, i) => {
                                        const occ = curPanels[i];
                                        return (
                                            <div key={i} style={{ display: "flex", gap: 4, alignItems: "center" }}>
                                                <Select
                                                    size="small"
                                                    style={{ flex: 1, minWidth: 0 }}
                                                    value={occ ?? ""}
                                                    onChange={(v) => setSlotPanel(i, v || null)}
                                                    options={[
                                                        { value: "", label: `格 ${i + 1} · 空` },
                                                        ...[...panels.values()]
                                                            .filter((p) => p.id !== occ)
                                                            .map((p) => {
                                                                const at = config.pages.findIndex((pg) => pg.type !== "title" && pg.panels.includes(p.id));
                                                                return { value: p.id, label: at >= 0 ? `${p.id}（第 ${at + 1} 页移入）` : `${p.id} · ${p.title || "未入册"}` };
                                                            }),
                                                    ]}
                                                />
                                                {occ ? (
                                                    <>
                                                        <Button size="small" icon={<LeftOutlined />} disabled={i === 0} onClick={() => moveSlot(i, -1)} title="左移" />
                                                        <Button size="small" icon={<RightOutlined />} disabled={i >= curPanels.length - 1} onClick={() => moveSlot(i, 1)} title="右移" />
                                                        <Button size="small" danger icon={<DeleteOutlined />} onClick={() => setSlotPanel(i, null)} title="移出本页" />
                                                    </>
                                                ) : null}
                                            </div>
                                        );
                                    })}
                                </>
                            ) : null}
                            <div style={sectionTitle}>未入册帧（{unusedPanels.length}）</div>
                            {unusedPanels.length === 0 ? (
                                <div style={{ fontSize: 12, opacity: 0.6 }}>所有帧都在册。</div>
                            ) : unusedPanels.map((p) => (
                                <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.85 }}>{p.id} · {p.title || "无标题"}</span>
                                    <Button size="small" icon={<PlusOutlined />} onClick={() => addPanelToBook(p.id)}>入册</Button>
                                </div>
                            ))}
                            {exportPreview ? (
                                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                    <div style={{ fontWeight: 600 }}>导出预览（右键另存）</div>
                                    <img src={exportPreview} alt="导出预览" style={{ width: "100%", border: "1px solid var(--border, #3a3d43)", borderRadius: 4 }} />
                                    <Button size="small" onClick={() => setExportPreview(null)}>关闭预览</Button>
                                </div>
                            ) : (
                                <div style={{ fontSize: 12, opacity: 0.6 }}>点击气泡编辑台词；点击格子编辑帧并重摇；←/→ 翻页；Ctrl+Z 撤销。</div>
                            )}
                        </div>
                    );
                })()}
            </div>
        </div>
    );
}
