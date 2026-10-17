import assert from "node:assert/strict";
import test from "node:test";

// Bun 直接执行 TypeScript 测试时需要保留扩展名；生产 tsconfig 不包含 test/。
import { DEFAULT_VIDEO_PROMPT_MAX_CHARS, defaultModelCapabilityConfig, modelCapabilityConfigFor, normalizeVideoValue, videoDurationAllowed } from "../src/lib/model-capabilities.ts";
import { modelCompatibilityError } from "../src/lib/model-selection.ts";
import type { AiConfig } from "../src/stores/use-config-store.ts";
import { seedanceTaskOptions, seedanceOmniTaskType } from "../src/lib/seedance-task-constraints.ts";

test("Dreamina native defaults expose editing and valid duration choices without expanding saved profiles", () => {
    const model = "dreamina-seedance-2-5-260628";
    const profile = defaultModelCapabilityConfig("volcengine-ark-video", model).video!;
    assert.ok(profile.operations.includes("inpaint") && profile.operations.includes("extend"));
    assert.ok(profile.ratios.includes("adaptive"));
    assert.equal(profile.duration.selection, "enum");
    assert.deepEqual(profile.duration.values, [-1, ...Array.from({ length: 27 }, (_, index) => index + 4)]);
    assert.deepEqual(defaultModelCapabilityConfig("volcengine-ark-video", "dreamina-seedance-2-0-fast-260128").video!.duration.values, [-1, ...Array.from({ length: 12 }, (_, index) => index + 4)]);
    for (const value of [-1, 4, 30]) assert.ok(videoDurationAllowed(profile, value));
    for (const value of [1, 3, 31]) assert.equal(videoDurationAllowed(profile, value), false);
    const config = { channels: [{ id: "custom", models: [model], modelProfiles: [{ model, protocol: "volcengine-ark-video" }] }] } as AiConfig;
    for (const operation of ["inpaint", "extend"]) assert.equal(modelCompatibilityError(config, `custom::${model}`, { capability: "video", videoSeconds: "6", videoOperation: operation as "inpaint" | "extend", input: { textCount: 1, imageCount: 0, characterCount: 0, videoCount: 1, audioCount: 0 } }), "");
    config.channels[0].modelProfiles![0].capabilityConfig = { version: 1, video: { ...profile, operations: ["text_to_video"], duration: { ...profile.duration, min: 5 }, ratios: ["16:9"] } };
    assert.deepEqual(modelCapabilityConfigFor(config, `custom::${model}`).video!.operations, ["text_to_video"]);
    assert.equal(modelCapabilityConfigFor(config, `custom::${model}`).video!.duration.min, 5);
    assert.deepEqual(modelCapabilityConfigFor(config, `custom::${model}`).video!.ratios, ["16:9"]);
    assert.equal(defaultModelCapabilityConfig("volcengine-ark-video", "doubao-seedance-2-5-260628").video!.duration.min, 1);
    assert.equal(defaultModelCapabilityConfig("newapi", model).video!.duration.min, 1);
});

test("Dreamina 2.5 enables audio-only and keeps edit and extension task constraints", () => {
    const model = "dreamina-seedance-2-5-260628";
    const video = defaultModelCapabilityConfig("volcengine-ark-video", model).video!;
    assert.equal(video.references.maxImages, 30);
    assert.equal(video.references.maxVideos, 10);
    assert.equal(video.references.maxAudios, 10);
    assert.equal(video.duration.max, 30);
    assert.ok(video.operations.includes("audio_to_video"));
    assert.deepEqual(seedanceTaskOptions(model, "16:9", 6, [], 1, "inpaint"), { ratio: "adaptive", duration: -1 });
    assert.equal(seedanceOmniTaskType(model, "extend", 1), "extend");
    assert.deepEqual(seedanceTaskOptions(model, "16:9", 6, ["first_frame"], 0), { ratio: "adaptive", duration: 6 });
});

