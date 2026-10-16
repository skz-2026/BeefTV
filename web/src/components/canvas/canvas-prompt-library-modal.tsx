import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { App, Button, Input, Pagination, Tooltip } from "antd";
import { Copy, ImageOff, LibraryBig, Search } from "lucide-react";

import { AppModal } from "@/components/ui/product/app-modal/app-modal";
import { EmptyState } from "@/components/ui/product/empty-state";
import { useCopyText } from "@/hooks/use-copy-text";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { Link } from "react-router";
import {
    fetchPromptLibraryStatus,
    promptLibraryImageUrl,
    searchPromptLibraryItems,
    type PromptLibraryItem,
} from "@/services/api/prompt-library";

const PAGE_SIZE = 9;

/**
 * 提示词参考库选择器：搜索 open-image-prompts 数据集，选中后把提示词
 * 交给 onInsert（调用方决定追加还是替换）。画布提示词面板与数字人
 * （外貌锚点/场景提示词）共用。
 */
export function CanvasPromptLibraryModal({
    open,
    onClose,
    onInsert,
    insertLabel = "追加",
}: {
    open: boolean;
    onClose: () => void;
    onInsert: (promptText: string) => void;
    /** 插入动作的动词（追加/替换），用于按钮与提示文案。 */
    insertLabel?: string;
}) {
    const { message } = App.useApp();
    const copy = useCopyText();
    const [keyword, setKeyword] = useState("");
    const [page, setPage] = useState(1);
    const debouncedKeyword = useDebouncedValue(keyword, 300);

    useEffect(() => {
        setPage(1);
    }, [debouncedKeyword]);

    const statusQuery = useQuery({
        queryKey: ["prompt-library", "status"],
        queryFn: ({ signal }) => fetchPromptLibraryStatus({ signal }),
        enabled: open,
        staleTime: 30_000,
    });

    const itemsQuery = useQuery({
        queryKey: ["prompt-library", "prompts", debouncedKeyword, page],
        queryFn: ({ signal }) => searchPromptLibraryItems({ query: debouncedKeyword, page, pageSize: PAGE_SIZE, signal }),
        enabled: open && Boolean(statusQuery.data?.available),
        placeholderData: (previous) => previous,
    });

    const items = useMemo(() => itemsQuery.data?.items ?? [], [itemsQuery.data]);

    const insertPrompt = (item: PromptLibraryItem) => {
        onInsert(item.promptText);
        message.success(`已${insertLabel}提示词`);
        onClose();
    };

    return (
        <AppModal
            open={open}
            onCancel={onClose}
            title="提示词参考库"
            width={760}
            footer={null}
        >
            <div className="flex max-h-[70vh] flex-col">
                {statusQuery.data && !statusQuery.data.available ? (
                    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
                        <span className="grid size-12 place-items-center rounded-[var(--r-lg)] bg-surface-secondary text-foreground/50"><LibraryBig className="size-6" aria-hidden /></span>
                        <p className="text-sm text-foreground/60">提示词参考数据集尚未安装。</p>
                        <Link to="/prompt-library"><Button type="primary">去参考库页面安装（约 130 MB）</Button></Link>
                    </div>
                ) : (
                    <>
                        <div className="px-4 pt-4">
                            <Input
                                autoFocus
                                allowClear
                                prefix={<Search className="size-4 text-foreground/40" />}
                                value={keyword}
                                placeholder="搜索提示词或中文翻译（如：赛博朋克 / watercolor）"
                                onChange={(event) => setKeyword(event.target.value)}
                            />
                        </div>
                        <div className="thin-scrollbar min-h-56 flex-1 overflow-y-auto px-4 py-3">
                            {itemsQuery.isLoading ? (
                                <div className="grid min-h-56 place-items-center text-sm text-foreground/48">检索中…</div>
                            ) : items.length ? (
                                <div className="grid grid-cols-3 gap-3 max-[860px]:grid-cols-2">
                                    {items.map((item) => (
                                        <div key={item.tweetId} className="prompt-library-pick-card group rounded-[var(--r-lg)] border border-[var(--user-border,var(--border))] bg-surface-secondary/40">
                                            <button type="button" className="block w-full" onClick={() => insertPrompt(item)} aria-label={`${insertLabel}提示词：` + (item.translationZh || item.promptText.slice(0, 40))}>
                                                <span className="prompt-library-pick-cover block overflow-hidden rounded-t-[var(--r-lg)]">
                                                    {item.images.some((image) => image.localReady) ? (
                                                        <img
                                                            src={promptLibraryImageUrl(item.tweetId, (item.images.find((image) => image.localReady) ?? item.images[0]).index)}
                                                            alt=""
                                                            loading="lazy"
                                                            decoding="async"
                                                            className="h-28 w-full object-cover transition-transform duration-200 group-hover:scale-[1.03] motion-reduce:transition-none"
                                                        />
                                                    ) : (
                                                        <span className="flex h-28 w-full flex-col items-center justify-center gap-1 text-foreground/35"><ImageOff className="size-5" aria-hidden /><span className="text-[10px]">图片包未下载</span></span>
                                                    )}
                                                </span>
                                                <span className="block px-2.5 py-2 text-left">
                                                    <span className="line-clamp-2 text-xs leading-5 text-foreground/70">{item.translationZh || item.promptText}</span>
                                                    <span className="mt-1 block truncate text-[10px] text-foreground/40">{[item.tool, item.author].filter(Boolean).join(" · ")}</span>
                                                </span>
                                            </button>
                                            <span className="flex items-center justify-between gap-1 border-t border-[var(--user-border,var(--border))] px-2 py-1.5">
                                                <Button size="small" type="primary" className="h-6 px-2 text-xs" onClick={() => insertPrompt(item)}>{insertLabel}</Button>
                                                <Tooltip title="复制提示词">
                                                    <Button size="small" type="text" className="h-6 w-6 p-0" aria-label="复制提示词" onClick={() => copy(item.promptText)}>
                                                        <Copy className="size-3.5" />
                                                    </Button>
                                                </Tooltip>
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="grid min-h-56 place-items-center"><EmptyState size="compact" title="没有匹配的提示词" description="换个关键词试试" /></div>
                            )}
                        </div>
                        {itemsQuery.data && itemsQuery.data.total > PAGE_SIZE ? (
                            <div className="flex justify-center border-t border-[var(--user-border,var(--border))] px-4 py-2">
                                <Pagination size="small" current={page} pageSize={PAGE_SIZE} total={Math.min(itemsQuery.data.total, 2000)} onChange={setPage} showSizeChanger={false} />
                            </div>
                        ) : null}
                    </>
                )}
            </div>
        </AppModal>
    );
}
