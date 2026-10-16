import { http } from "@/services/api/request";

/** 提示词参考库：open-image-prompts 数据集的只读检索与安装。 */

export type PromptLibraryTag = {
    dimension: string;
    key: string;
    displayEn: string;
    displayZh: string;
    confidence: number;
};

export type PromptLibraryLabel = {
    dimension: string;
    key: string;
    displayEn: string;
    displayZh: string;
};

export type PromptLibraryImage = {
    tweetId: string;
    index: number;
    url: string;
    localPath: string;
    localReady: boolean;
};

export type PromptLibraryItem = {
    tweetId: string;
    author: string;
    tool: string;
    promptText: string;
    translationZh: string;
    tweetUrl: string;
    createdAt: string;
    imageCount: number;
    images: PromptLibraryImage[];
    tags: PromptLibraryTag[];
    recipeEn?: string;
    recipeZh?: string;
};

export type PromptLibraryPage = {
    items: PromptLibraryItem[];
    page: number;
    pageSize: number;
    total: number;
    hasMore: boolean;
};

export type PromptLibraryProgress = {
    running: boolean;
    phase: "checking" | "downloading" | "verifying" | "extracting" | "";
    target: string;
    bytes: number;
    totalBytes: number;
    message?: string;
    updatedAt?: string;
};

export type PromptLibraryRemoteAsset = {
    name: string;
    tag: string;
    assetId: number;
    size: number;
    sha256: string;
    htmlUrl?: string;
    uploaded?: string;
};

export type PromptLibraryPackState = {
    name: string;
    size: number;
    sha256: string;
    tag: string;
    installed: boolean;
    installedAt?: string;
    outdated: boolean;
};

export type PromptLibraryInstalledDB = {
    tag: string;
    sha256: string;
    size: number;
    installedAt: string;
};

export type PromptLibraryStatus = {
    available: boolean;
    external: boolean;
    dbPath?: string;
    datasetTag?: string;
    taxonomyVersion?: string;
    promptCount: number;
    imageCount: number;
    translationCount: number;
    db?: PromptLibraryRemoteAsset;
    dbInstalled?: PromptLibraryInstalledDB;
    dbUpdate: boolean;
    packs: PromptLibraryPackState[] | null;
    progress: PromptLibraryProgress;
    remoteError?: string;
    checkedAt?: string;
};

export function fetchPromptLibraryStatus(options?: { signal?: AbortSignal }) {
    return http.get<PromptLibraryStatus>("/prompt-library/status", { signal: options?.signal });
}

export function startPromptLibraryInstall(target: "db" | "packs" | string) {
    return http.post<{ started: boolean; target: string }>("/prompt-library/install", { target });
}

export function listPromptLibraryLabels(options?: { signal?: AbortSignal }) {
    return http.get<{ labels: PromptLibraryLabel[] }>("/prompt-library/labels", { signal: options?.signal });
}

export function searchPromptLibraryItems(input: {
    query?: string;
    tags?: string[];
    tool?: string;
    author?: string;
    page?: number;
    pageSize?: number;
    signal?: AbortSignal;
}) {
    const tags = (input.tags ?? []).filter(Boolean).join(",");
    return http.get<PromptLibraryPage>("/prompt-library/prompts", {
        params: {
            query: input.query?.trim() || undefined,
            tags: tags || undefined,
            tool: input.tool?.trim() || undefined,
            author: input.author?.trim() || undefined,
            page: input.page,
            pageSize: input.pageSize,
        },
        signal: input.signal,
    });
}

export function fetchPromptLibraryDetail(tweetId: string, options?: { signal?: AbortSignal }) {
    return http.get<PromptLibraryItem>(`/prompt-library/prompts/${encodeURIComponent(tweetId)}`, { signal: options?.signal });
}

/** 本地图片包文件端点：交给 <img src> 直连（同源携带凭据），失败即图片包缺失。 */
export function promptLibraryImageUrl(tweetId: string, index: number) {
    return `/api/prompt-library/images/${encodeURIComponent(tweetId)}/${index}/file`;
}

/** 标签的选中值形态："dimension:key"。 */
export function promptLibraryTagValue(tag: Pick<PromptLibraryTag, "dimension" | "key">) {
    return `${tag.dimension}:${tag.key}`;
}
