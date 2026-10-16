// WAV 尾部静音填充：口播段的配音经 lock_source 直通进成片，wav 短于视频时长时
// 上游会外推出电流声（本地短片 E01 复盘结论）。这里在落库前把 wav 补到
// 段时长 + 安全尾缀。纯 ArrayBuffer 实现，浏览器与单测共用；只处理线性 PCM
// （RIFF/WAVE，format=1），解析失败或时长已达标时原样返回，不阻塞配音流程。

export type WavPadOutcome = {
    buffer: ArrayBuffer;
    /** 补静音后的总时长；解析失败时为 0（调用方回落探测值） */
    durationMs: number;
    /** 本次实际追加的静音时长 */
    paddedMs: number;
};

type WavLayout = {
    dataOffset: number;
    dataBytes: number;
    byteRate: number;
};

const TAG_RIFF = 0x52494646;
const TAG_WAVE = 0x57415645;
const TAG_FMT = 0x666d7420;
const TAG_DATA = 0x64617461;

function readLayout(view: DataView): WavLayout | null {
    if (view.byteLength < 44) return null;
    if (view.getUint32(0, false) !== TAG_RIFF || view.getUint32(8, false) !== TAG_WAVE) return null;
    let offset = 12;
    let byteRate = 0;
    let pcm = false;
    while (offset + 8 <= view.byteLength) {
        const id = view.getUint32(offset, false);
        const size = view.getUint32(offset + 4, true);
        const body = offset + 8;
        if (id === TAG_FMT) {
            if (size < 16 || body + 16 > view.byteLength) return null;
            if (view.getUint16(body, true) !== 1) return null; // 仅线性 PCM
            byteRate = view.getUint32(body + 8, true);
            pcm = byteRate > 0;
        } else if (id === TAG_DATA) {
            if (!pcm) return null;
            const bytes = Math.min(size, view.byteLength - body);
            if (bytes <= 0) return null;
            return { dataOffset: body, dataBytes: bytes, byteRate };
        }
        offset = body + size + (size % 2);
    }
    return null;
}

export function padWavSilenceTail(input: ArrayBuffer, targetDurationMs: number): WavPadOutcome {
    const layout = readLayout(new DataView(input));
    if (!layout) return { buffer: input, durationMs: 0, paddedMs: 0 };
    const durationMs = (layout.dataBytes / layout.byteRate) * 1000;
    const missingMs = targetDurationMs - durationMs;
    if (!Number.isFinite(missingMs) || missingMs <= 0) return { buffer: input, durationMs, paddedMs: 0 };
    const padBytes = Math.round((missingMs / 1000) * layout.byteRate);
    const out = new Uint8Array(input.byteLength + padBytes);
    out.set(new Uint8Array(input), 0);
    // 尾部静音即零字节；RIFF 与 data 块长度同步改写
    const outView = new DataView(out.buffer);
    outView.setUint32(4, out.byteLength - 8, true);
    outView.setUint32(layout.dataOffset - 4, layout.dataBytes + padBytes, true);
    const paddedMs = (padBytes / layout.byteRate) * 1000;
    return { buffer: out.buffer, durationMs: durationMs + paddedMs, paddedMs };
}

export async function padWavTailBlob(blob: Blob, targetDurationMs: number): Promise<{ blob: Blob; durationMs: number }> {
    const outcome = padWavSilenceTail(await blob.arrayBuffer(), targetDurationMs);
    if (outcome.paddedMs <= 0) return { blob, durationMs: outcome.durationMs };
    return { blob: new Blob([outcome.buffer], { type: blob.type || "audio/wav" }), durationMs: outcome.durationMs };
}
