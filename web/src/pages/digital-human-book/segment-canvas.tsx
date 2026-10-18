import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CompressOutlined, ExpandAltOutlined, ExportOutlined, MinusOutlined, PlusOutlined } from "@ant-design/icons";

import { ConnectionPath } from "@/components/canvas/canvas-connections";
import { CanvasNode } from "@/components/canvas/canvas-node";
import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

// 镜头工作流画布：只读总览——复用主画布的节点渲染器（CanvasNode）与连线渲染器
// （ConnectionPath）渲染段画布文档。点节点 = 回调 onSelect（页面据此跳进原生画布，
// 那里才是真正弹参数面板、连线、二次生成的地方）；右栏本身不承载任何编辑/生成逻辑。

export type WorkflowConnection = { id: string; from: string; to: string };

const MIN_SCALE = 0.1;
const MAX_SCALE = 2.5;
/** 自动全览时的可读下限：低于这个缩放，节点标题只剩几个像素，不如让用户拖动 */
const MIN_READABLE_SCALE = 0.72;

/**
 * 右栏窄栏（约 435px）按文档真实坐标做等比缩放只有 12%~21%，标题缩到几像素、
 * 等于看不见。这里给右栏一套**展示用紧凑排版**：只重排尺寸与坐标，id / 内容 /
 * 连线一律不动，所以点开、跳转、回写都还是同一份文档。
 * 沉浸画布与原生画布仍用文档里的真实坐标（那里有空间）。
 */
const COMPACT_CELL_W = 186;
const COMPACT_GAP_X = 14;
/** 行距要留出节点上方标题 + 下方徽标的位置，否则两行会互相压 */
const COMPACT_GAP_Y = 48;
const COMPACT_TOP = 34;
const COMPACT_MEDIA_H = 160;
/** 文本/音频节点要能放下 2-3 行正文，太矮会把字漏到卡片外 */
const COMPACT_SMALL_H = 118;
const ROW_1 = COMPACT_TOP + COMPACT_MEDIA_H + COMPACT_GAP_Y;
const ROW_2 = ROW_1 + COMPACT_MEDIA_H + COMPACT_GAP_Y;
const ROW_3 = ROW_2 + COMPACT_SMALL_H + COMPACT_GAP_Y;

export function compactSegmentLayout(nodes: CanvasNodeData[]): CanvasNodeData[] {
    const cell = (column: number, rowY: number, height: number) => ({
        position: { x: column * (COMPACT_CELL_W + COMPACT_GAP_X), y: rowY },
        width: COMPACT_CELL_W,
        height,
    });
    const slot = (node: CanvasNodeData) => {
        if (node.id.startsWith("scene-")) return cell(0, COMPACT_TOP, COMPACT_MEDIA_H);
        if (node.id === "wf-frame") return cell(1, COMPACT_TOP, COMPACT_MEDIA_H);
        if (node.id === "wf-persona") return cell(0, ROW_1, COMPACT_MEDIA_H);
        if (node.id === "wf-cards") return cell(1, ROW_1, COMPACT_MEDIA_H);
        if (node.id === "wf-script") return cell(0, ROW_2, COMPACT_SMALL_H);
        if (node.id === "wf-voice") return cell(1, ROW_2, COMPACT_SMALL_H);
        if (node.id.startsWith("seg-")) return cell(0, ROW_3, COMPACT_MEDIA_H);
        return cell(1, ROW_3, COMPACT_MEDIA_H);
    };
    return nodes.map((node) => ({ ...node, ...slot(node) }));
}

type Props = {
    nodes: CanvasNodeData[];
    connections: WorkflowConnection[];
    selectedId?: string | null;
    onSelect?: (nodeId: string) => void;
    /** 悬停节点右上角的「进画布」入口：视频节点里的 <video> 会吃掉点击，
     *  只靠"点节点"跳转不够，必须给一个明确且不被播放器拦截的按钮 */
    onOpenNode?: (nodeId: string) => void;
    /** 视口高度（px 或 "100%"：父级 flex 容器内自适应） */
    height?: number | string;
    /** 当前是否处于沉浸画布模式（决定按钮图标） */
    focus?: boolean;
    /** 沉浸画布开关；不传则不显示该按钮 */
    onToggleFocus?: () => void;
};

