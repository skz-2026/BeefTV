import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Drawer, Input, Progress, Tag, Tooltip } from "antd";
import { Copy, Download, ExternalLink, ImageOff, LibraryBig, Loader2, RefreshCw, Search } from "lucide-react";

import { AssetLibraryCard, AssetLibraryCardMedia } from "@/components/assets/asset-library-card";
import { EmptyState } from "@/components/ui/product/empty-state";
import { CollectionGrid, ListToolbar, PageHeader, PaginationBar, WorkspacePage } from "@/components/layout/workspace-page";
import { useCopyText } from "@/hooks/use-copy-text";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
    fetchPromptLibraryDetail,
    fetchPromptLibraryStatus,
    listPromptLibraryLabels,
    promptLibraryImageUrl,
    searchPromptLibraryItems,
    startPromptLibraryInstall,
    type PromptLibraryItem,
    type PromptLibraryLabel,
    type PromptLibraryStatus,
} from "@/services/api/prompt-library";
import "./prompt-library.css";

const SOURCE_REPO_URL = "https://github.com/NanmiCoder/open-image-prompts";
const PAGE_SIZE = 24;

export default function PromptLibraryPage() {
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const [keyword, setKeyword] = useState("");
    const [selectedTags, setSelectedTags] = useState<string[]>([]);
    const [page, setPage] = useState(1);
    const [detailTweetId, setDetailTweetId] = useState<string | null>(null);
    const [filterOpen, setFilterOpen] = useState(false);
    const [installing, setInstalling] = useState(false);
    const debouncedKeyword = useDebouncedValue(keyword, 300);

    const statusQuery = useQuery({
        queryKey: ["prompt-library", "status"],
        queryFn: ({ signal }) => fetchPromptLibraryStatus({ signal }),
        refetchInterval: (query) => (query.state.data?.progress.running ? 1500 : false),
    });
    const status = statusQuery.data;
    const available = Boolean(status?.available);

    const labelsQuery = useQuery({
        queryKey: ["prompt-library", "labels"],
        queryFn: ({ signal }) => listPromptLibraryLabels({ signal }),
        enabled: available,
        staleTime: 10 * 60 * 1000,
    });

    useEffect(() => {
        setPage(1);
    }, [debouncedKeyword, selectedTags]);

    const itemsQuery = useQuery({
        queryKey: ["prompt-library", "prompts", debouncedKeyword, selectedTags, page],
        queryFn: ({ signal }) => searchPromptLibraryItems({ query: debouncedKeyword, tags: selectedTags, page, pageSize: PAGE_SIZE, signal }),
        enabled: available,
        placeholderData: (previous) => previous,
    });

    const refreshStatus = useCallback(() => {
        void queryClient.invalidateQueries({ queryKey: ["prompt-library", "status"] });
    }, [queryClient]);

    const install = async (target: "db" | "packs" | string, label: string) => {
        if (installing) return;
        setInstalling(true);
        try {
            await startPromptLibraryInstall(target);
            message.success("开始" + label);
            refreshStatus();
        } catch (reason) {
            message.error(reason instanceof Error ? reason.message : label + "失败");
        } finally {
            setInstalling(false);
        }
    };

    const toggleTag = (value: string) => {
        setSelectedTags((tags) => (tags.includes(value) ? tags.filter((tag) => tag !== value) : [...tags, value]));
    };

    const labelsByDimension = useMemo(() => {
        const groups = new Map<string, PromptLibraryLabel[]>();
        for (const label of labelsQuery.data?.labels ?? []) {
            const list = groups.get(label.dimension) ?? [];
            list.push(label);
            groups.set(label.dimension, list);
        }
        return Array.from(groups.entries());
    }, [labelsQuery.data]);

    const progress = status?.progress;
    const busy = Boolean(progress?.running);

    return (
        <WorkspacePage grid className="library-page prompt-library-page">
            <div className="studio-band">
                <PageHeader
                    title="提示词参考库"
                    description="开源数据集 open-image-prompts：2 万余条带成图的提示词与中英对照，本地检索、离线可用。选中后一键追加到画布生成提示词。"
                    meta={(
                        <span className="app-projects-header-meta">
                            {available
                                ? `${status?.promptCount ?? 0} 条提示词 · ${status?.imageCount ?? 0} 张成图 · ${status?.taxonomyVersion ?? ""}`
                                : status?.external
                                    ? "外部数据集 · 未安装"
                                    : "数据集未安装"}
                        </span>
                    )}
                    actions={(
                        <div className="assets-header-actions">
                            <div className="assets-header-action-buttons">
                                {available && status?.dbUpdate && !status.external ? (
                                    <Button icon={<Download className="size-3.5" />} disabled={busy} onClick={() => void install("db", "更新数据集")}>更新数据集</Button>
                                ) : null}
                                <Tooltip title="刷新状态与远端清单">
                                    <Button icon={<RefreshCw className="size-3.5" />} loading={statusQuery.isFetching} onClick={() => { refreshStatus(); void queryClient.invalidateQueries({ queryKey: ["prompt-library"] }); }} />
                                </Tooltip>
                            </div>
                        </div>
                    )}
                />
                {available ? (
                    <ListToolbar
                        className="library-toolbar"
                        active={Boolean(debouncedKeyword) || selectedTags.length > 0}
                        onReset={() => { setKeyword(""); setSelectedTags([]); }}
                        trailing={(
                            <Button icon={<LibraryBig className="size-3.5" />} onClick={() => setFilterOpen((open) => !open)} aria-pressed={filterOpen}>
                                标签筛选{selectedTags.length ? ` · ${selectedTags.length}` : ""}
                            </Button>
                        )}
                    >
                        <Input
                            allowClear
                            className="w-full sm:w-96"
                            prefix={<Search className="size-4 text-foreground/40" />}
                            value={keyword}
                            placeholder="搜索提示词、中文翻译、作者或工具（如：赛博朋克 / watercolor / Midjourney）"
                            onChange={(event) => setKeyword(event.target.value)}
                        />
                    </ListToolbar>
                ) : null}
            </div>

            {busy && progress ? (
                <div className="prompt-library-progress mt-3 rounded-[var(--r-lg)] bg-surface-secondary px-4 py-3">
                    <div className="flex items-center justify-between gap-3 text-sm">
                        <span className="flex min-w-0 items-center gap-2">
                            <Loader2 className="size-4 shrink-0 animate-spin motion-reduce:animate-none text-foreground/48" aria-hidden />
                            <span className="truncate">{progressPhaseLabel(progress.phase)} {progress.target ? `· ${progress.target}` : ""}</span>
                        </span>
                        <span className="shrink-0 tabular-nums text-xs text-foreground/48">
                            {formatBytes(progress.bytes)}{progress.totalBytes > 0 ? ` / ${formatBytes(progress.totalBytes)}` : ""}
                        </span>
                    </div>
                    {progress.totalBytes > 0 ? <Progress className="mt-2" percent={Math.min(100, Math.round((progress.bytes / progress.totalBytes) * 100))} size="small" showInfo={false} /> : null}
                </div>
            ) : null}

            {!available ? (
                <InstallCard status={status} busy={busy} onInstall={(target, label) => void install(target, label)} />
            ) : (
                <div className="canvas-library-frame assets-library-frame prompt-library-frame mt-4">
                    <div className="grid min-h-0 gap-4 lg:grid-cols-[200px_minmax(0,1fr)]">
                        <aside className={`prompt-library-filter-sidebar thin-scrollbar py-3 ${filterOpen ? "block" : "hidden"} lg:block lg:sticky lg:top-0 lg:max-h-[calc(100vh-220px)] lg:overflow-y-auto lg:pr-3`}>
                            <div className="prompt-library-filter-header">
                                <span className="text-[var(--fs-label)] font-semibold">视觉标签</span>
                                {selectedTags.length ? (
                                    <Button type="text" size="small" onClick={() => setSelectedTags([])}>清空</Button>
                                ) : null}
                            </div>
                            {labelsQuery.isLoading ? <div className="py-6 text-center text-xs text-foreground/48">载入标签…</div> : labelsByDimension.map(([dimension, labels]) => (
                                <div key={dimension} className="prompt-library-filter-group">
                                  <span className="prompt-library-filter-dimension">{dimensionLabel(dimension)}</span>
                                    <div className="flex flex-wrap gap-1">
                                        {labels.map((label) => {
                                            const value = `${label.dimension}:${label.key}`;
                                            const active = selectedTags.includes(value);
                                            return (
                                                <button
                                                    key={value}
                                                    type="button"
                                                    className={`prompt-library-tag ${active ? "is-active" : ""}`}
                                                    aria-pressed={active}
                                                    onClick={() => toggleTag(value)}
                                                    title={`${label.displayEn} · ${label.dimension}:${label.key}`}
                                                >
                                                    {label.displayZh || label.displayEn}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </aside>

                        <section className="min-w-0">
                            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                                <div className="flex flex-wrap items-center gap-2">
                                    <h2 className="text-base font-semibold">{debouncedKeyword ? `“${debouncedKeyword}” 的检索结果` : selectedTags.length ? "标签筛选结果" : "最新提示词"}</h2>
                                    <span className="app-projects-header-meta">{itemsQuery.data?.total ?? 0} 条</span>
                                </div>
                                <PacksPanel status={status} busy={busy} onInstall={(target, label) => void install(target, label)} />
                            </div>

                            {itemsQuery.isLoading ? (
                                <div className="library-loading-grid grid min-h-64 place-items-center"><Progress type="circle" size="small" /></div>
                            ) : itemsQuery.isError ? (
                                <div className="library-loading-grid grid min-h-64 place-items-center">
                                    <EmptyState size="compact" title="检索失败" description={itemsQuery.error instanceof Error ? itemsQuery.error.message : "请稍后重试"} />
                                </div>
                            ) : itemsQuery.data && itemsQuery.data.items.length > 0 ? (
                                <>
                                    <CollectionGrid className="library-grid assets-library-grid">
                                        {itemsQuery.data.items.map((item) => (
                                            <PromptCard key={item.tweetId} item={item} onOpen={() => setDetailTweetId(item.tweetId)} />
                                        ))}
                                    </CollectionGrid>
                                    <PaginationBar
                                        current={page}
                                        pageSize={PAGE_SIZE}
                                        total={itemsQuery.data.total}
                                        pageSizeOptions={[24, 48]}
                                        onChange={(nextPage) => setPage(nextPage)}
                                    />
                                </>
                            ) : (
                                <div className="library-loading-grid grid min-h-64 place-items-center">
                                    <EmptyState size="compact" title="没有匹配的提示词" description="换个关键词，或减少标签筛选条件再试。" />
                                </div>
                            )}
                        </section>
                    </div>
                </div>
            )}

            <PromptDetailDrawer tweetId={detailTweetId} onClose={() => setDetailTweetId(null)} />
        </WorkspacePage>
    );
}

function InstallCard({
    status,
    busy,
    onInstall,
}: {
    status: PromptLibraryStatus | undefined;
    busy: boolean;
    onInstall: (target: string, label: string) => void;
}) {
    const dbAsset = status?.db;
    const dbInstalled = status?.dbInstalled;
    return (
        <section className="library-card-surface mt-4 flex min-h-72 flex-col items-center justify-center rounded-[var(--r-xl)] px-6 py-10 text-center">
            <span className="grid size-14 place-items-center rounded-[var(--r-lg)] bg-[var(--workspace-accent-soft)] text-[var(--workspace-accent)]"><LibraryBig className="size-7" aria-hidden="true" /></span>
            <h2 className="mt-4 text-base font-semibold">安装提示词参考数据集</h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-foreground/55">
                数据来自开源项目 <a href={SOURCE_REPO_URL} target="_blank" rel="noreferrer" className="underline underline-offset-2">open-image-prompts</a>（推文公开提示词镜像，仅作本地参考检索）。
                数据库下载约 {dbAsset ? formatBytes(dbAsset.size) : "130 MB"}，解压后约 420 MB，落在后端数据目录；成图需按月下载图片包。
            </p>
            {status?.external ? (
                <p className="mt-3 text-xs text-foreground/48">已通过 CANVAS_PROMPT_LIBRARY_DB 指定外部数据库：{status.dbPath}（文件尚未就位）。</p>
            ) : null}
            {status?.remoteError && !busy ? <p className="mt-3 max-w-xl text-xs text-foreground/48">远端清单暂不可达：{status.remoteError}</p> : null}
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                <Button
                    type="primary"
                    icon={<Download className="size-4" />}
                    disabled={busy || !dbAsset}
                    onClick={() => onInstall("db", "下载数据集")}
                >
                    {dbInstalled ? "重新下载/修复数据集" : "下载数据集"}
                </Button>
            </div>
            {dbAsset ? <p className="mt-3 text-xs text-foreground/40">版本 {dbAsset.tag} · {formatBytes(dbAsset.size)} · sha256 校验下载</p> : null}
        </section>
    );
}

function PacksPanel({
    status,
    busy,
    onInstall,
}: {
    status: PromptLibraryStatus | undefined;
    busy: boolean;
    onInstall: (target: string, label: string) => void;
}) {
    const packs = status?.packs ?? [];
    const installed = packs.filter((pack) => pack.installed).length;
    const allInstalled = packs.length > 0 && installed === packs.length;
    return (
        <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-foreground/48">图片包 {installed}/{packs.length}</span>
            <Button size="small" icon={<Download className="size-3.5" />} disabled={busy || allInstalled} onClick={() => onInstall("packs", "下载全部图片包")}>
                {allInstalled ? "图片包已齐" : "下载全部图片包"}
            </Button>
            {packs.length > 0 && !allInstalled ? (
                <Button size="small" type="text" disabled={busy} onClick={() => onInstall(packs.find((pack) => !pack.installed)?.name ?? "packs", "下载缺失图片包")}>
                    只下最新缺失包
                </Button>
            ) : null}
        </div>
    );
}

function PromptCard({ item, onOpen }: { item: PromptLibraryItem; onOpen: () => void }) {
    const cover = item.images.find((image) => image.localReady) ?? item.images[0];
    return (
        <AssetLibraryCard>
            <AssetLibraryCardMedia className="assets-cover">
                <button type="button" className="assets-cover-link" onClick={onOpen} aria-label={"查看提示词详情：" + item.author}>
                    {cover && cover.localReady ? (
                        <img
                            src={promptLibraryImageUrl(item.tweetId, cover.index)}
                            alt={item.translationZh || item.promptText.slice(0, 60)}
                            loading="lazy"
                            decoding="async"
                            className="assets-cover-media"
                        />
                    ) : (
                        <div className="prompt-library-cover-fallback" title="下载对应月份图片包后显示成图">
                            <ImageOff className="size-6" aria-hidden />
                            <span>图片包未下载</span>
                        </div>
                    )}
                    <span className="assets-cover-vignette" aria-hidden="true" />
                </button>
                <span className="assets-cover-badges">
                    {item.tool ? <span className="assets-cover-badge is-kind">{item.tool}</span> : null}
                    {item.imageCount > 1 ? <span className="assets-cover-badge is-category">{item.imageCount} 图</span> : null}
                </span>
            </AssetLibraryCardMedia>
            <button type="button" className="block w-full px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--workspace-accent)]" onClick={onOpen}>
                <div className="flex min-w-0 items-center justify-between gap-2">
                    <span className="truncate text-[var(--fs-body)] font-semibold text-foreground">{item.author || "匿名"}</span>
                    <span className="shrink-0 text-[var(--fs-tiny)] tabular-nums text-foreground/38">{item.createdAt ? item.createdAt.slice(4, 10) : ""}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-[var(--fs-label)] leading-5 text-foreground/52">{item.translationZh || item.promptText}</p>
                {item.tags.length ? (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                        {item.tags.slice(0, 3).map((tag) => (
                            <span key={tag.dimension + ":" + tag.key} className="prompt-library-tag is-static">{tag.displayZh || tag.displayEn}</span>
                        ))}
                        {item.tags.length > 3 ? <span className="prompt-library-tag is-static">+{item.tags.length - 3}</span> : null}
                    </div>
                ) : null}
            </button>
        </AssetLibraryCard>
    );
}

function PromptDetailDrawer({ tweetId, onClose }: { tweetId: string | null; onClose: () => void }) {
    const copy = useCopyText();
    const detailQuery = useQuery({
        queryKey: ["prompt-library", "detail", tweetId],
        queryFn: ({ signal }) => fetchPromptLibraryDetail(tweetId ?? "", { signal }),
        enabled: Boolean(tweetId),
    });
    const item = detailQuery.data;
    return (
        <Drawer className="library-drawer prompt-library-drawer" title="提示词详情" open={Boolean(tweetId)} size="large" onClose={onClose}>
            {item ? (
                <div className="space-y-4">
                    <div className="asset-archive-header">
                        <div className="min-w-0">
                            <h2 className="asset-archive-title">{item.author || "匿名作者"}</h2>
                            <p className="asset-archive-subtitle">
                                {[item.tool, item.createdAt].filter(Boolean).join(" · ")}
                                {item.tweetUrl ? (
                                    <>
                                        {" · "}
                                        <a href={item.tweetUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline underline-offset-2">来源推文<ExternalLink className="size-3" aria-hidden /></a>
                                    </>
                                ) : null}
                            </p>
                        </div>
                    </div>

                    {item.images.length ? (
                        <div className="prompt-library-gallery">
                            {item.images.map((image) => (
                                <figure key={image.index} className="prompt-library-gallery-item">
                                    {image.localReady ? (
                                        <img src={promptLibraryImageUrl(item.tweetId, image.index)} alt={"成图 " + image.index} loading="lazy" decoding="async" />
                                    ) : (
                                        <div className="prompt-library-gallery-placeholder"><ImageOff className="size-5" aria-hidden /><span>图片包未下载</span></div>
                                    )}
                                </figure>
                            ))}
                        </div>
                    ) : null}

                    <div>
                        <div className="flex items-center justify-between gap-2">
                            <TypographyStrong>提示词（原文）</TypographyStrong>
                            <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => copy(item.promptText)}>复制</Button>
                        </div>
                        <pre className="prompt-library-prompt-text mt-2 whitespace-pre-wrap break-words rounded-[var(--r-lg)] bg-surface-secondary px-3 py-3 text-xs leading-6 text-foreground/80">{item.promptText}</pre>
                    </div>

                    {item.translationZh ? (
                        <div>
                            <div className="flex items-center justify-between gap-2">
                                <TypographyStrong>中文翻译</TypographyStrong>
                                <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => copy(item.translationZh)}>复制</Button>
                            </div>
                            <pre className="prompt-library-prompt-text mt-2 whitespace-pre-wrap break-words rounded-[var(--r-lg)] bg-surface-secondary px-3 py-3 text-xs leading-6 text-foreground/80">{item.translationZh}</pre>
                        </div>
                    ) : null}

                    {item.recipeEn || item.recipeZh ? (
                        <div>
                            <TypographyStrong>结构化配方</TypographyStrong>
                            <pre className="prompt-library-prompt-text mt-2 whitespace-pre-wrap break-words rounded-[var(--r-lg)] bg-surface-secondary px-3 py-3 text-xs leading-6 text-foreground/80">{item.recipeZh || item.recipeEn}</pre>
                        </div>
                    ) : null}

                    {item.tags.length ? (
                        <div>
                            <TypographyStrong>视觉标签</TypographyStrong>
                            <div className="mt-2 flex flex-wrap gap-1.5">
                                {item.tags.map((tag) => (
                                    <Tag key={tag.dimension + ":" + tag.key} className="m-0">{tag.displayZh || tag.displayEn}</Tag>
                                ))}
                            </div>
                        </div>
                    ) : null}
                </div>
            ) : (
                <div className="grid min-h-40 place-items-center"><Progress type="circle" size="small" /></div>
            )}
        </Drawer>
    );
}

function TypographyStrong({ children }: { children: ReactNode }) {
    return <span className="text-xs font-semibold">{children}</span>;
}

function progressPhaseLabel(phase: string) {
    switch (phase) {
        case "checking": return "正在获取远端清单…";
        case "downloading": return "正在下载";
        case "verifying": return "正在校验";
        case "extracting": return "正在解压";
        default: return "正在处理";
    }
}

function formatBytes(bytes: number) {
    if (!bytes) return "0 B";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

const DIMENSION_LABELS: Record<string, string> = {
    visual_style: "视觉风格",
    scene: "场景",
    subject_type: "主体类型",
    composition: "构图",
    usage: "用途",
    mood: "氛围",
    lighting: "光线",
    color_palette: "色彩",
    camera_lens: "镜头",
    human_attributes: "人物特征",
    workflow: "工作流",
    quality_flags: "质量标记",
};

function dimensionLabel(dimension: string) {
    return DIMENSION_LABELS[dimension] ?? dimension;
}