test("Dreamina Fast and Mini restrict native defaults without changing standard or custom profiles", () => {
    for (const model of ["dreamina-seedance-2-0-fast-260128", "dreamina-seedance-2-0-mini-260615"]) {
        assert.deepEqual(defaultModelCapabilityConfig("volcengine-ark-video", model).video!.resolutions, ["480p", "720p"]);
        const config = { channels: [{ id: "custom", models: [model], modelProfiles: [{ model, protocol: "volcengine-ark-video", capabilityConfig: { version: 1, video: { ...defaultModelCapabilityConfig("volcengine-ark-video", model).video!, resolutions: ["720p"] } } }] }] } as AiConfig;
        assert.deepEqual(modelCapabilityConfigFor(config, `custom::${model}`).video!.resolutions, ["720p"]);
    }
    assert.deepEqual(defaultModelCapabilityConfig("volcengine-ark-video", "dreamina-seedance-2-0-260128").video!.resolutions, ["480p", "720p", "1080p"]);
});

test("FullVideo full models accept one or two image references as well as mixed video references", () => {
    for (const name of ["sd-native-full-2.0", "sd-native-full-2.5", "原生不卡人脸-全参2.0", "原生不卡人脸-全参2.5"]) {
        const config = { channels: [{ id: "fullvideo", baseUrl: "https://video.example.com/v1", models: [name], modelProfiles: [{ model: name, capability: "video", protocol: "full-video" }] }] } as AiConfig;
        for (const [imageCount, videoCount] of [[1, 0], [2, 0], [0, 1], [2, 1]]) {
            assert.equal(modelCompatibilityError(config, `fullvideo::${name}`, {
                capability: "video", videoSeconds: "5",
                input: { textCount: 1, imageCount, videoCount, audioCount: 0, characterCount: 0 },
            }), "");
        }
    }
});

test("switching to MiniMax H3 replaces an unsupported 720p value with 768P", () => {
    const profile = defaultModelCapabilityConfig("minimax-video", "MiniMax-H3").video!;

    assert.deepEqual(normalizeVideoValue(profile, { seconds: "11", ratio: "16:9", resolution: "720" }), {
        seconds: "11",
        ratio: "16:9",
        resolution: "768P",
    });
});

// 视频提示词由「输入框文本 + 连线内容 + 技能上下文」合成，技能上下文预算为 32000，
// 合成结果远长于用户手输内容。默认上限过小会把正常可用的画布工作流拦在本地预检。
// 这里锁定默认值本身，避免被改回偏小值（前端放行/后端拒绝的判定必须同源）。
test("video prompt default allows a composed canvas prompt", () => {
    assert.equal(DEFAULT_VIDEO_PROMPT_MAX_CHARS, 8000);
    for (const protocol of [undefined, "seedance-videos-compatible", "agnes-video", "volcengine-ark-video"]) {
        const profile = defaultModelCapabilityConfig(protocol, "test-model");
        assert.equal(profile.video!.references.promptMaxChars, DEFAULT_VIDEO_PROMPT_MAX_CHARS);
    }
});

test("raising the video default leaves text and image limits untouched", () => {
    // 只放宽视频默认值，避免顺带改变其它能力的判定口径。
    const profile = defaultModelCapabilityConfig("seedance-videos-compatible", "sd-2.5");
    assert.equal(profile.text!.references.promptMaxChars, 32000);
    assert.equal(profile.image!.references.promptMaxChars, 32000);
});

test("APIMart NewAPI channel exposes Seedance multimodal reference operations", () => {
    const profile = defaultModelCapabilityConfig("newapi-channel-2", "seedance-2.0-fast").video!;
    assert.deepEqual(profile.references.maxVideos, 3);
    assert.ok(profile.operations.includes("reference_to_video"));
    assert.ok(!profile.operations.includes("audio_to_video"));
});

test("BeefAPI generic newapi Seedance accepts mixed image and video references without a persisted capability profile", () => {
    const model = "beefapi::seedance-2.0-fast";
    const config = {
        channels: [{
            id: "beefapi",
            name: "BeefAPI",
            baseUrl: "https://enterprise.beefapi.com",
            apiKey: "test",
            apiFormat: "openai",
            models: ["seedance-2.0-fast"],
            modelProfiles: [{
                model: "seedance-2.0-fast",
                capability: "video",
                protocol: "newapi",
                billingMode: "fixed_request",
                unitPriceMicrocredits: 0,
            }],
        }],
    } as AiConfig;

    const profile = modelCapabilityConfigFor(config, model).video!;
    assert.ok(profile.operations.includes("reference_to_video"));
    assert.ok(profile.references.maxVideos >= 1);
    assert.equal(modelCompatibilityError(config, model, {
        capability: "video",
        input: { textCount: 1, imageCount: 1, videoCount: 1, audioCount: 0, characterCount: 0 },
        videoSeconds: "5",
    }), "");
});
