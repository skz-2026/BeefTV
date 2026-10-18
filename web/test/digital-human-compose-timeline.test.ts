import { describe, expect, test } from "bun:test";
import { buildEpisodeTimeline, type ComposeSegment } from "@/services/digital-human-media";

// H3 按整数秒出片，配音结束后多出来的那 0.6s 没有音频条件，实测是一段电流噪声
//（P01/P02 都在 6.65s 处突然起噪，而参考配音是 6.70s 结束）。成片必须剪掉。
const seg = (patch: Partial<ComposeSegment> = {}): ComposeSegment => ({
    id: "P01",
    line: "一句台词",
    resourceId: "video-1",
    durationMs: 7291,
    speechMs: 5364,
    ...patch,
});

const videoClipMs = (segment: ComposeSegment) => {
    const timeline = buildEpisodeTimeline([segment], "9:16");
    return timeline.clips.find((clip) => clip.kind === "video")?.durationMs;
};

describe("episode timeline trims the tail the model hallucinated", () => {
    test("cuts the clip at the narration end, before the noise starts", () => {
        expect(videoClipMs(seg({ narrationMs: 6700 }))).toBe(6550);
    });

    test("never cuts into the spoken line", () => {
        // 配音总长只比台词多 100ms 时，仍要留出 200ms 收尾，不能切到话音
        expect(videoClipMs(seg({ durationMs: 7291, narrationMs: 5464, speechMs: 5364 }))).toBe(5564);
    });

    test("keeps the whole clip when there is no narration length", () => {
        expect(videoClipMs(seg())).toBe(7291);
    });

    test("periods follow the trimmed clips so segments stay contiguous", () => {
        const timeline = buildEpisodeTimeline(
            [seg({ id: "P01", narrationMs: 6700 }), seg({ id: "P02", resourceId: "video-2", durationMs: 7291, narrationMs: 6700 })],
            "9:16",
        );
        const videos = timeline.clips.filter((clip) => clip.kind === "video");
        expect(videos.map((clip) => clip.startMs)).toEqual([0, 6550]);
        expect(videos.map((clip) => clip.durationMs)).toEqual([6550, 6550]);
    });

    test("manual in/out points win over the automatic narration cut", () => {
        const timeline = buildEpisodeTimeline([seg({ narrationMs: 6700, trimStartMs: 400, trimEndMs: 5000 })], "9:16");
        const clip = timeline.clips.find((item) => item.kind === "video");
        expect(clip?.sourceStartMs).toBe(400);
        expect(clip?.durationMs).toBe(4600);
    });

    test("a manual out point may reach past the narration cut when the editor asked for it", () => {
        const timeline = buildEpisodeTimeline([seg({ narrationMs: 6700, trimEndMs: 7000 })], "9:16");
        expect(timeline.clips.find((item) => item.kind === "video")?.durationMs).toBe(7000);
    });

    test("never trims to less than a couple of frames", () => {
        const timeline = buildEpisodeTimeline([seg({ narrationMs: 6700, trimStartMs: 5000, trimEndMs: 5010 })], "9:16");
        expect(timeline.clips.find((item) => item.kind === "video")?.durationMs).toBe(200);
    });
});

describe("background music lands on the audio track", () => {
    const bgm = { resourceId: "music-1", title: "轻音乐", volume: 0.12, fadeInMs: 800, fadeOutMs: 1500, loop: true, durationMs: 3000 };

    test("loops a short track to cover the whole episode, fading only at the outer edges", () => {
        const timeline = buildEpisodeTimeline(
            [seg({ id: "P01", narrationMs: 6700 }), seg({ id: "P02", resourceId: "video-2", narrationMs: 6700 })],
            "9:16",
            bgm,
        );
        const audio = timeline.clips.filter((clip) => clip.kind === "audio");
        // 成片 13.1s、曲子 3s → 5 段（最后一段截断）
        expect(audio.map((clip) => [clip.startMs, clip.durationMs])).toEqual([[0, 3000], [3000, 3000], [6000, 3000], [9000, 3000], [12000, 1100]]);
        expect(audio[0].fadeInMs).toBe(800);
        expect(audio.slice(1).map((clip) => clip.fadeInMs)).toEqual([0, 0, 0, 0]);
        expect(audio.at(-1)?.fadeOutMs).toBe(1500);
        expect(audio[0].trackId).toBe("audio-1");
        expect(audio[0].volume).toBe(0.12);
    });

    test("keeps a single clip when the track is long enough, with no fade on non-existent seams", () => {
        const timeline = buildEpisodeTimeline([seg({ narrationMs: 6700 })], "9:16", { ...bgm, durationMs: 60000 });
        const audio = timeline.clips.filter((clip) => clip.kind === "audio");
        expect(audio).toHaveLength(1);
        expect(audio[0]).toMatchObject({ startMs: 0, durationMs: 6550, fadeInMs: 800, fadeOutMs: 1500 });
    });

    test("no music configured means no audio clips", () => {
        expect(buildEpisodeTimeline([seg()], "9:16").clips.some((clip) => clip.kind === "audio")).toBe(false);
    });
});
