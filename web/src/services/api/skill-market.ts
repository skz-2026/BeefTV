import { http } from "./request";
import type { Skill } from "./skills";
import { invalidateAddedSkillsCache } from "./skills";

export type MarketFile = { path: string; sha256: string; size: number; mimeType: string };
export type MarketMetadata = { skillId?: string; name: string; description: string; license: string; sourceUrl: string; versionLabel: string; requirements: string[]; showcase: { url: string; type: string; caption: string }[]; minClientVersion?: string };
export type MarketRelease = MarketMetadata & { skillId: string; releaseId: string; author: string; contentHash: string; archiveSha256: string; archiveBytes: number; files: MarketFile[]; downloadUrl: string; publishedAt: string };
export type MarketPreview = { submissionId: string; revision: number; previewDigest: string; author?: string; files: MarketFile[]; metadata: MarketMetadata; warnings: string[] };
export type PublishPlan = {
    source?: MarketRelease;
    instruction?: string;
    canvasId?: string;
    planId: string;
    skillId: string;
    versionId: string;
    contentHash: string;
    archiveSha256: string;
    metadata: MarketMetadata;
    files: MarketFile[];
    status: string;
    submissionId?: string;
    revision?: number;
    preview?: MarketPreview;
    createdAt: string;
};
export type Submission = { submissionId: string; revision: number; status: string; metadata: MarketMetadata; reviewReason?: string };
const base = "/skills/market";
const changed = invalidateAddedSkillsCache;
export const marketCatalog = (q = "", page = 1) => http.get<{ items: MarketRelease[]; total: number; page: number; pageSize: number }>(`${base}/catalog`, { params: { q, page, pageSize: 20 } });
export const marketRelease = (id: string, release: string) => http.get<MarketRelease>(`${base}/releases/${encodeURIComponent(id)}/${encodeURIComponent(release)}`);
export const installMarketSkill = (skillId: string, releaseId: string) => http.post<{ skill: Skill }>(`${base}/install`, { skillId, releaseId }).finally(changed);
export const marketVersions = (skillId: string) => http.get<{ versions: { id: string; versionLabel: string; contentHash: string; sourceCommit: string; createdAt: string }[] }>(`${base}/versions/${encodeURIComponent(skillId)}`);
export const rollbackMarketSkill = (skillId: string, versionId: string) => http.post<{ skill: Skill }>(`${base}/rollback`, { skillId, versionId }).finally(changed);
export const publishingAuthorization = () => http.get<{ connected: boolean; pending?: boolean }>(`${base}/authorization`);
export const startPublishingAuthorization = () => http.post<{ verificationUrl: string; userCode: string; interval: number }>(`${base}/authorization/start`);
export const disconnectPublishing = () => http.delete(`${base}/authorization`);
export const publishingPlans = () => http.get<{ items: PublishPlan[] }>(`${base}/publish-plans`);
export const preparePublication = (skillId: string, metadata: Partial<MarketMetadata>) => http.post<PublishPlan>(`${base}/publish-plans`, { skillId, metadata });
export const uploadPublication = (p: PublishPlan) => http.post<PublishPlan>(`${base}/publish-plans/${encodeURIComponent(p.planId)}/upload`, { confirmed: true, archiveSha256: p.archiveSha256 });
export const refreshPublication = (p: PublishPlan) => http.post<PublishPlan>(`${base}/publish-plans/${encodeURIComponent(p.planId)}/refresh`);
export const submitPublication = (p: PublishPlan) => http.post<PublishPlan>(`${base}/publish-plans/${encodeURIComponent(p.planId)}/submit`, { confirmed: true, revision: p.preview?.revision, previewDigest: p.preview?.previewDigest });
export const marketSubmissions = () => http.get<{ items: Submission[] }>(`${base}/submissions`);
export const publishingStatusLabel: Record<string, string> = {
    needs_preview: "稿件已变化，需重新读取预览",
    awaiting_upload_confirmation: "待确认上传",
    uploading: "上传未完成，可重试",
    awaiting_submit_confirmation: "待确认送审",
    draft: "草稿",
    ready_to_submit: "待送审",
    submitted: "已送审",
    in_review: "审核中",
    published: "已发布",
    rejected: "需修改",
    withdrawn: "已撤回",
};

export async function openPublishingAuthorization(url: string) {
    const binding = window.go?.main?.DesktopApp;
    if (binding?.OpenSkillPublishingURL) await binding.OpenSkillPublishingURL(url);
    else window.open(url, "_blank", "noopener,noreferrer");
}

export function forkMarketSkill(skillId: string) {
    return http.post<{ skill: Skill }>("/skills/market/fork", { skillId }).finally(changed);
}
