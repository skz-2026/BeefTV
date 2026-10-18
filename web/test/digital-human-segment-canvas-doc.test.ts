import { describe, expect, test } from "bun:test";

import type { PersonaSnapshot, SceneNodeInfo, SegmentNodeInfo } from "@/services/digital-human-doc";
import { buildSegmentCanvasDoc, segmentCanvasId, segmentCanvasTitle } from "@/pages/digital-human-book/segment-canvas-doc";

const persona: PersonaSnapshot = {
    canvasId: "persona-1",
    name: "元气女主播",
    appearanceEn: "young chinese woman",
    portraitStorageKey: "resource:portrait-1",
    voice: "xiaozhi-girl",
};

const scene: SceneNodeInfo = {
    key: "S1",
    name: "主播位",
    promptEn: "bright cozy study room",
    imageStorageKey: "resource:scene-1",
    frameStorageKey: "resource:frame-1",
    nodeIndex: 1,
};

function segment(patch: Partial<SegmentNodeInfo> = {}): SegmentNodeInfo {
    return {
        id: "P01",
        line: "嘿！问你个问题，两千年前一张纸能贵过丝绸。",
        expression: "",
        action: "",
        camera: "",
        sceneKey: "S1",
        secondsHint: 8,
        videoPrompt: "prompt",
        audio: { storageKey: "resource:audio-1", url: "/api/resources/audio-1/file", durationMs: 7300, voice: "xiaozhi-girl", textHash: "h" },
        videoStorageKey: "resource:video-1",
        videoResourceId: "video-1",
        cards: [{ id: "c1", title: "一张纸 = 一个月工资", highlight: "一个月工资", lines: [{ text: "东汉" }] }],
        nodeIndex: 0,
        ...patch,
    } as SegmentNodeInfo;
}

const baseInput = { bookId: "book-1", bookTitle: "造纸术 · 三分钟看懂", seg: segment(), scene, persona };

