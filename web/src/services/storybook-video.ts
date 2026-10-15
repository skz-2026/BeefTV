import { exportTimelineToMp4 } from "@/lib/timeline/timeline-export";
import { DEFAULT_AUDIO_TRACK_ID, DEFAULT_VIDEO_TRACK_ID } from "@/lib/timeline/timeline-tracks";
import type { TimelineRenderSource } from "@/lib/timeline/timeline-to-ffmpeg";
import { uploadMediaFile } from "@/services/file-storage";
import type { TimelineClip, TimelineProject } from "@/types/timeline";

// 有声绘本视频：页 PNG（浏览器渲染，文字已画进页面）+ 旁白/对白音频 → 时间线（image 段 + 独立音轨 amix）
// → ffmpeg.wasm MP4。不经模型生成视频渠道；每页时长 = 页内音频总长 + 停顿，无音频页按默认停留。

const SEGMENT_GAP_MS = 300; // 同页两句台词之间的呼吸
const PAGE_TAIL_MS = 700;   // 翻页前的停留
const SILENT_PAGE_MS = 2500; // 无音频页（封面/封底/未配音）默认停留
const AUDIO_SLACK_MS = 60;  // clip 时长相对元数据时长留余量，防 ffprobe 实测略短触发"素材时长不足"

export type StorybookVideoPage = {
    png: Blob;
    audio: Array<{ storageKey: string; durationMs: number }>;
};

export type StorybookVideoProgress = { phase: "render" | "encoding"; percent: number; detail: string };

export async function exportStorybookVideo(opts: {
    pages: StorybookVideoPage[];
    width: number;
    height: number;
    fps?: number;
    onProgress?: (p: StorybookVideoProgress) => void;
    signal?: AbortSignal;
}): Promise<Blob> {
    const { pages, width, height, fps = 12, onProgress, signal } = opts;
    if (!pages.length) throw new Error("没有可导出的页面");
    if (width % 2 || height % 2) throw new Error("视频宽高必须为偶数");
    const clips: TimelineClip[] = [];
    const sources: TimelineRenderSource[] = [];
    let cursor = 0;
    for (let i = 0; i < pages.length; i++) {
        signal?.throwIfAborted();
        onProgress?.({ phase: "render", percent: Math.round((i / pages.length) * 100), detail: `上传第 ${i + 1}/${pages.length} 页` });
        const page = pages[i];
        const segs = page.audio.filter((a) => a.durationMs > 0);
        const audioTotal = segs.reduce((sum, a) => sum + a.durationMs, 0);
        const pageDur = segs.length ? audioTotal + (segs.length - 1) * SEGMENT_GAP_MS + PAGE_TAIL_MS : SILENT_PAGE_MS;
        const uploaded = await uploadMediaFile(page.png, "image");
        const imgNodeId = `sb-img-${i}`;
        clips.push({ id: imgNodeId, kind: "image", nodeId: imgNodeId, trackId: DEFAULT_VIDEO_TRACK_ID, startMs: cursor, durationMs: pageDur, title: `第 ${i + 1} 页` });
        sources.push({ nodeId: imgNodeId, fileName: `input-${sources.length}.mp4`, durationMs: pageDur, storageKey: uploaded.storageKey });
        let t = cursor;
        for (let j = 0; j < segs.length; j++) {
            const seg = segs[j];
            const clipId = `sb-aud-${i}-${j}`;
            const clipDur = Math.max(200, Math.round(seg.durationMs - AUDIO_SLACK_MS));
            clips.push({ id: clipId, kind: "audio", nodeId: clipId, trackId: DEFAULT_AUDIO_TRACK_ID, startMs: t, durationMs: clipDur, sourceStartMs: 0 });
            sources.push({ nodeId: clipId, fileName: `input-${sources.length}.mp4`, durationMs: clipDur, hasAudio: true, storageKey: seg.storageKey });
            t += seg.durationMs + (j + 1 < segs.length ? SEGMENT_GAP_MS : 0);
        }
        cursor += pageDur;
    }
    const timeline: TimelineProject = {
        version: 2,
        tracks: [
            { id: DEFAULT_VIDEO_TRACK_ID, kind: "video", label: "视频 1", order: 0 },
            { id: DEFAULT_AUDIO_TRACK_ID, kind: "audio", label: "音频 1", order: 1 },
        ],
        clips,
        durationMs: cursor,
    };
    return await exportTimelineToMp4(timeline, sources, {
        context: { width, height, fps, burnSubtitles: false },
        signal,
        onProgress: (p) => onProgress?.({ phase: "encoding", percent: p.percent, detail: p.detail }),
    });
}
