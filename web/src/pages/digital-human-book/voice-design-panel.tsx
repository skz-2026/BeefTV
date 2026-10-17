import { useState } from "react";
import { Button, Input, Select } from "antd";
import { AudioOutlined } from "@ant-design/icons";

import { designChannelVoice } from "@/services/api/audio";
import type { AiConfig } from "@/stores/use-config-store";

// 页内音色工坊：性别/音高/语速 → Spark 设计 → 草稿试听 → 由页面统一「使用/丢弃」。
// 免去跳到数字人管理页单独做音色。

type Level = "very_low" | "low" | "moderate" | "high" | "very_high";
const LEVELS: Level[] = ["very_low", "low", "moderate", "high", "very_high"];
const LEVEL_LABEL: Record<Level, string> = { very_low: "很低", low: "低", moderate: "中", high: "高", very_high: "很高" };

export function VoiceDesignPanel({ requestConfig, sampleText, onDraft }: {
    requestConfig: AiConfig;
    sampleText: string;
    onDraft: (blob: Blob, name: string, text: string) => void;
}) {
    const [gender, setGender] = useState<"female" | "male">("female");
    const [pitch, setPitch] = useState<Level>("high");
    const [speed, setSpeed] = useState<Level>("moderate");
    const [text, setText] = useState(sampleText);
    const [name, setName] = useState("");
    const [busy, setBusy] = useState(false);

    const generate = async () => {
        const sample = text.trim() || sampleText;
        setBusy(true);
        try {
            // 首次设计约 30-60 秒（Spark 子进程即用即卸）
            const blob = await designChannelVoice(requestConfig, { gender, pitch, speed, text: sample });
            onDraft(blob, name.trim() || `voice-${Date.now() % 100000}`, sample);
        } finally {
            setBusy(false);
        }
    };

    return (
        <div style={{ border: "1px solid var(--user-border, var(--border))", borderRadius: 10, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                <div>
                    <div style={{ fontSize: 12, color: "var(--muted, #8b929e)", marginBottom: 4 }}>性别</div>
                    <Select value={gender} onChange={setGender} disabled={busy} style={{ width: "100%" }}
                        options={[{ value: "female", label: "女声" }, { value: "male", label: "男声" }]} />
                </div>
                <div>
                    <div style={{ fontSize: 12, color: "var(--muted, #8b929e)", marginBottom: 4 }}>音高</div>
                    <Select value={pitch} onChange={setPitch} disabled={busy} style={{ width: "100%" }}
                        options={LEVELS.map((l) => ({ value: l, label: LEVEL_LABEL[l] }))} />
                </div>
                <div>
                    <div style={{ fontSize: 12, color: "var(--muted, #8b929e)", marginBottom: 4 }}>语速</div>
                    <Select value={speed} onChange={setSpeed} disabled={busy} style={{ width: "100%" }}
                        options={LEVELS.map((l) => ({ value: l, label: LEVEL_LABEL[l] }))} />
                </div>
            </div>
            <div>
                <div style={{ fontSize: 12, color: "var(--muted, #8b929e)", marginBottom: 4 }}>试听文案</div>
                <Input.TextArea rows={2} value={text} onChange={(e) => setText(e.target.value)} disabled={busy} placeholder={sampleText} />
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, color: "var(--muted, #8b929e)", marginBottom: 4 }}>音色名（入库后跨期复用）</div>
                    <Input value={name} onChange={(e) => setName(e.target.value)} disabled={busy} placeholder="留空自动命名" />
                </div>
                <Button type="primary" icon={<AudioOutlined />} loading={busy} disabled={!requestConfig.baseUrl} onClick={() => void generate()}>
                    {busy ? "设计中（首次约 30-60 秒）…" : "设计并试听"}
                </Button>
            </div>
            <div style={{ fontSize: 11, opacity: 0.55 }}>Spark-TTS 即用即卸；产物在下方预览条试听，点「使用」后保存进音色库并绑定到本册数字人。</div>
            {!requestConfig.baseUrl ? <div style={{ fontSize: 12, color: "#d46b08" }}>数字人档案缺配音模型，无法设计音色</div> : null}
        </div>
    );
}