function ToolButton({ title, onClick, children, minWidth = 26 }: {
    title: string;
    onClick: () => void;
    children: ReactNode;
    minWidth?: number;
}) {
    const [hovered, setHovered] = useState(false);
    return (
        <button
            type="button"
            title={title}
            aria-label={title}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onClick={onClick}
            style={{
                minWidth, height: 24, padding: "0 6px", border: "none", borderRadius: 6, cursor: "pointer",
                display: "grid", placeItems: "center", fontSize: 12, lineHeight: 1,
                background: hovered ? "var(--user-fill, rgba(128,128,128,.2))" : "transparent",
                color: "inherit", fontVariantNumeric: "tabular-nums",
            }}
        >
            {children}
        </button>
    );
}

function WorkflowNodeWrap({ node, action, children }: {
    node: CanvasNodeData;
    action?: { title: string; run: () => void } | null;
    children: ReactNode;
}) {
    const [hovered, setHovered] = useState(false);
    return (
        <div
            data-canvas-node
            data-node-id={node.id}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            // 不在 mousedown 里选节点：容器要能"从节点上拖拽平移"，单击/双击的判定统一交给容器
            style={{ position: "absolute", left: node.position.x, top: node.position.y, width: node.width, height: node.height, zIndex: 2 }}
        >
            {children}
            {hovered && action ? (
                <button
                    type="button"
                    title={action.title}
                    aria-label={action.title}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                        e.stopPropagation();
                        action.run();
                    }}
                    style={{ position: "absolute", top: 6, right: 6, zIndex: 10, height: 26, padding: "0 8px", borderRadius: 7, border: "1px solid var(--user-border, var(--border))", background: "var(--card, #1f2430)", color: "var(--ant-color-primary, #4f7cff)", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, boxShadow: "0 4px 14px rgba(0,0,0,.35)" }}
                >
                    <ExportOutlined style={{ fontSize: 11 }} />
                    画布
                </button>
            ) : null}
        </div>
    );
}