describe("segment canvas doc", () => {
    test("one shot one canvas: id and title carry the segment", () => {
        const doc = buildSegmentCanvasDoc(baseInput);
        expect(doc.id).toBe(segmentCanvasId("book-1", "P01"));
        expect(doc.id).toBe("book-1__P01");
        expect(doc.title).toBe("P01 · 造纸术 · 三分钟看懂");
        expect(segmentCanvasTitle("造纸术 · 三分钟看懂", "P16").startsWith("P16 · ")).toBe(true);
        expect(segmentCanvasTitle("", "P02")).toBe("P02 · 镜头画布");
    });

    test("holds the whole shot: line, voice, scene, frame, persona, cards, clip, note", () => {
        const doc = buildSegmentCanvasDoc(baseInput);
        expect(doc.nodes.map((node) => node.id)).toEqual([
            "wf-script", "wf-voice", "scene-S1", "wf-frame", "wf-persona", "wf-cards", "seg-P01", "dh-note",
        ]);
        const byId = new Map(doc.nodes.map((node) => [node.id, node]));
        expect(byId.get("wf-script")?.metadata?.content).toContain("两千年前");
        expect(byId.get("wf-voice")?.metadata?.storageKey).toBe("resource:audio-1");
        expect(byId.get("scene-S1")?.metadata?.storageKey).toBe("resource:scene-1");
        expect(byId.get("wf-frame")?.metadata?.storageKey).toBe("resource:frame-1");
        expect(byId.get("wf-cards")?.metadata?.content).toContain("一个月工资");
        expect(byId.get("seg-P01")?.metadata?.videoResourceId).toBe("video-1");
        expect(byId.get("dh-note")?.metadata?.dhBookId).toBe("book-1");
        expect(byId.get("dh-note")?.metadata?.dhSegmentId).toBe("P01");
    });

    test("voice has a real production node: line + voice + model on a generator", () => {
        const doc = buildSegmentCanvasDoc(baseInput);
        const voice = doc.nodes.find((node) => node.id === "wf-voice");
        expect(voice?.type).toBe("audio");
        // generator 语义是"能生成"的前提：画布靠它决定单击是否打开生成面板
        expect(voice?.metadata?.nodeRole).toBe("generator");
        expect(voice?.metadata?.prompt).toContain("两千年前");
        expect(voice?.metadata?.audioVoice).toBe("xiaozhi-girl");
        // 已有配音挂在同一个节点上：既能播，也能改词重生成（原地替换）
        expect(voice?.metadata?.storageKey).toBe("resource:audio-1");
        expect(voice?.metadata?.durationMs).toBe(7300);

        const muted = buildSegmentCanvasDoc({ ...baseInput, seg: segment({ audio: undefined }) });
        const silentVoice = muted.nodes.find((node) => node.id === "wf-voice");
        expect(silentVoice?.metadata?.storageKey).toBeUndefined();
        expect(silentVoice?.metadata?.nodeRole).toBe("generator");
    });

    test("media nodes carry legal generation semantics and a real generation recipe", () => {
        const doc = buildSegmentCanvasDoc({ ...baseInput, imageModel: "channel::qwen-image-2.1", frameModel: "channel::qwen-edit-plus", videoModel: "vc::h3-hybrid-dub-flf" });
        const media = doc.nodes.filter((node) => node.type === "image" || node.type === "video" || node.type === "audio");
        for (const node of media) {
            // 只有 generator / result 是合法角色，写成别的值会让语义判断整体失效
            expect([`${node.id}:${node.metadata?.nodeRole}`]).toEqual([
                `${node.id}:${node.metadata?.nodeRole === "generator" ? "generator" : "result"}`,
            ]);
        }
        const image = doc.nodes.find((node) => node.id === "scene-S1");
        expect(image?.metadata?.nodeRole).toBe("result");
        expect(image?.metadata?.resultOrigin).toBe("generated");
        // 场景提示词与生产页共用 sceneImagePrompt：以 promptEn 打头，并带上
        // "前景留空地、不放挡人家具"那句（否则首帧合成会多造一把椅子）
        expect(image?.metadata?.prompt).toMatch(/^bright cozy study room/);
        expect(image?.metadata?.prompt).toContain("no people");
        expect(image?.metadata?.prompt).toContain("lower foreground open");
        // 通用画布读 metadata.model 预填生成模型，字段名写错（modelId）就只是死图
        expect(image?.metadata?.model).toBe("channel::qwen-image-2.1");
        expect(image?.metadata?.size).toBe("704x1280");
        // 首帧是两图合成，必须挂图生图模型而不是普通文生图
        const frame = doc.nodes.find((node) => node.id === "wf-frame");
        expect(frame?.metadata?.model).toBe("channel::qwen-edit-plus");
        const clip = doc.nodes.find((node) => node.id === "seg-P01");
        expect(clip?.metadata?.nodeRole).toBe("result");
        expect(clip?.metadata?.prompt).toBe("prompt");
        expect(clip?.metadata?.model).toBe("vc::h3-hybrid-dub-flf");
    });

    test("every node records what was pulled, so canvas-side output can be told apart", () => {
        const doc = buildSegmentCanvasDoc(baseInput);
        const byId = new Map(doc.nodes.map((node) => [node.id, node]));
        expect(byId.get("scene-S1")?.metadata?.dhPull).toBe("resource:scene-1");
        expect(byId.get("wf-frame")?.metadata?.dhPull).toBe("resource:frame-1");
        expect(byId.get("wf-voice")?.metadata?.dhPull).toBe("resource:audio-1");
        expect(byId.get("seg-P01")?.metadata?.dhPull).toBe("resource:video-1");
        // 首帧没有顶层 storageKey，另用 framePull 记场景节点上的旧值
        expect(byId.get("scene-S1")?.metadata?.framePull).toBe("resource:frame-1");
    });

    test("connections only point at nodes that exist", () => {
        const doc = buildSegmentCanvasDoc(baseInput);
        const ids = new Set(doc.nodes.map((node) => node.id));
        for (const connection of doc.connections) {
            expect(ids.has(connection.fromNodeId)).toBe(true);
            expect(ids.has(connection.toNodeId)).toBe(true);
        }
        expect(doc.connections.map((c) => `${c.fromNodeId}->${c.toNodeId}`)).toContain("wf-persona->wf-frame");
        expect(doc.connections.map((c) => `${c.fromNodeId}->${c.toNodeId}`)).toContain("wf-script->wf-voice");
        expect(doc.connections.map((c) => `${c.fromNodeId}->${c.toNodeId}`)).toContain("wf-voice->seg-P01");
        expect(doc.connections.some((c) => c.fromNodeId === "scene-S1" && c.toNodeId === "wf-frame")).toBe(true);
        expect(doc.connections.some((c) => c.toNodeId === "seg-P01")).toBe(true);
        // 段视频要同时拿到「首帧」「身份参考」，否则 H3 的 <Picture 3> 是空的
        expect(doc.connections.map((c) => `${c.fromNodeId}->${c.toNodeId}`)).toContain("wf-persona->seg-P01");
        // 参考图槽位按入边顺序分配：首帧的连接必须排在人物稿前面
        const order = doc.connections.filter((c) => c.toNodeId === "seg-P01").map((c) => c.fromNodeId);
        expect(order.indexOf("wf-frame")).toBeLessThan(order.indexOf("wf-persona"));
    });

    test("video node declares the dub-flf first/last-frame contract", () => {
        const doc = buildSegmentCanvasDoc({ ...baseInput, videoModel: "vc::h3-hybrid-dub-flf" });
        const clip = doc.nodes.find((node) => node.id === "seg-P01");
        // 画布只连两张图，尾帧槽要靠这个声明让生成上下文复制首帧补出来
        expect(clip?.metadata?.dhVideoTemplate).toBe("first-last-frame");
        expect(clip?.metadata?.dhFrameSourceNodeId).toBe("wf-frame");
    });

    test("info cards are editable text and stay out of the prompt", () => {
        const doc = buildSegmentCanvasDoc(baseInput);
        const cards = doc.nodes.find((node) => node.id === "wf-cards");
        expect(cards?.metadata?.content).toBe("一张纸 = 一个月工资｜一个月工资\n    东汉");
        // 信息卡是合成期叠加层：连到段视频上但不能被拼进提示词
        expect(cards?.metadata?.dhOverlayText).toBe(true);

        const empty = buildSegmentCanvasDoc({ ...baseInput, seg: segment({ cards: [] }) });
        const emptyCards = empty.nodes.find((node) => node.id === "wf-cards");
        // 占位提示语一旦写进 content 就会被拼进 H3 的提示词里
        expect(emptyCards?.metadata?.content).toBe("");
        expect(emptyCards?.title).toContain("未配置");
    });

    test("layout does not overlap and matches the editor's real media size", () => {
        const doc = buildSegmentCanvasDoc(baseInput);
        // 图/视频节点在画布编辑器里按 9:16 渲染成 420×764，声明尺寸必须一致，
        // 否则落库后会被撑开挤在一起。
        for (const node of doc.nodes) {
            if (node.type === "image" || node.type === "video") {
                expect([node.width, node.height]).toEqual([420, 764]);
            }
        }
        for (let a = 0; a < doc.nodes.length; a += 1) {
            for (let b = a + 1; b < doc.nodes.length; b += 1) {
                const left = doc.nodes[a];
                const right = doc.nodes[b];
                const overlap =
                    left.position.x < right.position.x + right.width &&
                    right.position.x < left.position.x + left.width &&
                    left.position.y < right.position.y + right.height &&
                    right.position.y < left.position.y + left.height;
                expect(`${left.id}×${right.id}=${overlap}`).toBe(`${left.id}×${right.id}=false`);
            }
        }
    });

    test("fingerprint follows content so a re-sync refreshes only what changed", () => {
        const first = buildSegmentCanvasDoc(baseInput);
        const same = buildSegmentCanvasDoc({ ...baseInput, seg: segment() });
        expect(same.hash).toBe(first.hash);
        const edited = buildSegmentCanvasDoc({ ...baseInput, seg: segment({ line: "换了一句台词" }) });
        expect(edited.hash).not.toBe(first.hash);
        const muted = buildSegmentCanvasDoc({ ...baseInput, seg: segment({ audio: undefined }) });
        expect(muted.hash).not.toBe(first.hash);
    });

    test("missing media degrades to placeholders instead of fake resources", () => {
        const doc = buildSegmentCanvasDoc({
            ...baseInput,
            seg: segment({ audio: undefined, videoResourceId: null, videoStorageKey: null }),
            persona: { ...persona, portraitStorageKey: "" },
        });
        const byId = new Map(doc.nodes.map((node) => [node.id, node]));
        expect(byId.get("wf-voice")?.metadata?.storageKey).toBeUndefined();
        expect(byId.get("wf-voice")?.title).toBe("② 配音 · 未生成");
        expect(byId.get("seg-P01")?.metadata?.storageKey).toBeUndefined();
        expect(byId.get("seg-P01")?.title).toBe("P01 · 未生成");
        expect(byId.get("wf-persona")?.metadata?.content).toBeUndefined();
    });
});
