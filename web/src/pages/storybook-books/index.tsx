import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Button, Skeleton, Tag } from "antd";
import { AudioOutlined, FileAddOutlined, FileImageOutlined } from "@ant-design/icons";
import { BookOpen } from "lucide-react";

import { http } from "@/services/api/request";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { StorybookNewModal } from "./storybook-new";

// 绘本书架：列出工作区内所有含 storybook-config 节点的画布（= 绘本），点击进入绘本成书页。
type StorybookSummary = {
    id: string;
    title: string;
    subtitle: string;
    style: string;
    pageCount: number;
    panelCount: number;
    doneCount: number;
    lineTotal: number;
    lineDone: number;
    updatedAt: string;
};

async function probeCanvas(id: string): Promise<StorybookSummary | null> {
    const { project } = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`);
    const configNode = project.nodes.find((node) => node.type === "text" && node.id === "storybook-config");
    if (!configNode) return null;
    let cfg: { title?: string; subtitle?: string; style?: string; pages?: unknown[] } = {};
    try {
        const parsed = JSON.parse(String((configNode.metadata as Record<string, unknown> | undefined)?.content ?? "{}"));
        if (parsed?.kind !== "storybook-config") return null;
        cfg = parsed;
    } catch {
        return null;
    }
    const panels = project.nodes.filter((node) => node.type === "image" && node.id.startsWith("panel-"));
    let lineTotal = 0;
    let lineDone = 0;
    for (const node of panels) {
        const md = (node.metadata ?? {}) as Record<string, unknown>;
        const narration = md.narration as { text?: string; audio?: unknown } | undefined;
        if (narration?.text) {
            lineTotal += 1;
            if (narration.audio) lineDone += 1;
        }
        const dialogue = Array.isArray(md.dialogue) ? (md.dialogue as Array<{ text?: string; audio?: unknown }>) : [];
        for (const line of dialogue) {
            if (line.text) {
                lineTotal += 1;
                if (line.audio) lineDone += 1;
            }
        }
    }
    const done = panels.filter((node) => {
        const md = (node.metadata ?? {}) as Record<string, unknown>;
        return typeof md.content === "string" && (md.content as string).startsWith("/api/");
    });
    return {
        id: project.id,
        title: project.title,
        subtitle: cfg.subtitle ?? "",
        style: cfg.style ?? "",
        pageCount: cfg.pages?.length ?? 0,
        panelCount: panels.length,
        doneCount: done.length,
        lineTotal,
        lineDone,
        updatedAt: project.updatedAt ?? "",
    };
}

export default function StorybookBooksPage() {
    const [books, setBooks] = useState<StorybookSummary[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [createOpen, setCreateOpen] = useState(false);

    const load = useCallback(async () => {
        setError(null);
        try {
            // 列表摘要不含节点；本地工作台画布数量有限，逐个探测 storybook-config
            const list = await http.get<{ projects: Array<{ id: string }>; total: number }>("/canvas-projects", { params: { page: 1, pageSize: 100 } });
            const results = await Promise.allSettled((list.projects ?? []).map((p) => probeCanvas(p.id)));
            setBooks(results.filter((r): r is PromiseFulfilledResult<StorybookSummary> => r.status === "fulfilled").map((r) => r.value).filter(Boolean));
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, []);

    useEffect(() => { void load(); }, [load]);

    return (
        <div style={{ padding: 24, maxWidth: 1080, margin: "0 auto" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
                <BookOpen style={{ fontSize: 22 }} />
                <span style={{ fontSize: 20, fontWeight: 700 }}>绘本成书</span>
                <span style={{ opacity: 0.6, fontSize: 13 }}>从一个想法到整页插画、逐页配音与有声绘本视频</span>
                <Button style={{ marginLeft: "auto" }} icon={<FileAddOutlined />} onClick={() => setCreateOpen(true)}>新建绘本</Button>
            </div>
            <StorybookNewModal open={createOpen} onClose={() => { setCreateOpen(false); void load(); }} />
            {error ? <div style={{ color: "#d46b08" }}>加载失败：{error}</div> : null}
            {books === null && !error ? (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
                    {[0, 1, 2].map((i) => <Skeleton key={i} active paragraph={{ rows: 2 }} />)}
                </div>
            ) : null}
            {books !== null && books.length === 0 ? (
                <div style={{ padding: 40, textAlign: "center", color: "var(--muted, #8b929e)" }}>
                    还没有绘本。点右上角「新建绘本」，从一个想法或一段故事文本开始。
                </div>
            ) : null}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
                {(books ?? []).map((book) => (
                    <Link
                        key={book.id}
                        to={`/storybook-book/${encodeURIComponent(book.id)}`}
                        style={{
                            display: "block", padding: 16, borderRadius: 12,
                            border: "1px solid var(--border, #2a2d33)", background: "var(--card, #1a1d22)",
                            textDecoration: "none", color: "inherit",
                        }}
                    >
                        <div style={{ fontWeight: 700, marginBottom: 4, fontSize: 15 }}>{book.title || book.id}</div>
                        <div style={{ opacity: 0.75, fontSize: 13, marginBottom: 10 }}>{book.subtitle || book.id}</div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <Tag><FileImageOutlined /> {book.doneCount}/{book.panelCount} 页图</Tag>
                            <Tag color="blue">{book.pageCount} 页</Tag>
                            {book.lineTotal > 0 ? <Tag color={book.lineDone >= book.lineTotal ? "green" : "orange"}><AudioOutlined /> 配音 {book.lineDone}/{book.lineTotal}</Tag> : null}
                        </div>
                    </Link>
                ))}
            </div>
        </div>
    );
}
