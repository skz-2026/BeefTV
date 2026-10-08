import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Thermometer, X } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { scopedLocalStorage } from "@/lib/user-scope";
import type { SystemHardwareStats, SystemGpuStatus, SystemThermalZoneStatus } from "@/services/api/system";
import { useActiveTheme } from "@/stores/canvas/use-canvas-theme-store";

const POSITION_STORAGE_KEY = "canvas:hardware-monitor-position";
const DEFAULT_POSITION = { x: 12, y: 132 };
// 仅用于拖拽边界收敛的估算尺寸；面板实际高度随磁盘/热区行数浮动。
const PANEL_SIZE = { width: 248, height: 320 };

type MonitorRow = {
    key: string;
    label: string;
    title?: string;
    percent: number | null;
    value: string;
    temperature: number | null;
};

// 监控语义色固定跨主题使用：低负载绿、中负载/偏热黄、高负载/过热红，与进度条同色。
const TONE_COLORS = { ok: "#34d399", warm: "#fbbf24", hot: "#f87171" } as const;
type LoadTone = keyof typeof TONE_COLORS | "idle";

export function CanvasHardwareMonitor({ stats, error, onClose }: { stats: SystemHardwareStats | null; error?: boolean; onClose: () => void }) {
    const theme = canvasThemes[useActiveTheme()];
    const [position, setPosition] = useState(readStoredPosition);
    const positionRef = useRef(position);
    const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);

    const rows = buildRows(stats);

    function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
        if (event.button !== 0) return;
        dragRef.current = { pointerId: event.pointerId, offsetX: event.clientX - position.x, offsetY: event.clientY - position.y };
        event.currentTarget.setPointerCapture(event.pointerId);
    }

    function moveDrag(event: ReactPointerEvent<HTMLDivElement>) {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const next = clampPosition(event.clientX - drag.offsetX, event.clientY - drag.offsetY);
        // ref 与 state 同步更新：pointerup 直接落盘，避免批处理渲染慢一拍存下上一步位置。
        positionRef.current = next;
        setPosition(next);
    }

    function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        dragRef.current = null;
        scopedLocalStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(positionRef.current));
    }

    return (
        <div className="pointer-events-none absolute z-[var(--z-panel-floating)]" style={{ left: position.x, top: position.y }}>
            <section
                data-canvas-no-zoom
                aria-label="硬件监控"
                className="pointer-events-auto w-[248px] select-none overflow-hidden rounded-[var(--panel-radius)] border backdrop-blur-2xl"
                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text, boxShadow: `0 24px 72px ${theme.spatial.shadow}` }}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onWheel={(event) => event.stopPropagation()}
            >
                <div
                    className="flex cursor-grab touch-none items-center gap-2 border-b px-3 py-2.5 active:cursor-grabbing"
                    style={{ borderColor: theme.toolbar.border }}
                    aria-label="拖动硬件监控面板"
                    onPointerDown={startDrag}
                    onPointerMove={moveDrag}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                >
                    <span className="grid size-7 shrink-0 place-items-center rounded-[var(--dock-item-radius)]" style={{ background: theme.accent.primarySoft, color: theme.accent.primary }}>
                        <Thermometer className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1 text-sm font-semibold leading-5">硬件监控</span>
                    <button
                        type="button"
                        aria-label="关闭硬件监控"
                        className="grid size-7 shrink-0 place-items-center rounded-md opacity-70 transition-opacity hover:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                        style={{ color: theme.node.muted }}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={onClose}
                    >
                        <X className="size-3.5" />
                    </button>
                </div>

                <div className="space-y-2.5 px-3 pb-3 pt-2.5">
                    {rows.map((row) => {
                        const tone = toneOf(row.percent, row.temperature);
                        return (
                            <div key={row.key} className="flex items-center gap-2.5" title={row.title}>
                                <span className="w-10 shrink-0 text-[var(--fs-label)]" style={{ color: theme.node.muted }}>
                                    {row.label}
                                </span>
                                {row.percent != null ? (
                                    <div className="h-1.5 flex-1 overflow-hidden rounded-full" style={{ background: "rgba(128,128,128,.24)" }} aria-hidden>
                                        <div
                                            className="h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none"
                                            style={{ width: `${Math.max(0, Math.min(100, row.percent))}%`, background: TONE_COLORS[tone === "idle" ? "ok" : tone] }}
                                        />
                                    </div>
                                ) : (
                                    <span className="flex-1" aria-hidden />
                                )}
                                <span className="min-w-[4.5rem] shrink-0 text-right text-xs font-medium tabular-nums" style={{ color: tone === "idle" ? theme.node.faint : TONE_COLORS[tone] }}>
                                    {row.value}
                                </span>
                            </div>
                        );
                    })}
                    {stats === null ? (
                        <div className="pt-0.5 text-[var(--fs-label)]" style={{ color: theme.node.faint }} aria-live="polite">
                            {error ? "暂时读不到本机硬件数据" : "正在读取本机硬件…"}
                        </div>
                    ) : null}
                </div>
            </section>
        </div>
    );
}

