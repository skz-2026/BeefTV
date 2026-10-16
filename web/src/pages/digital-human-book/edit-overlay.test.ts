import assert from "node:assert/strict";
import test from "node:test";

import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
// @ts-expect-error -- Node 原生 TypeScript 测试运行器需要保留扩展名。
import { applyEditOverlay, collectEditOverlay, withNodeMeta } from "./edit-overlay.ts";

const asProject = (nodes: Array<Record<string, unknown>>) => ({ id: "digitalhuman-t", nodes }) as unknown as CanvasProject;

test("overlay 只挑 seg/scene 可编辑字段与嵌套引用，不携带顶层媒体字段", () => {
    const overlay = collectEditOverlay(asProject([
        { id: "seg-P01", type: "video", metadata: { line: "台词", audio: { storageKey: "resource:a" }, storageKey: "resource:old", content: "/api/old/file" } },
        { id: "scene-S1", type: "image", metadata: { promptEn: "p", frameStorageKey: "resource:f", storageKey: "resource:old-scene" } },
        { id: "script", type: "text", metadata: { content: "用法" } },
        { id: "digitalhuman-config", type: "text", metadata: { content: "{\"kind\":\"digitalhuman-config\"}" } },
    ]));
    assert.deepEqual(Object.keys(overlay.segMeta.get("seg-P01") ?? {}).sort(), ["audio", "line"]);
    assert.deepEqual(Object.keys(overlay.sceneMeta.get("scene-S1") ?? {}).sort(), ["frameStorageKey", "promptEn"]);
    assert.equal(overlay.configContent, "{\"kind\":\"digitalhuman-config\"}");
});

test("逐字段合并：其他会话写回的段视频引用不会被本地旧 metadata 抹掉", () => {
    const overlay = collectEditOverlay(asProject([
        { id: "seg-P01", type: "video", metadata: { line: "新台词" } },
        { id: "scene-S1", type: "image", metadata: { frameStorageKey: "resource:f-local" } },
        { id: "digitalhuman-config", type: "text", metadata: { content: "{\"kind\":\"digitalhuman-config\",\"n\":1}" } },
    ]));
    const merged = applyEditOverlay([
        { id: "seg-P01", type: "video", metadata: { line: "旧台词", storageKey: "resource:new-video", content: "/api/resources/new/file" } },
        { id: "scene-S1", type: "image", metadata: { storageKey: "resource:new-scene" } },
        { id: "digitalhuman-config", type: "text", metadata: { content: "{\"kind\":\"other\"}" } },
    ] as unknown as CanvasProject["nodes"], overlay);
    const seg = merged[0].metadata as Record<string, unknown>;
    assert.equal(seg.line, "新台词");
    assert.equal(seg.storageKey, "resource:new-video");
    assert.equal((merged[1].metadata as Record<string, unknown>).frameStorageKey, "resource:f-local");
    assert.equal((merged[1].metadata as Record<string, unknown>).storageKey, "resource:new-scene");
    assert.equal((merged[2].metadata as Record<string, unknown>).content, "{\"kind\":\"digitalhuman-config\",\"n\":1}");
});

test("withNodeMeta 只改目标节点", () => {
    const doc = asProject([
        { id: "seg-P01", type: "video", metadata: { line: "a" } },
        { id: "seg-P02", type: "video", metadata: { line: "b" } },
    ]);
    const next = withNodeMeta(doc, "seg-P02", (md) => ({ ...md, line: "b2" }));
    assert.equal((next.nodes[0].metadata as Record<string, unknown>).line, "a");
    assert.equal((next.nodes[1].metadata as Record<string, unknown>).line, "b2");
});
