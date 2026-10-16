import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Button, Card, Skeleton, Tabs, Tag } from "antd";
import { AudioOutlined, FileAddOutlined, PlayCircleOutlined, UserAddOutlined, VideoCameraOutlined } from "@ant-design/icons";
import { Megaphone } from "lucide-react";

import { EmptyState } from "@/components/ui/product/empty-state";

import { http } from "@/services/api/request";
import { listDigitalHumanPersonas, parseDigitalHumanCanvas, type DigitalHumanPersonaCard } from "@/services/digital-human-doc";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { DigitalHumanNewModal } from "./digital-human-new";
import { PersonaManagerModal } from "./persona-manager";

// 数字人口播主页：口播项目（digitalhuman-config 画布）与数字人档案（digitalhuman-persona 画布）
// 两个 Tab。数字人 = 可跨期复用的人物参考图 + 固定音色 + 外貌锚点。

type EpisodeSummary = {
    id: string;
    title: string;
    personaName: string;
    aspect: string;
    segTotal: number;
    audioDone: number;
    videoDone: number;
    updatedAt: string;
};

async function probeEpisode(id: string): Promise<EpisodeSummary | null> {
    const { project } = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`);
    const episode = parseDigitalHumanCanvas(project);
    if (!episode.config) return null;
    const audioDone = episode.segments.filter((s) => s.audio?.storageKey).length;
    const videoDone = episode.segments.filter((s) => s.videoStorageKey && s.videoResourceId).length;
    return {
        id: project.id,
        title: episode.config.title || project.title,
        personaName: episode.config.persona?.name ?? "",
        aspect: episode.config.aspect,
        segTotal: episode.segments.length,
        audioDone,
        videoDone,
        updatedAt: project.updatedAt ?? "",
    };
}

async function probeAllEpisodes(probe: (id: string) => Promise<EpisodeSummary | null>): Promise<EpisodeSummary[]> {
    const list = await http.get<{ projects: Array<{ id: string }>; total: number }>("/canvas-projects", { params: { page: 1, pageSize: 100 } });
    const results = await Promise.allSettled((list.projects ?? []).map((p) => probe(p.id)));
    return results.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));
}

export default function DigitalHumanBooksPage() {
    const [tab, setTab] = useState("episodes");
    const [episodes, setEpisodes] = useState<EpisodeSummary[] | null>(null);
    const [personas, setPersonas] = useState<DigitalHumanPersonaCard[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [createOpen, setCreateOpen] = useState(false);
    const [personaEditing, setPersonaEditing] = useState<string | null | undefined>(undefined); // undefined=关闭, null=新建, string=编辑

    const load = useCallback(async () => {
        setError(null);
        try {
            const [eps, ps] = await Promise.all([probeAllEpisodes(probeEpisode), listDigitalHumanPersonas()]);
            setEpisodes(eps.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
            setPersonas(ps);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    }, []);

    useEffect(() => { void load(); }, [load]);

    const refreshPersonas = useCallback(() => { void listDigitalHumanPersonas().then(setPersonas).catch(() => undefined); }, []);

    return (
        <div style={{ padding: 24, maxWidth: 1080, margin: "0 auto" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                <Megaphone style={{ fontSize: 22 }} />
                <span style={{ fontSize: 20, fontWeight: 700 }}>数字人口播</span>
                <span style={{ opacity: 0.6, fontSize: 13 }}>主题自动分镜 · 数字人资产复用 · 逐段口型视频 · 一键成片</span>
                {tab === "episodes" ? (
                    <Button style={{ marginLeft: "auto" }} icon={<FileAddOutlined />} onClick={() => setCreateOpen(true)}>新建口播</Button>
                ) : (
                    <Button style={{ marginLeft: "auto" }} icon={<UserAddOutlined />} onClick={() => setPersonaEditing(null)}>新建数字人</Button>
                )}
            </div>
            <Tabs
                activeKey={tab}
                onChange={setTab}
                items={[
                    {
                        key: "episodes",
                        label: `口播项目${episodes ? `（${episodes.length}）` : ""}`,
                        children: (
                            <>
                                {error ? <div style={{ color: "#d46b08", marginBottom: 12 }}>加载失败：{error}</div> : null}
                                {episodes === null && !error ? (
                                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
                                        {[0, 1, 2].map((i) => <Skeleton key={i} active paragraph={{ rows: 2 }} />)}
                                    </div>
                                ) : null}
                                {episodes !== null && episodes.length === 0 ? (
                                    <EmptyState title="还没有口播项目" description="先在「数字人」Tab 建档，再点右上角「新建口播」。" />
                                ) : null}
                                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
                                    {(episodes ?? []).map((ep) => (
                                        <Link key={ep.id} to={`/digital-human-book/${encodeURIComponent(ep.id)}`} style={{ textDecoration: "none" }}>
                                            <Card hoverable size="small">
                                                <div style={{ fontWeight: 700, marginBottom: 4, fontSize: 15 }}>{ep.title || ep.id}</div>
                                                <div style={{ opacity: 0.75, fontSize: 13, marginBottom: 10 }}>数字人 {ep.personaName || "未绑定"} · {ep.aspect}</div>
                                                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                                    <Tag><AudioOutlined /> 配音 {ep.audioDone}/{ep.segTotal}</Tag>
                                                    <Tag color={ep.videoDone >= ep.segTotal && ep.segTotal > 0 ? "green" : "orange"}><VideoCameraOutlined /> 视频 {ep.videoDone}/{ep.segTotal}</Tag>
                                                    {ep.videoDone >= ep.segTotal && ep.segTotal > 0 ? <Tag color="blue"><PlayCircleOutlined /> 可合成</Tag> : null}
                                                </div>
                                            </Card>
                                        </Link>
                                    ))}
                                </div>
                            </>
                        ),
                    },
                    {
                        key: "personas",
                        label: `数字人${personas ? `（${personas.length}）` : ""}`,
                        children: (
                            <>
                                {personas !== null && personas.length === 0 ? (
                                    <EmptyState title="还没有数字人" description="点右上角「新建数字人」，生成人物参考图并绑定音色。" />
                                ) : null}
                                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 16 }}>
                                    {(personas ?? []).map((p) => (
                                        <Card
                                            key={p.canvasId}
                                            hoverable
                                            size="small"
                                            cover={p.portraitStorageKey
                                                ? <div style={{ aspectRatio: "3 / 4", overflow: "hidden" }}><img src={`/api/resources/${p.portraitStorageKey.replace(/^resource:/, "")}/file`} alt={p.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /></div>
                                                : <div style={{ aspectRatio: "3 / 4", display: "grid", placeItems: "center", background: "var(--user-fill, rgba(128,128,128,.08))", opacity: 0.5 }}>未生成人物图</div>}
                                            actions={[
                                                <Button key="edit" type="link" size="small" onClick={() => setPersonaEditing(p.canvasId)}>编辑</Button>,
                                            ]}
                                        >
                                            <Card.Meta
                                                title={p.name}
                                                description={(
                                                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                                                        <span style={{ fontSize: 12 }}>音色：{p.voice || "未绑定"}</span>
                                                        <Tag color={p.ready ? "green" : "orange"} style={{ alignSelf: "flex-start" }}>{p.ready ? "就绪可建口播" : "缺人物图或音色"}</Tag>
                                                    </div>
                                                )}
                                            />
                                        </Card>
                                    ))}
                                </div>
                                {personas === null ? <Skeleton active paragraph={{ rows: 3 }} /> : null}
                            </>
                        ),
                    },
                ]}
            />
            <DigitalHumanNewModal open={createOpen} onClose={() => { setCreateOpen(false); void load(); }} personas={personas ?? []} />
            <PersonaManagerModal
                open={personaEditing !== undefined}
                editingCanvasId={personaEditing ?? undefined}
                onClose={() => { setPersonaEditing(undefined); void load(); }}
                onSaved={refreshPersonas}
            />
        </div>
    );
}