function buildRows(stats: SystemHardwareStats | null): MonitorRow[] {
    if (stats === null) {
        return (["CPU", "显卡", "显存", "内存"] as const).map((label) => ({ key: label, label, percent: null, value: "—", temperature: null }));
    }
    const gpu = stats.gpu;
    const rows: MonitorRow[] = [
        { key: "cpu", label: "CPU", percent: stats.cpu.percent, value: formatLoad(stats.cpu.percent, null), temperature: null },
        { key: "gpu", label: "显卡", title: gpu?.name, percent: gpu?.utilizationPercent ?? null, value: gpu ? formatLoad(gpu.utilizationPercent, gpu.temperatureC) : "—", temperature: gpu?.temperatureC ?? null },
        { key: "vram", label: "显存", title: gpu?.name, percent: formatVramPercent(gpu), value: gpu ? formatVram(gpu) : "—", temperature: null },
        { key: "memory", label: "内存", percent: stats.memory.percent, value: formatLoad(stats.memory.percent, null), temperature: null },
    ];
    stats.disks.forEach((disk, index) => {
        rows.push({
            key: `disk-${disk.mount}-${index}`,
            label: `硬盘${index + 1}`,
            title: disk.mount,
            percent: disk.percent,
            value: formatLoad(disk.percent, disk.temperatureC),
            temperature: disk.temperatureC,
        });
    });
    const hotZone = stats.thermalZones.reduce<SystemThermalZoneStatus | null>((hottest, zone) => (!hottest || zone.temperatureC > hottest.temperatureC ? zone : hottest), null);
    if (hotZone) {
        rows.push({ key: "thermal", label: "热区", title: hotZone.name, percent: hotZone.temperatureC, value: `${Math.round(hotZone.temperatureC)}°`, temperature: hotZone.temperatureC });
    }
    return rows;
}

function formatLoad(percent: number | null | undefined, temperature: number | null | undefined) {
    const parts: string[] = [];
    if (percent != null && Number.isFinite(percent)) parts.push(`${Math.round(percent)}%`);
    if (temperature != null && Number.isFinite(temperature)) parts.push(`${Math.round(temperature)}°`);
    return parts.length ? parts.join("-") : "—";
}

function formatVramPercent(gpu: SystemGpuStatus | null) {
    if (!gpu || gpu.vramTotalBytes === 0) return null;
    return (gpu.vramUsedBytes / gpu.vramTotalBytes) * 100;
}

function formatVram(gpu: SystemGpuStatus) {
    const gib = 1024 ** 3;
    return `${(gpu.vramUsedBytes / gib).toFixed(1)}/${Math.round(gpu.vramTotalBytes / gib)}G`;
}

// 负载与温度取更严重的档位：≥90% 或 ≥65° 红色，≥60% 或 ≥45° 黄色，其余绿色。
function toneOf(percent: number | null, temperature: number | null): LoadTone {
    if (percent == null && temperature == null) return "idle";
    const load = percent ?? 0;
    const temp = temperature ?? 0;
    if (load >= 90 || temp >= 65) return "hot";
    if (load >= 60 || temp >= 45) return "warm";
    return "ok";
}

function clampPosition(x: number, y: number) {
    if (typeof window === "undefined") return { x, y };
    const maxX = Math.max(8, window.innerWidth - PANEL_SIZE.width - 8);
    const maxY = Math.max(8, window.innerHeight - PANEL_SIZE.height - 8);
    return { x: Math.min(Math.max(8, x), maxX), y: Math.min(Math.max(8, y), maxY) };
}

function readStoredPosition() {
    try {
        const raw = scopedLocalStorage.getItem(POSITION_STORAGE_KEY);
        if (!raw) return DEFAULT_POSITION;
        const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
        if (typeof parsed.x !== "number" || typeof parsed.y !== "number") return DEFAULT_POSITION;
        return clampPosition(parsed.x, parsed.y);
    } catch {
        return DEFAULT_POSITION;
    }
}
