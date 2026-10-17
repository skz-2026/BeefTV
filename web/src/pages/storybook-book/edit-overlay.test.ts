import assert from "node:assert/strict";
import test from "node:test";

import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
// Node 原生 TypeScript 测试运行器要求保留扩展名，项目编译器不允许该写法。
// @ts-expect-error -- Node 原生 TypeScript 测试运行器需要保留扩展名。
import { storybookLineHash } from "@/services/storybook-audio.ts";
// @ts-expect-error -- Node 原生 TypeScript 测试运行器需要保留扩展名。
import { applyEditOverlay, collectEditOverlay, lineAudioStale } from "./edit-overlay.ts";

const asProject = (nodes: Array<Record<string, unknown>>) => ({ id: "storybook-t", nodes }) as unknown as CanvasProject;

test("overlay 只挑可编辑字段，不携带图片引用字段", () => {
    const overlay = collectEditOverlay(asProject([
        { id: "panel-P01", type: "image", metadata: { content: "/api/resources/r1/file", storageKey: "resource:r1", prompt: "p", narration: { text: "n" } } },
        { id: "cast-tuzi", type: "image", metadata: { content: "/api/resources/r2/file" } },
        { id: "storybook-config", type: "text", metadata: { content: "{\"kind\":\"storybook-config\"}" } },
    ]));
    assert.deepEqual(Object.keys(overlay.panelMeta.get("panel-P01") ?? {}).sort(), ["narration", "prompt"]);
    assert.equal(overlay.panelMeta.has("cast-tuzi"), false);
    assert.equal(overlay.configContent, "{\"kind\":\"storybook-config\"}");
});

test("逐字段合并：其他会话写回的图片引用不会被本地旧 metadata 抹掉", () => {
    const overlay = collectEditOverlay(asProject([
        { id: "panel-P01", type: "image", metadata: { content: "local-old", prompt: "旧提示词" } },
    ]));
    const merged = applyEditOverlay([
        { id: "panel-P01", type: "image", metadata: { content: "/api/resources/r9/file", storageKey: "resource:r9", prompt: "新提示词" } },
    ] as unknown as CanvasProject["nodes"], overlay);
    const md = merged[0].metadata as Record<string, unknown>;
    assert.equal(md.content, "/api/resources/r9/file");
    assert.equal(md.storageKey, "resource:r9");
    assert.equal(md.prompt, "旧提示词");
});

test("config 节点整体覆盖，未涉及节点原样保留", () => {
    const overlay = collectEditOverlay(asProject([
        { id: "storybook-config", type: "text", metadata: { content: "B" } },
    ]));
    const merged = applyEditOverlay([
        { id: "other", type: "text", metadata: { content: "keep" } },
        { id: "storybook-config", type: "text", metadata: { content: "A" } },
    ] as unknown as CanvasProject["nodes"], overlay);
    assert.equal((merged[0].metadata as Record<string, unknown>).content, "keep");
    assert.equal((merged[1].metadata as Record<string, unknown>).content, "B");
});

test("配音过期判定：缺音频、改文字、换音色都算过期", () => {
    const text = "下雨了。";
    const voice = "ameng";
    const audio = { storageKey: "resource:a1", url: "", durationMs: 900, textHash: storybookLineHash(text, voice) };
    assert.equal(lineAudioStale(audio, text, voice), false);
    assert.equal(lineAudioStale(undefined, text, voice), true);
    assert.equal(lineAudioStale({ ...audio, storageKey: "" }, text, voice), true);
    assert.equal(lineAudioStale(audio, "下雪了。", voice), true);
    assert.equal(lineAudioStale(audio, text, "wukong-desc"), true);
    assert.equal(lineAudioStale(audio, text, undefined), true);
});