export function SegmentCanvasView({ nodes, connections, selectedId, onSelect, onOpenNode, height = 430, focus = false, onToggleFocus }: Props) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [viewport, setViewport] = useState({ scale: 1, x: 0, y: 0 });
    const [dragging, setDragging] = useState(false);
    /** 用户手动缩放/平移过：切换段落导致内容变化时不再强行复位视口 */
    const manualRef = useRef(false);

    // 世界内容包围盒。父级每次渲染都会重建 nodes 数组（虚拟节点内联构造），
    // 只有"节点集合 + 位置尺寸"真变了才算布局变化，否则每次状态刷新都会复位视口。
    const layoutKey = nodes.map((n) => `${n.id}:${n.position.x},${n.position.y},${n.width},${n.height}`).join("|");
    const bounds = useMemo(() => {
        if (!nodes.length) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const node of nodes) {
            minX = Math.min(minX, node.position.x);
            minY = Math.min(minY, node.position.y);
            maxX = Math.max(maxX, node.position.x + node.width);
            maxY = Math.max(maxY, node.position.y + node.height);
        }
        return { minX, minY, maxX, maxY };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [layoutKey]);

    /** 全览：整张工作流完整入镜（不裁切），窄栏交给缩放按钮/沉浸画布看细节 */
    const applyFit = useCallback(() => {
        const el = containerRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        if (rect.width < 40 || rect.height < 40) return;
        const bw = Math.max(1, bounds.maxX - bounds.minX);
        const bh = Math.max(1, bounds.maxY - bounds.minY);
        const pad = 18;
        // 顶部要给节点标题留位置（标题画在节点上方），底部要给悬浮缩放条留位置，
        // 否则首行标题被裁、末行节点被压在工具条下面。
        const padTop = 30;
        const padBottom = 52;
        const usableH = Math.max(1, rect.height - padTop - padBottom);
        const raw = Math.min((rect.width - pad * 2) / bw, usableH / bh);
        // 窄栏设可读下限（缩到 0.7 以下标题就看不清，宁可超出视口让用户拖）；
        // 沉浸模式有空间，要的是"看全貌"，不设这个下限。
        const floor = focus ? MIN_SCALE : MIN_READABLE_SCALE;
        const scale = Math.max(floor, Math.min(1, Math.max(MIN_SCALE, raw)));
        setViewport({
            scale,
            x: (rect.width - bw * scale) / 2 - bounds.minX * scale,
            y: padTop - bounds.minY * scale,
        });
    }, [bounds, focus]);

    const resetView = useCallback(() => {
        manualRef.current = false;
        applyFit();
    }, [applyFit]);

    // 结构变化 / 进出沉浸模式：未被手动调整过就重新全览（沉浸切换必定重算，容器尺寸变了）
    useLayoutEffect(() => {
        manualRef.current = false;
        applyFit();
    }, [applyFit, focus]);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const observer = new ResizeObserver(() => { if (!manualRef.current) applyFit(); });
        observer.observe(el);
        return () => observer.disconnect();
    }, [applyFit]);

    /** 以容器内某点为锚点缩放 */
    const zoomAt = useCallback((factor: number, anchorX?: number, anchorY?: number) => {
        const rect = containerRef.current?.getBoundingClientRect();
        const px = anchorX ?? (rect ? rect.width / 2 : 0);
        const py = anchorY ?? (rect ? rect.height / 2 : 0);
        manualRef.current = true;
        setViewport((v) => {
            const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
            const k = scale / v.scale;
            return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
        });
    }, []);

    // 滚轮缩放（以指针为锚点）
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
        };
        el.addEventListener("wheel", onWheel, { passive: false });
        return () => el.removeEventListener("wheel", onWheel);
    }, [zoomAt]);

    /** 点选节点：400ms 内同一节点只触发一次（双击不该重复触发生成/播放） */
    const lastSelectRef = useRef({ id: "", at: 0 });
    const emitSelect = useCallback((nodeId: string) => {
        const now = Date.now();
        if (lastSelectRef.current.id === nodeId && now - lastSelectRef.current.at < 400) return;
        lastSelectRef.current = { id: nodeId, at: now };
        onSelect?.(nodeId);
    }, [onSelect]);

    /**
     * 统一指针手势：左键按下后移动 > 4px 就算平移（从节点上按下也一样，
     * 节点只是画布内容，不该吃掉拖拽）；没移动就抬起才算"点了这个节点"。
     * 播放器/按钮/输入框等控件自己处理指针，不参与平移。
     */
    const onPointerDown = (e: React.PointerEvent) => {
        if (e.button !== 0) return;
        const target = e.target as HTMLElement;
        if (target.closest("button, a, input, textarea, select, audio, [data-canvas-no-pan]")) return;
        const nodeId = target.closest("[data-canvas-node]")?.getAttribute("data-node-id") || null;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        const startX = e.clientX;
        const startY = e.clientY;
        let prevX = startX;
        let prevY = startY;
        let moved = false;
        const move = (ev: PointerEvent) => {
            if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
            if (!moved) { moved = true; setDragging(true); manualRef.current = true; }
            const dx = ev.clientX - prevX;
            const dy = ev.clientY - prevY;
            prevX = ev.clientX;
            prevY = ev.clientY;
            setViewport((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
        };
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            setDragging(false);
            if (!moved && nodeId) emitSelect(nodeId);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    };

    const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
    const canvasConnections: CanvasConnection[] = useMemo(
        () => connections.map((c) => ({ id: c.id, fromNodeId: c.from, toNodeId: c.to })),
        [connections],
    );

    const toolStyle: CSSProperties = {
        position: "absolute", right: 8, bottom: 8, zIndex: 6, display: "flex", alignItems: "center", gap: 1,
        padding: 2, borderRadius: 9, border: "1px solid var(--user-border, var(--border))",
        background: "var(--card, rgba(24,27,33,.92))", boxShadow: "0 6px 18px rgba(0,0,0,.28)",
        color: "var(--text, inherit)", fontSize: 12,
    };

    return (
        <div
            ref={containerRef}
            data-canvas-viewport
            onPointerDown={onPointerDown}
            onDoubleClick={(e) => {
                // 双击节点 = 打开它的编辑面板；双击空白 = 复位视口
                const nodeId = (e.target as HTMLElement).closest("[data-canvas-node]")?.getAttribute("data-node-id");
                if (nodeId) emitSelect(nodeId);
                else resetView();
            }}
            style={{
                position: "relative", width: "100%", height, overflow: "hidden", borderRadius: 10,
                border: "1px solid var(--user-border, var(--border))", background: "var(--canvas-bg, transparent)",
                cursor: dragging ? "grabbing" : "grab", touchAction: "none", userSelect: "none",
            }}
        >
            <div
                style={{
                    position: "absolute", left: 0, top: 0, transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`, transformOrigin: "0 0",
                    width: Math.max(1, bounds.maxX - bounds.minX), height: Math.max(1, bounds.maxY - bounds.minY),
                }}
            >
                <svg
                    aria-hidden
                    style={{ position: "absolute", left: 0, top: 0, width: "100%", height: "100%", overflow: "visible", pointerEvents: "none", zIndex: 1 }}
                >
                    {canvasConnections.map((connection) => {
                        const from = nodeById.get(connection.fromNodeId);
                        const to = nodeById.get(connection.toNodeId);
                        if (!from || !to) return null;
                        return (
                            <ConnectionPath
                                key={connection.id}
                                connection={connection}
                                from={from}
                                to={to}
                                active={false}
                                onSelect={() => undefined}
                            />
                        );
                    })}
                </svg>
                {nodes.map((node) => (
                    <WorkflowNodeWrap
                        key={node.id}
                        node={node}
                        action={onOpenNode ? { title: "进入画布：调提示词 / 换参考图 / 重新生成", run: () => onOpenNode(node.id) } : null}
                    >
                        <CanvasNode
                            // CanvasNode 自身按 data.position 做 translate；外层包裹已定位，
                            // 这里必须归零，否则节点被平移两次（连线也会画到错的位置）。
                            data={{ ...node, position: { x: 0, y: 0 } }}
                            scale={viewport.scale}
                            isSelected={selectedId === node.id}
                            isRelated={false}
                            isFocusRelated={false}
                            isConnectionTarget={false}
                            showImageInfo={false}
                            readOnly
                            // 选中/编辑由容器统一判定（见 onPointerDown），这里不再抢 mousedown
                            onMouseDown={() => undefined}
                            onHoverStart={() => undefined}
                            onHoverEnd={() => undefined}
                            onConnectStart={() => undefined}
                            onResize={() => undefined}
                            onContentChange={() => undefined}
                            onContextMenu={() => undefined}
                        />
                    </WorkflowNodeWrap>
                ))}
            </div>
            <div
                onPointerDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                style={{ position: "absolute", left: 10, bottom: 10, zIndex: 5, fontSize: 11, opacity: 0.42, pointerEvents: "none" }}
            >
                {nodes.length} 个节点 · 拖拽任意处平移 · 滚轮缩放 · 双击空白复位
            </div>
            <div onPointerDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} style={toolStyle}>
                <ToolButton title="缩小" onClick={() => zoomAt(1 / 1.25)}><MinusOutlined /></ToolButton>
                <ToolButton title="适应画布（双击空白同等）" onClick={resetView} minWidth={42}>{Math.round(viewport.scale * 100)}%</ToolButton>
                <ToolButton title="放大" onClick={() => zoomAt(1.25)}><PlusOutlined /></ToolButton>
                {onToggleFocus ? (
                    <>
                        <span style={{ width: 1, height: 14, background: "var(--user-border, var(--border))", opacity: 0.8 }} />
                        <ToolButton title={focus ? "退出沉浸画布（Esc）" : "沉浸画布：整块空间放工作流，看清每个节点"} onClick={onToggleFocus}>
                            {focus ? <CompressOutlined /> : <ExpandAltOutlined />}
                        </ToolButton>
                    </>
                ) : null}
            </div>
        </div>
    );
}
