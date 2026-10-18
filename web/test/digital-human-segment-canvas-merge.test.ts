import { describe, expect, test } from "bun:test";

import type { CanvasNodeData } from "@/types/canvas";
import type { PersonaSnapshot, SceneNodeInfo, SegmentNodeInfo } from "@/services/digital-human-doc";
import { buildSegmentCanvasDoc } from "@/pages/digital-human-book/segment-canvas-doc";
import { applySegmentPulls, formatSegmentCards, mergeProductsIntoBook, nodeProducedOnCanvas, parseSegmentCardText, readSegmentProducts, resourceIdOf } from "@/pages/digital-human-book/segment-canvas-merge";
import { storybookLineHash } from "@/services/storybook-audio";

// 段画布是镜头的生产现场，产物必须能反向回到册画布——否则用户在画布库里
// 重出场景图/首帧/配音/段视频，成片还是旧的。这里锁死那条回写链路的判定规则。

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

const segment: SegmentNodeInfo = {
    id: "P01",
    line: "嘿！问你个问题，两千年前一张纸能贵过丝绸。",
    expression: "",
    action: "",
    camera: "",
    sceneKey: "S1",
    secondsHint: 8,
    videoPrompt: "prompt",
    audio: { storageKey: "resource:audio-1", url: "/api/resources/audio-1/file", durationMs: 7300, speechMs: 6600, voice: "xiaozhi-girl", textHash: "h" },
    videoStorageKey: "resource:video-1",
    videoResourceId: "video-1",
    nodeIndex: 0,
};

const doc = buildSegmentCanvasDoc({ bookId: "book-1", bookTitle: "造纸术", seg: segment, scene, persona });

function patchNode(nodes: CanvasNodeData[], id: string, metadata: Record<string, unknown>): CanvasNodeData[] {
    return nodes.map((node) => (node.id === id ? { ...node, metadata: { ...(node.metadata ?? {}), ...metadata } as CanvasNodeData["metadata"] } : node));
}

