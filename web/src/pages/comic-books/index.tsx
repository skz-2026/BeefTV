import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Skeleton, Tag } from "antd";
import { FileImageOutlined } from "@ant-design/icons";
import { BookOpen } from "lucide-react";

import { http } from "@/services/api/request";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

// 漫画书架：列出工作区内所有含 comic-config 节点的画布（= 漫画集），点击进入成书页。
type ComicSummary = {
    id: string;
    title: string;
    chapter: string;
    subtitle: string;
    panelCount: number;
    pageCount: number;
    doneCount: number;
    updatedAt: string;
};

async function probeCanvas(id: string): Promise<ComicSummary | null> {
    const { project } = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`);
    const configNode = project.nodes.find((node) => node.type === "text" && node.id === "comic-config");
    if (!configNode) return null;
    let cfg: { subtitle?: string; chapter?: string; pages?: Array<{ panels?: string[] }> } = {};
    try {
        const parsed = JSON.parse(String((configNode.metadata as Record<string, unknown> | undefined)?.content ?? "{}"));
        if (parsed?.kind !== "comic-config") return null;
        cfg = parsed;
    } catch {
        return null;
    }
    const panels = project.nodes.filter((node) => node.type === "image" && node.id.startsWith("panel-"));
    const done = panels.filter((node) => {
        const md = (node.metadata ?? {}) as Record<string, unknown>;
        return typeof md.content === "string" && (md.content as string).startsWith("/api/");
    });
    return {
        id: project.id,
        title: project.title,
        subtitle: cfg.subtitle ?? "",
        chapter: cfg.chapter ?? "",
        panelCount: panels.length,
        pageCount: cfg.pages?.length ?? 0,
        doneCount: done.length,
        updatedAt: project.updatedAt ?? "",
    };
}

export default function ComicBooksPage() {
    const [books, setBooks] = useState<ComicSummary[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setError(null);
        try {
            // 列表摘要不含节点；本地工作台画布数量有限，逐个探测 comic-config
            const list = await http.get<{ projects: Array<{ id: string }>; total: number }>("/canvas-projects", { params: { page: 1, pageSize: 100 } });
            const results = await Promise.allSettled((list.projects ?? []).map((p) => probeCanvas(p.id)));
            setBooks(results.filter((r): r is PromiseFulfilledResult<ComicSummary> => r.status === "fulfilled").map((r) => r.value).filter(Boolean));
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, []);

    useEffect(() => { void load(); }, [load]);

    return (
        <div style={{ padding: 24, maxWidth: 1080, margin: "0 auto" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
                <BookOpen style={{ fontSize: 22 }} />
                <span style={{ fontSize: 20, fontWeight: 700 }}>漫画成书</span>
                <span style={{ opacity: 0.6, fontSize: 13 }}>从画布生成到分页排版、台词气泡与整本导出</span>
            </div>
            {error ? <div style={{ color: "#d46b08" }}>加载失败：{error}</div> : null}
            {books === null && !error ? (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
                    {[0, 1, 2].map((i) => <Skeleton key={i} active paragraph={{ rows: 2 }} />)}
                </div>
            ) : null}
            {books !== null && books.length === 0 ? (
                <div style={{ padding: 40, textAlign: "center", color: "var(--muted, #8b929e)" }}>
                    还没有漫画集。在画布里建立 comic-config 与 panel-* 节点后，会自动出现在这里。
                </div>
            ) : null}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
                {(books ?? []).map((book) => (
                    <Link
                        key={book.id}
                        to={`/comic-book/${encodeURIComponent(book.id)}`}
                        style={{
                            display: "block", padding: 16, borderRadius: 12,
                            border: "1px solid var(--border, #2a2d33)", background: "var(--card, #1a1d22)",
                            textDecoration: "none", color: "inherit",
                        }}
                    >
                        <div style={{ fontWeight: 700, marginBottom: 4, fontSize: 15 }}>{book.subtitle || book.title}</div>
                        <div style={{ opacity: 0.75, fontSize: 13, marginBottom: 10 }}>{book.chapter || book.title}</div>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <Tag><FileImageOutlined /> {book.doneCount}/{book.panelCount} 帧</Tag>
                            <Tag color="blue">{book.pageCount} 页</Tag>
                        </div>
                    </Link>
                ))}
            </div>
        </div>
    );
}
