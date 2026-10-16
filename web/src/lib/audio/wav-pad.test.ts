import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error -- Node 原生 TypeScript 测试运行器需要保留扩展名。
import { padWavSilenceTail } from "./wav-pad.ts";

// 构造最小线性 PCM wav（16bit 单声道），只含 fmt + data 两个块
function buildPcmWav(sampleRate: number, samples: number): ArrayBuffer {
    const dataBytes = samples * 2;
    const buffer = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buffer);
    const ascii = (offset: number, text: string) => {
        for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };
    ascii(0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    ascii(8, "WAVE");
    ascii(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // 单声道
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byteRate
    view.setUint16(32, 2, true); // blockAlign
    view.setUint16(34, 16, true); // bitsPerSample
    ascii(36, "data");
    view.setUint32(40, dataBytes, true);
    for (let i = 0; i < samples; i++) view.setInt16(44 + i * 2, 1000, true);
    return buffer;
}

test("不足目标时长时补零静音并改写 RIFF/data 块长度", () => {
    const wav = buildPcmWav(8000, 8000); // 1s
    const outcome = padWavSilenceTail(wav, 1500);
    assert.ok(outcome.paddedMs > 490 && outcome.paddedMs < 510);
    assert.ok(outcome.durationMs > 1490);
    const view = new DataView(outcome.buffer);
    assert.equal(view.getUint32(4, true), outcome.buffer.byteLength - 8);
    assert.equal(outcome.buffer.byteLength, 44 + 12000 * 2);
    // 原样本保留、追加区为静音（零）
    assert.equal(view.getInt16(44, true), 1000);
    assert.equal(view.getInt16(44 + 8000 * 2, true), 0);
});

test("已达标时原样返回不复制", () => {
    const wav = buildPcmWav(8000, 16000); // 2s
    const outcome = padWavSilenceTail(wav, 1000);
    assert.equal(outcome.buffer, wav);
    assert.equal(outcome.paddedMs, 0);
    assert.equal(outcome.durationMs, 2000);
});

test("非 wav 或非 PCM 输入原样返回且标记解析失败", () => {
    const notWav = new ArrayBuffer(64);
    const outcome = padWavSilenceTail(notWav, 5000);
    assert.equal(outcome.buffer, notWav);
    assert.equal(outcome.paddedMs, 0);
    assert.equal(outcome.durationMs, 0);
});