describe("segment canvas → book writeback", () => {
    test("resource id survives both storage-key shapes", () => {
        expect(resourceIdOf("resource:abc123")).toBe("abc123");
        expect(resourceIdOf("/api/resources/abc123/file")).toBe("abc123");
        expect(resourceIdOf("")).toBe("");
    });

    test("a freshly synced canvas produces nothing (no accidental overwrite)", () => {
        const products = readSegmentProducts(doc, "P01");
        expect(products).toEqual({});
        for (const node of doc.nodes) expect(nodeProducedOnCanvas(node)).toBe(false);
    });

    test("regenerating the scene image on canvas is recognised as canvas output", () => {
        const changed = patchNode(doc.nodes, "scene-S1", { storageKey: "resource:scene-2", content: "/api/resources/scene-2/file" });
        const products = readSegmentProducts({ nodes: changed }, "P01");
        expect(products.scene?.storageKey).toBe("resource:scene-2");
        // 首帧没重做之前不该被带走
        expect(products.frame).toBeUndefined();
    });

    test("a re-synthesised frame is picked up from the frame node's own pull mark", () => {
        const changed = patchNode(doc.nodes, "wf-frame", { storageKey: "resource:frame-2", content: "/api/resources/frame-2/file" });
        const products = readSegmentProducts({ nodes: changed }, "P01");
        expect(products.frame?.storageKey).toBe("resource:frame-2");
    });

    test("a re-recorded voice carries duration and the current voice id", () => {
        const changed = patchNode(doc.nodes, "wf-voice", {
            storageKey: "resource:audio-2",
            content: "/api/resources/audio-2/file",
            durationMs: 9500,
            mimeType: "audio/wav",
            bytes: 400000,
        });
        const products = readSegmentProducts({ nodes: changed }, "P01");
        expect(products.voice?.storageKey).toBe("resource:audio-2");
        expect(products.voice?.voice).toBe("xiaozhi-girl");
        expect(products.voice?.durationMs).toBe(9500);
        // 补静音的 700ms 尾巴不算说话时长
        expect(products.voice?.speechMs).toBe(8800);
        // 指纹必须按"当前台词 + 当前音色"重算，否则生产页会把新配音判成过期
        expect(products.voice?.textHash).toBe(storybookLineHash(segment.line, "xiaozhi-girl"));
    });

    test("an edited line is written back, but placeholder copy is not", () => {
        const edited = patchNode(doc.nodes, "wf-script", { content: "换过的台词" });
        expect(readSegmentProducts({ nodes: edited }, "P01").line).toBe("换过的台词");

        const blank = buildSegmentCanvasDoc({ bookId: "book-1", bookTitle: "造纸术", seg: { ...segment, line: "" }, scene, persona });
        const placeholder = patchNode(blank.nodes, "wf-script", { content: "（未写台词，双击编辑后再去配音节点生成）" });
        expect(readSegmentProducts({ nodes: placeholder }, "P01").line).toBeUndefined();
    });

    test("old canvases without dhPull never overwrite the book", () => {
        const legacy = doc.nodes.map((node) => {
            const md = { ...(node.metadata ?? {}) } as Record<string, unknown>;
            delete md.dhPull;
            return { ...node, metadata: md as CanvasNodeData["metadata"] };
        });
        expect(readSegmentProducts({ nodes: legacy }, "P01")).toEqual({});
    });

    test("merging a canvas-generated clip rewrites the book segment atomically", () => {
        const bookNodes: CanvasNodeData[] = [
            { id: "seg-P01", type: "video", title: "P01", position: { x: 0, y: 0 }, width: 420, height: 420, metadata: { line: segment.line, sceneKey: "S1", videoResourceId: "video-1", storageKey: "resource:video-1", status: "success" } },
            { id: "scene-S1", type: "image", title: "场景", position: { x: 0, y: 0 }, width: 420, height: 420, metadata: { storageKey: "resource:scene-1", frameStorageKey: "resource:frame-1" } },
        ];
        const products = { video: { storageKey: "resource:video-9", resourceId: "video-9", assetId: "generation_x" } };
        const merged = mergeProductsIntoBook(bookNodes, { segId: "P01", sceneKey: "S1", products });
        expect(merged.changed).toBe(true);
        const seg = merged.nodes.find((node) => node.id === "seg-P01");
        expect(seg?.metadata?.videoResourceId).toBe("video-9");
        expect(seg?.metadata?.storageKey).toBe("resource:video-9");
        expect(seg?.metadata?.content).toBe("/api/resources/video-9/file");
        expect(seg?.metadata?.assetId).toBe("generation_x");
        // 新视频要按当前台词记指纹，否则页面会立刻标"过期"
        expect(seg?.metadata?.videoLineHash).toBeDefined();
        expect(seg?.metadata?.videoSceneKey).toBe("S1");
    });

    test("a new scene image invalidates the old frame (站位按旧场景算的)", () => {
        const bookNodes: CanvasNodeData[] = [
            { id: "scene-S1", type: "image", title: "场景", position: { x: 0, y: 0 }, width: 420, height: 420, metadata: { storageKey: "resource:scene-1", frameStorageKey: "resource:frame-1" } },
        ];
        const merged = mergeProductsIntoBook(bookNodes, { segId: "P01", sceneKey: "S1", products: { scene: { storageKey: "resource:scene-2" } } });
        const sceneNode = merged.nodes.find((node) => node.id === "scene-S1");
        expect(sceneNode?.metadata?.storageKey).toBe("resource:scene-2");
        expect(sceneNode?.metadata?.frameStorageKey).toBe("");
    });

    test("nothing to write back keeps the same array reference", () => {
        const bookNodes: CanvasNodeData[] = [];
        const merged = mergeProductsIntoBook(bookNodes, { segId: "P01", sceneKey: "S1", products: {} });
        expect(merged.changed).toBe(false);
        expect(merged.nodes).toBe(bookNodes);
    });

    test("applySegmentPulls only reports the segments it actually rewrote", () => {
        const bookNodes: CanvasNodeData[] = [
            { id: "seg-P01", type: "video", title: "P01", position: { x: 0, y: 0 }, width: 420, height: 420, metadata: { videoResourceId: "video-1", storageKey: "resource:video-1" } },
            { id: "seg-P02", type: "video", title: "P02", position: { x: 0, y: 0 }, width: 420, height: 420, metadata: { videoResourceId: "video-2", storageKey: "resource:video-2" } },
        ];
        const result = applySegmentPulls(
            bookNodes,
            [
                { seg: { id: "P01", sceneKey: "S1" }, products: { video: { storageKey: "resource:video-9", resourceId: "video-9" } } },
                { seg: { id: "P02", sceneKey: "S1" }, products: {} },
            ],
            () => "S1",
        );
        expect(result.changed).toBe(true);
        expect(result.touched).toEqual(["P01"]);
        expect(result.nodes.find((node) => node.id === "seg-P02")).toBe(bookNodes[1]);
    });

    test("info-card text on the canvas writes back as real cards", () => {
        const edited = patchNode(doc.nodes, "wf-cards", { content: "造纸三步｜三步\n    浸泡沤制\n    *打浆打浆" });
        const products = readSegmentProducts({ nodes: edited }, "P01");
        expect(products.cards).toEqual([
            { id: "card-1", title: "造纸三步", highlight: "三步", lines: [{ text: "浸泡沤制" }, { text: "打浆打浆", gold: true }] },
        ]);
        const bookNodes: CanvasNodeData[] = [
            { id: "seg-P01", type: "video", title: "P01", position: { x: 0, y: 0 }, width: 420, height: 420, metadata: { line: "台词" } },
        ];
        const merged = mergeProductsIntoBook(bookNodes, { segId: "P01", sceneKey: "S1", products });
        expect(merged.changed).toBe(true);
        expect((merged.nodes[0].metadata as Record<string, unknown>).cards).toEqual(products.cards as unknown);
        // 信息卡是合成期叠加层，不把段视频标成过期
        expect((merged.nodes[0].metadata as Record<string, unknown>).videoLineHash).toBeUndefined();
    });

    test("emptying the card text clears the cards on the book side", () => {
        const cleared = patchNode(doc.nodes, "wf-cards", { content: "" });
        // 同步时 dhPull 是空串，内容也是空串 = 没动过
        expect(readSegmentProducts({ nodes: cleared }, "P01").cards).toBeUndefined();
        const hadCards = patchNode(doc.nodes, "wf-cards", { dhPull: "旧卡片｜旧", content: "" });
        expect(readSegmentProducts({ nodes: hadCards }, "P01").cards).toEqual([]);
        const bookNodes: CanvasNodeData[] = [
            { id: "seg-P01", type: "video", title: "P01", position: { x: 0, y: 0 }, width: 420, height: 420, metadata: { cards: [{ id: "c1", title: "旧卡片", highlight: "旧" }] } },
        ];
        const merged = mergeProductsIntoBook(bookNodes, { segId: "P01", sceneKey: "S1", products: { cards: [] } });
        expect(merged.changed).toBe(true);
        expect((merged.nodes[0].metadata as Record<string, unknown>).cards).toBeUndefined();
    });

    test("card text round-trips through the canvas format", () => {
        const cards = [
            { id: "c1", title: "一张纸", highlight: "一个月工资", lines: [{ text: "东汉" }, { text: "贵", gold: true }] },
            { id: "c2", title: "蔡伦" },
        ];
        // id 由位置重新生成（卡片顺序才是画布上的事实），其余字段必须原样还原
        expect(parseSegmentCardText(formatSegmentCards(cards as never))).toEqual([
            { id: "card-1", title: "一张纸", highlight: "一个月工资", lines: [{ text: "东汉" }, { text: "贵", gold: true }] },
            { id: "card-2", title: "蔡伦" },
        ] as never);
    });
});
