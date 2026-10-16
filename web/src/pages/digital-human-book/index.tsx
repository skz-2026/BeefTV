import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { App, Alert, Button, Input, Progress, Segmented, Select, Space, Tag, Tooltip } from "antd";
import { ArrowLeftOutlined, AudioOutlined, CheckCircleOutlined, CloudUploadOutlined, DeleteOutlined, DownloadOutlined, ExclamationCircleOutlined, PictureOutlined, PlayCircleOutlined, PlusOutlined, RedoOutlined, ReloadOutlined, SaveOutlined, ScissorOutlined, StopOutlined, ThunderboltOutlined, UndoOutlined, VideoCameraOutlined } from "@ant-design/icons";

import { http } from "@/services/api/request";
import { resourceFileUrl, resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import { padWavTailBlob } from "@/lib/audio/wav-pad";
import { probeMediaDurationMs } from "@/lib/media-metadata";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { useConfigStore } from "@/stores/use-config-store";
import { storybookLineHash } from "@/services/storybook-audio";
import {
    DIGITAL_HUMAN_ASPECTS,
    estimateSegmentSeconds,
    listDigitalHumanPersonas,
    parseDigitalHumanCanvas,
    segmentAudioStale,
    segmentVideoStale,
    type DigitalHumanPersonaCard,
} from "@/services/digital-human-doc";
import {
    composeEpisodeVideo,
    placementFramePrompt,
    runCanvasImageTask,
    runSegmentVideoTask,
    sceneImagePrompt,
    segmentSecondsFor,
    synthesizeSegmentAudio,
    type ComposeSegment,
    type DhImageResult,
} from "@/services/digital-human-media";
import { fillSegmentVideoPrompt } from "@/services/digital-human-split";
import type { TimelineRenderResult } from "@/services/api/timeline-tasks";
import { AssetPickerModal, type AssetPick } from "./asset-picker-modal";
import { applyEditOverlay, collectEditOverlay, withNodeMeta } from "./edit-overlay";
import { CanvasPromptLibraryModal } from "@/components/canvas/canvas-prompt-library-modal";

// 数字人口播生产页：画布文档的专用视图（与绘本成书同模式）。
// 顶栏批量操作（串行可停）｜左段导航｜中预览（段视频/站位首帧）｜右 Segmented
// 台词·音频·场景·成片。链路：逐段 TTS（IndexTTS-2+尾静音）→ 场景图/站位首帧
// （qwen 车道）→ 段视频（h3 dub：首帧+人物稿+配音口型）→ 服务端拼接烧字幕。

type RightTab = "script" | "audio" | "scene" | "export";

export default function DigitalHumanBookPage() {
    const { id } = useParams();
    const navigate = useNavigate();
    const { message, modal } = App.useApp();
    const globalConfig = useConfigStore((state) => state.config);
    const [canvas, setCanvas] = useState<CanvasProject | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [segIndex, setSegIndex] = useState(0);
    const [rightTab, setRightTab] = useState<RightTab>("script");
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    /** 进行中的生成键（audio:P01 / video:P01 / scene:S1 / frame:S1 / prompt:P01）→ taskId|pending */
    const [generating, setGenerating] = useState<Map<string, string>>(new Map());
    const cancelGenRef = useRef(new Set<string>());
    const batchStopRef = useRef(false);
    const [batch, setBatch] = useState<{ label: string; done: number; total: number; current: string } | null>(null);
    const [composing, setComposing] = useState<{ percent: number } | null>(null);
    const [composeResult, setComposeResult] = useState<TimelineRenderResult | null>(null);
    const [personas, setPersonas] = useState<DigitalHumanPersonaCard[]>([]);
    /** 素材选择器：picker:{target} 确定要写入的位置 */
    const [picker, setPicker] = useState<null | { target: "sceneImage" | "sceneFrame" | "segRef" | "segAudio"; key: string }>(null);
    const [sceneLibraryKey, setSceneLibraryKey] = useState<string | null>(null);
    // 撤销/重做：栈存"每次编辑前"的文档快照；mergeKey 合并连续编辑（600ms 同一目标）
    const historyRef = useRef<{ stack: CanvasProject[]; ptr: number; lastKey: string; lastAt: number }>({ stack: [], ptr: -1, lastKey: "", lastAt: 0 });
    const [, setHistoryVersion] = useState(0);
    const pendingKeyRef = useRef("");
    const suppressHistoryRef = useRef(false);
    const canvasRef = useRef<CanvasProject | null>(null);
    canvasRef.current = canvas;
    const audioRef = useRef<HTMLAudioElement | null>(null);

    const load = useCallback(async () => {
        if (!id) return;
        setLoading(true);
        setLoadError(null);
        try {
            const res = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`);
            suppressHistoryRef.current = true;
            setCanvas(res.project);
            setDirty(false);
            historyRef.current = { stack: [res.project], ptr: 0, lastKey: "", lastAt: 0 };
        } catch (error) {
            setLoadError(error instanceof Error ? error.message : String(error));
        } finally {
            setLoading(false);
        }
    }, [id, message]);

    useEffect(() => { void load(); }, [load]);
    useEffect(() => { void listDigitalHumanPersonas().then(setPersonas).catch(() => undefined); }, []);

    const parsed = useMemo(() => (canvas ? parseDigitalHumanCanvas(canvas) : { config: null, scenes: new Map(), segments: [] as ReturnType<typeof parseDigitalHumanCanvas>["segments"] }), [canvas]);
    const { config, scenes, segments } = parsed;
    const persona = config?.persona;
    const aspect = config?.aspect ?? "9:16";
    const geo = DIGITAL_HUMAN_ASPECTS[aspect];
    const current = segments[Math.min(segIndex, Math.max(0, segments.length - 1))];
    const busy = generating.size > 0 || !!batch || !!composing;

    const audioReady = segments.filter((s) => s.audio?.storageKey).length;
    const videoReady = segments.filter((s) => !segmentVideoStale(s)).length;

    // ---------- 保存（overlay 逐字段合并，409 重拉重试） ----------
    const save = useCallback(async (docArg?: CanvasProject) => {
        const doc0 = docArg ?? canvas;
        if (!doc0 || !id) return;
        setSaving(true);
        try {
            const overlay = collectEditOverlay(doc0);
            let saved = false;
            let lastRevision: number | undefined;
            for (let attempt = 0; attempt < 3 && !saved; attempt++) {
                const fresh = attempt === 0
                    ? { project: doc0 }
                    : await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`);
                const doc = fresh.project;
                const nodes = applyEditOverlay(doc.nodes, overlay);
                try {
                    const res = await http.put<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`, { project: { ...doc, nodes }, assets: [] });
                    lastRevision = res.project?.revision;
                    saved = true;
                } catch { /* revision 冲突，重拉 */ }
            }
            if (!saved) throw new Error("连续冲突");
            if (typeof lastRevision === "number") {
                const rev = lastRevision;
                setCanvas((prev) => (prev ? { ...prev, revision: rev } : prev));
            }
            setDirty(false);
        } catch (error) {
            message.error(`保存失败（画布可能在别处已更新，请刷新后重试）：${error instanceof Error ? error.message : String(error)}`);
            throw error;
        } finally {
            setSaving(false);
        }
    }, [canvas, id, message]);

    // ---------- 历史栈（与绘本成书同款） ----------
    useEffect(() => {
        if (!canvas) return;
        if (suppressHistoryRef.current) { suppressHistoryRef.current = false; return; }
        const h = historyRef.current;
        const now = Date.now();
        if (pendingKeyRef.current && pendingKeyRef.current === h.lastKey && now - h.lastAt < 600) {
            h.stack[h.ptr] = canvas;
            h.lastAt = now;
        } else {
            h.stack = h.stack.slice(0, h.ptr + 1);
            h.stack.push(canvas);
            h.ptr = h.stack.length - 1;
            h.lastKey = pendingKeyRef.current;
            h.lastAt = now;
        }
        setHistoryVersion((v) => v + 1);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canvas]);
    const undo = useCallback(() => {
        const h = historyRef.current;
        if (h.ptr <= 0) return;
        h.ptr -= 1;
        suppressHistoryRef.current = true;
        setCanvas(h.stack[h.ptr]);
        h.lastKey = "";
        setHistoryVersion((v) => v + 1);
        setDirty(true);
    }, []);
    const redo = useCallback(() => {
        const h = historyRef.current;
        if (h.ptr + 1 >= h.stack.length) return;
        h.ptr += 1;
        suppressHistoryRef.current = true;
        setCanvas(h.stack[h.ptr]);
        h.lastKey = "";
        setHistoryVersion((v) => v + 1);
        setDirty(true);
    }, []);

    const updateSegMeta = useCallback((segId: string, patch: Record<string, unknown>, historyKey = "") => {
        pendingKeyRef.current = historyKey || `seg:${segId}`;
        setCanvas((prev) => (prev ? withNodeMeta(prev, `seg-${segId}`, (md) => ({ ...md, ...patch })) : prev));
        setDirty(true);
    }, []);

    const updateSceneMeta = useCallback((sceneKey: string, patch: Record<string, unknown>) => {
        pendingKeyRef.current = `scene:${sceneKey}`;
        setCanvas((prev) => (prev ? withNodeMeta(prev, `scene-${sceneKey}`, (md) => ({ ...md, ...patch })) : prev));
        setDirty(true);
    }, []);

    const updateConfig = useCallback((mutate: (cfg: NonNullable<ReturnType<typeof parseDigitalHumanCanvas>["config"]>) => void) => {
        pendingKeyRef.current = "";
        setCanvas((prev) => {
            if (!prev) return prev;
            const nodes = prev.nodes.map((node) => {
                if (node.id !== "digitalhuman-config") return node;
                const md = { ...(node.metadata ?? {}) } as Record<string, unknown>;
                try {
                    const cfg = JSON.parse(String(md.content ?? "{}"));
                    if (cfg?.kind === "digitalhuman-config") {
                        mutate(cfg);
                        md.content = JSON.stringify(cfg);
                    }
                } catch { /* 配置损坏忽略 */ }
                return { ...node, metadata: md };
            });
            return { ...prev, nodes };
        });
        setDirty(true);
    }, []);

    // ---------- 生成：状态与取消 ----------
    const setGen = (key: string, taskId: string | null) => {
        setGenerating((prev) => {
            const next = new Map(prev);
            if (taskId === null) next.delete(key); else next.set(key, taskId);
            return next;
        });
        if (taskId === null) cancelGenRef.current.delete(key);
    };
    const cancelGen = (key: string) => {
        cancelGenRef.current.add(key);
        const tid = generating.get(key);
        if (tid && tid !== "pending") void http.post(`/tasks/${encodeURIComponent(tid)}/cancel`).catch(() => undefined);
    };

    /** 顶层媒体写回（scene 图 / seg 视频）：generated-assets 原子通道 + overlay 保本地编辑 */
    const writeBackMedia = useCallback(async (
        nodeId: string,
        result: DhImageResult,
        kind: "image" | "video",
        title: string,
        metaPatch: Record<string, unknown>,
    ) => {
        if (!id) return;
        const doc = canvasRef.current;
        if (!doc) return;
        const overlay = collectEditOverlay(doc);
        const rid = result.resourceId;
        for (let attempt = 0; attempt < 3; attempt++) {
            const fresh = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`);
            const assetId = "generation_" + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
            const now = new Date().toISOString();
            const mediaPatch = {
                content: `/api/resources/${rid}/file`,
                storageKey: `resource:${rid}`,
                status: "success" as const,
                assetId,
                ...(result.bytes ? { bytes: result.bytes } : {}),
                ...(result.width ? { naturalWidth: result.width } : {}),
                ...(result.height ? { naturalHeight: result.height } : {}),
                ...metaPatch,
            };
            const nodes = applyEditOverlay(fresh.project.nodes, overlay).map((node) => (node.id === nodeId
                ? { ...node, metadata: { ...(node.metadata ?? {}), ...mediaPatch } }
                : node));
            const asset = {
                id: assetId,
                kind,
                category: "material",
                status: "ready",
                primaryVersionId: crypto.randomUUID().replace(/-/g, ""),
                title,
                createdAt: now,
                updatedAt: now,
                coverUrl: `/api/resources/${rid}/file`,
                source: "generation-task",
                data: {
                    bytes: result.bytes ?? 0,
                    dataUrl: `/api/resources/${rid}/file`,
                    height: result.height ?? 0,
                    mimeType: kind === "video" ? "video/mp4" : "image/png",
                    storageKey: `resource:${rid}`,
                    width: result.width ?? 0,
                },
                metadata: { generationEffectKey: `dh-gen:${nodeId}:${now}`, nodeId, outputIndex: 0, source: "generation-task" },
                tags: [],
            };
            try {
                const res = await http.put<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}/generated-assets`, { project: { ...fresh.project, nodes }, assets: [asset] });
                const rev = res.project?.revision;
                setCanvas((prev) => {
                    if (!prev) return prev;
                    const localNodes = prev.nodes.map((n) => (n.id === nodeId ? { ...n, metadata: { ...(n.metadata ?? {}), ...mediaPatch } } : n));
                    return { ...prev, ...(typeof rev === "number" ? { revision: rev } : {}), nodes: localNodes };
                });
                return;
            } catch { /* revision 冲突，拉最新重试 */ }
        }
        throw new Error("画布写入连续冲突（画布可能正在同步），请稍后再试");
    }, [id]);

    // ---------- 配音 ----------
    const generateAudio = useCallback(async (segId: string): Promise<boolean> => {
        const doc = canvasRef.current;
        if (!doc || !persona) return false;
        const seg = parseDigitalHumanCanvas(doc).segments.find((s) => s.id === segId);
        if (!seg) return false;
        if (!seg.line.trim()) { message.warning("台词为空，先写台词"); return false; }
        const ttsModel = persona.voiceModel || "";
        if (!ttsModel) { message.error("数字人档案缺配音模型，请到「数字人」页补齐音色绑定"); return false; }
        const key = `audio:${segId}`;
        cancelGenRef.current.delete(key);
        setGen(key, "pending");
        try {
            const { audio } = await synthesizeSegmentAudio({
                config: globalConfig,
                model: ttsModel,
                line: seg.line,
                voice: persona.voice,
                ...(persona.voiceInstructions ? { instructions: persona.voiceInstructions } : {}),
            });
            const latest = canvasRef.current;
            if (!latest) return false;
            const next = withNodeMeta(latest, `seg-${segId}`, (md) => ({ ...md, audio }));
            suppressHistoryRef.current = true;
            setCanvas(next);
            canvasRef.current = next;
            await save(next);
            if (!batchStopRef.current && !batch) message.success(`${segId} 配音完成`);
            return true;
        } catch (error) {
            if (!batchStopRef.current) message.error(`${segId} 配音失败：${error instanceof Error ? error.message : String(error)}`);
            return false;
        } finally {
            setGen(key, null);
        }
    }, [batch, globalConfig, message, persona, save]);

    // ---------- 场景图 / 站位首帧 ----------
    const generateSceneImage = useCallback(async (sceneKey: string): Promise<boolean> => {
        const doc = canvasRef.current;
        if (!doc || !config) return false;
        const scene = parseDigitalHumanCanvas(doc).scenes.get(sceneKey);
        if (!scene || !config.imageChannel) { message.error("场景或生图渠道缺失"); return false; }
        const key = `scene:${sceneKey}`;
        cancelGenRef.current.delete(key);
        setGen(key, "pending");
        try {
            const { prompt, size } = sceneImagePrompt(scene.promptEn, persona?.style, aspect);
            const result = await runCanvasImageTask({
                projectId: id ?? "",
                model: `${config.imageChannel}::qwen-image-2.1`,
                prompt,
                size,
                nodeId: `scene-${sceneKey}`,
                isCancelled: () => cancelGenRef.current.has(key),
            });
            await writeBackMedia(`scene-${sceneKey}`, result, "image", `场景·${scene.name}`, {});
            message.success(`场景 ${sceneKey} 图已生成`);
            return true;
        } catch (error) {
            if (!cancelGenRef.current.has(key)) message.error(`场景 ${sceneKey} 生成失败：${error instanceof Error ? error.message : String(error)}`);
            return false;
        } finally {
            setGen(key, null);
        }
    }, [aspect, config, id, message, persona?.style, writeBackMedia]);

    const generatePlacementFrame = useCallback(async (sceneKey: string): Promise<boolean> => {
        const doc = canvasRef.current;
        if (!doc || !config || !persona) return false;
        const now = parseDigitalHumanCanvas(doc);
        const scene = now.scenes.get(sceneKey);
        if (!scene) return false;
        if (!scene.imageStorageKey) { message.error(`场景 ${sceneKey} 还没有场景图，先生成场景图`); return false; }
        if (!persona.portraitStorageKey) { message.error("数字人缺人物参考图，请到「数字人」页补齐"); return false; }
        const key = `frame:${sceneKey}`;
        cancelGenRef.current.delete(key);
        setGen(key, "pending");
        try {
            const { prompt, size } = placementFramePrompt(persona.style, aspect);
            // 参考顺序铁律：场景第 1（底图）、人物图第 2（身份）
            const result = await runCanvasImageTask({
                projectId: id ?? "",
                model: `${config.imageChannel}::qwen-edit-plus`,
                prompt,
                size,
                referenceImages: [
                    { storageKey: scene.imageStorageKey, name: "scene.png" },
                    { storageKey: persona.portraitStorageKey, name: "portrait.png" },
                ],
                nodeId: `scene-${sceneKey}`,
                isCancelled: () => cancelGenRef.current.has(key),
            });
            // 站位首帧是嵌套引用：普通 PUT + overlay
            const latest = canvasRef.current;
            if (!latest) return false;
            const next = withNodeMeta(latest, `scene-${sceneKey}`, (md) => ({ ...md, frameStorageKey: `resource:${result.resourceId}` }));
            suppressHistoryRef.current = true;
            setCanvas(next);
            canvasRef.current = next;
            await save(next);
            message.success(`场景 ${sceneKey} 站位首帧已生成`);
            return true;
        } catch (error) {
            message.error(`站位首帧失败：${error instanceof Error ? error.message : String(error)}`);
            return false;
        } finally {
            setGen(key, null);
        }
    }, [aspect, config, id, message, persona, save]);

    const ensureSceneReady = useCallback(async (sceneKey: string): Promise<boolean> => {
        const doc = canvasRef.current;
        if (!doc) return false;
        const scene = parseDigitalHumanCanvas(doc).scenes.get(sceneKey);
        if (!scene) return false;
        if (!scene.imageStorageKey && !(await generateSceneImage(sceneKey))) return false;
        const fresh = parseDigitalHumanCanvas(canvasRef.current ?? doc);
        const freshScene = fresh.scenes.get(sceneKey);
        if (freshScene && !freshScene.frameStorageKey && !(await generatePlacementFrame(sceneKey))) return false;
        return true;
    }, [generatePlacementFrame, generateSceneImage]);

    // ---------- 段视频 ----------
    const generateSegmentVideo = useCallback(async (segId: string): Promise<boolean> => {
        const doc = canvasRef.current;
        if (!doc || !config || !persona || !id) return false;
        const seg = parseDigitalHumanCanvas(doc).segments.find((s) => s.id === segId);
        if (!seg) return false;
        const scene = parseDigitalHumanCanvas(doc).scenes.get(seg.sceneKey) ?? [...parseDigitalHumanCanvas(doc).scenes.values()][0];
        if (!scene) { message.error("找不到分镜对应的场景"); return false; }
        // 依赖链：场景就绪 → 配音新鲜 → 段视频
        if (!(await ensureSceneReady(scene.key))) return false;
        const latestDoc = canvasRef.current;
        if (!latestDoc) return false;
        const latestParsed = parseDigitalHumanCanvas(latestDoc);
        const latestSeg = latestParsed.segments.find((s) => s.id === segId);
        if (!latestSeg) return false;
        if (segmentAudioStale(latestSeg.audio, latestSeg.line, persona.voice)) {
            if (!(await generateAudio(segId))) return false;
        }
        const finalSeg = parseDigitalHumanCanvas(canvasRef.current ?? latestDoc).segments.find((s) => s.id === segId);
        if (!finalSeg?.audio) return false;
        const key = `video:${segId}`;
        cancelGenRef.current.delete(key);
        setGen(key, "pending");
        try {
            const freshScene = parseDigitalHumanCanvas(canvasRef.current ?? latestDoc).scenes.get(finalSeg.sceneKey) ?? scene;
            if (!freshScene.frameStorageKey) { message.error("站位首帧缺失"); return false; }
            const seconds = segmentSecondsFor(finalSeg.audio.durationMs);
            const result = await runSegmentVideoTask({
                projectId: id,
                model: `${config.videoChannel}::${config.videoModel}`,
                prompt: finalSeg.videoPrompt,
                seconds,
                aspect,
                // 参考顺序铁律：站位首帧第 1（IMAGE=构图槽）、人物参考图第 2（IMAGE_2=身份槽）
                referenceImages: [
                    { storageKey: freshScene.frameStorageKey, name: "first-frame.png" },
                    { storageKey: persona.portraitStorageKey, name: "portrait.png" },
                ],
                ...(finalSeg.extraRefs?.length ? { extraRefs: finalSeg.extraRefs } : {}),
                referenceAudios: [{ storageKey: finalSeg.audio.storageKey, name: "drive.wav", durationMs: finalSeg.audio.durationMs }],
                nodeId: `seg-${segId}`,
                isCancelled: () => cancelGenRef.current.has(key),
            });
            setGen(key, "task");
            // 每次渲染都记入候选列表（抽卡）：切换候选时无需重渲
            const existingTakes = finalSeg.takes ?? [];
            const nextTakes = [...existingTakes, {
                resourceId: result.resourceId,
                ...(result.durationMs ? { durationMs: result.durationMs } : {}),
                lineHash: storybookLineHash(finalSeg.line),
                createdAt: new Date().toISOString(),
            }].slice(-8);
            await writeBackMedia(
                `seg-${segId}`,
                { resourceId: result.resourceId, url: result.url },
                "video",
                `${segId} 口播段`,
                {
                    videoResourceId: result.resourceId,
                    videoLineHash: storybookLineHash(finalSeg.line),
                    ...(result.durationMs ? { videoDurationMs: result.durationMs } : {}),
                    takes: nextTakes,
                },
            );
            if (!batchStopRef.current && !batch) message.success(`${segId} 口播视频已生成`);
            return true;
        } catch (error) {
            if (!batchStopRef.current) message.error(`${segId} 视频失败：${error instanceof Error ? error.message : String(error)}`);
            return false;
        } finally {
            setGen(key, null);
        }
    }, [aspect, batch, config, ensureSceneReady, generateAudio, id, message, persona, writeBackMedia]);

    // ---------- 候选（抽卡）：连抽 / 切换 / 删除 ----------
    /** 连抽 n 张候选（串行，每张自动补齐依赖并记入候选列表） */
    const regenTakes = useCallback(async (segId: string, n: number) => {
        for (let i = 0; i < n; i++) {
            if (batchStopRef.current) break;
            if (!(await generateSegmentVideo(segId))) break;
        }
    }, [generateSegmentVideo]);

    /** 切换到指定候选（顶层媒体走 generated-assets，lineHash 用候选渲染时的指纹） */
    const switchTake = useCallback(async (segId: string, rid: string) => {
        const doc = canvasRef.current;
        if (!doc || !id || busy) return;
        const seg = parseDigitalHumanCanvas(doc).segments.find((s) => s.id === segId);
        const take = seg?.takes?.find((t) => t.resourceId === rid);
        if (!seg || !take) return;
        try {
            await writeBackMedia(`seg-${segId}`, { resourceId: rid, url: resourceFileUrl(rid) }, "video", `${segId} 口播段`, {
                videoResourceId: rid,
                videoLineHash: take.lineHash ?? storybookLineHash(seg.line),
                ...(take.durationMs ? { videoDurationMs: take.durationMs } : {}),
            });
            message.success("已切换候选");
        } catch (error) {
            message.error(`切换失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }, [busy, id, message, writeBackMedia]);

    /** 删除候选（不能删当前使用中的那张） */
    const deleteTake = useCallback(async (segId: string, rid: string) => {
        const latest = canvasRef.current;
        if (!latest || busy) return;
        const seg = parseDigitalHumanCanvas(latest).segments.find((s) => s.id === segId);
        if (!seg?.takes?.length) return;
        if (seg.videoResourceId === rid) {
            message.warning("这张正在使用，先切换到其他候选再删除");
            return;
        }
        const next = withNodeMeta(latest, `seg-${segId}`, (md) => ({ ...md, takes: seg.takes!.filter((t) => t.resourceId !== rid) }));
        suppressHistoryRef.current = true;
        setCanvas(next);
        canvasRef.current = next;
        await save(next);
    }, [busy, message, save]);

    // ---------- 批量（串行 + 可停；本机 GPU 单并发） ----------
    const batchGenerateAudio = useCallback(async () => {
        const doc = canvasRef.current;
        if (!doc) return;
        const targets = parseDigitalHumanCanvas(doc).segments.filter((s) => segmentAudioStale(s.audio, s.line, persona?.voice));
        if (!targets.length) { message.info("没有待配音的段"); return; }
        batchStopRef.current = false;
        setBatch({ label: "配音", done: 0, total: targets.length, current: targets[0].id });
        let ok = 0;
        let stopped = false;
        for (let i = 0; i < targets.length; i++) {
            if (batchStopRef.current) { stopped = true; break; }
            setBatch({ label: "配音", done: i, total: targets.length, current: targets[i].id });
            if (await generateAudio(targets[i].id)) ok++;
        }
        setBatch(null);
        if (stopped) message.info(`已停止配音（完成 ${ok} 段）`);
        else message.success(`配音完成：${ok}/${targets.length} 段`);
    }, [generateAudio, message, persona?.voice]);

    const batchGenerateVideos = useCallback(async () => {
        const doc = canvasRef.current;
        if (!doc) return;
        const parsedNow = parseDigitalHumanCanvas(doc);
        const targets = parsedNow.segments.filter((s) => segmentVideoStale(s));
        if (!targets.length) { message.info("没有待生成的段视频"); return; }
        batchStopRef.current = false;
        const sceneKeys = [...new Set(targets.map((s) => s.sceneKey).filter(Boolean))];
        setBatch({ label: "视频", done: 0, total: targets.length, current: "场景准备" });
        for (const sceneKey of sceneKeys) {
            if (batchStopRef.current) break;
            await ensureSceneReady(sceneKey);
        }
        let ok = 0;
        let fail = 0;
        let stopped = false;
        for (let i = 0; i < targets.length; i++) {
            if (batchStopRef.current) { stopped = true; break; }
            setBatch({ label: "视频", done: i, total: targets.length, current: targets[i].id });
            if (await generateSegmentVideo(targets[i].id)) ok++; else fail++;
        }
        setBatch(null);
        if (stopped) message.info(`已停止（完成 ${ok} 段视频）`);
        else if (fail) message.warning(`批量完成：成功 ${ok} 段，失败 ${fail} 段`);
        else message.success(`全部段视频已生成（${ok} 段）`);
    }, [ensureSceneReady, generateSegmentVideo, message]);

    const stopBatch = useCallback(() => {
        batchStopRef.current = true;
        for (const key of generating.keys()) cancelGen(key);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [generating]);

    // ---------- 重写单段表演提示词 ----------
    const regeneratePrompt = useCallback(async (segId: string) => {
        const doc = canvasRef.current;
        if (!doc || !config?.textModel) return;
        const seg = parseDigitalHumanCanvas(doc).segments.find((s) => s.id === segId);
        if (!seg) return;
        const channelId = config.textModel.includes("::") ? config.textModel.split("::")[0] : "";
        const modelName = config.textModel.includes("::") ? config.textModel.split("::")[1] : config.textModel;
        const channel = (globalConfig.channels ?? []).find((c) => c.id === channelId);
        if (!channel) { message.error("拆分渠道不可用，请在画布 config 里检查 textModel"); return; }
        const key = `prompt:${segId}`;
        setGen(key, "pending");
        try {
            const videoPrompt = await fillSegmentVideoPrompt({
                config: { ...channel, apiFormat: channel.apiFormat ?? "openai" } as never,
                model: modelName,
                line: seg.line,
                expression: seg.expression,
                action: seg.action,
                camera: seg.camera,
            });
            updateSegMeta(segId, { videoPrompt }, `prompt:${segId}`);
            await save();
            message.success(`${segId} 表演提示词已重写`);
        } catch (error) {
            message.error(`重写失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setGen(key, null);
        }
    }, [config?.textModel, globalConfig.channels, message, save, updateSegMeta]);

    // ---------- 成片 ----------
    const confirmComposeReadiness = useCallback(async (): Promise<boolean> => {
        if (!segments.length) return false;
        const missing: string[] = [];
        const stale: string[] = [];
        for (const s of segments) {
            if (!s.videoStorageKey || !s.videoResourceId) missing.push(s.id);
            else if (segmentVideoStale(s)) stale.push(s.id);
        }
        if (!missing.length && !stale.length) return true;
        const issues: string[] = [];
        if (missing.length) issues.push(`${missing.length} 段视频未生成：${missing.slice(0, 8).join("、")}${missing.length > 8 ? " 等" : ""}`);
        if (stale.length) issues.push(`${stale.length} 段台词已改、视频过期（成片将不含这些段的最新台词）：${stale.slice(0, 8).join("、")}${stale.length > 8 ? " 等" : ""}`);
        return await new Promise<boolean>((resolve) => {
            modal.confirm({
                title: "合成成片前有未完成项",
                content: (<div style={{ display: "flex", flexDirection: "column", gap: 4 }}>{issues.map((s) => <div key={s}>· {s}</div>)}</div>),
                okText: "仍要合成",
                cancelText: "先去补齐",
                onOk: () => resolve(true),
                onCancel: () => resolve(false),
            });
        });
    }, [modal, segments]);

    const compose = useCallback(async () => {
        if (!config || !id) return;
        if (!(await confirmComposeReadiness())) return;
        setComposing({ percent: 0 });
        try {
            const composeSegments: ComposeSegment[] = segments.map((s) => ({
                id: s.id,
                line: s.line,
                resourceId: s.videoResourceId ?? "",
                durationMs: s.videoDurationMs ?? (s.audio ? segmentSecondsFor(s.audio.durationMs) * 1000 + 170 : estimateSegmentSeconds(s.line) * 1000),
                speechMs: s.audio?.speechMs ?? (s.audio?.durationMs ?? 0),
            })).filter((s) => s.resourceId);
            if (!composeSegments.length) { message.error("没有可合成的段视频"); return; }
            const result = await composeEpisodeVideo({
                projectId: id,
                segments: composeSegments,
                aspect,
                onTaskUpdate: (t) => setComposing({ percent: Math.round(((t as { progress?: number }).progress ?? 0) * 100) }),
            });
            setComposeResult(result);
            setRightTab("export");
            message.success("成片已合成");
        } catch (error) {
            message.error(`合成失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setComposing(null);
        }
    }, [aspect, config, confirmComposeReadiness, id, message, segments]);

    // ---------- 素材选择/上传（场景图/站位首帧/本段参考图/本段配音） ----------
    /** 选择器统一入口：按 target 把选中素材挂到对应位置 */
    const handleAssetPick = useCallback(async (pick: AssetPick) => {
        if (!picker || !id) return;
        const { target, key } = picker;
        try {
            if (target === "sceneImage") {
                const rid = pick.storageKey.replace(/^resource:/, "");
                await writeBackMedia(`scene-${key}`, { resourceId: rid, url: resourceFileUrl(rid) }, "image", `场景图 · ${pick.name}`, {});
                message.success("场景图已替换");
            } else if (target === "sceneFrame") {
                const latest = canvasRef.current;
                if (!latest) return;
                const next = withNodeMeta(latest, `scene-${key}`, (md) => ({ ...md, frameStorageKey: pick.storageKey }));
                suppressHistoryRef.current = true;
                setCanvas(next);
                canvasRef.current = next;
                await save(next);
                message.success("站位首帧已替换");
            } else if (target === "segRef") {
                const latest = canvasRef.current;
                if (!latest) return;
                const existing = parseDigitalHumanCanvas(latest).segments.find((s) => s.id === key)?.extraRefs ?? [];
                const next = withNodeMeta(latest, `seg-${key}`, (md) => ({ ...md, extraRefs: [...existing, { storageKey: pick.storageKey, name: pick.name }] }));
                suppressHistoryRef.current = true;
                setCanvas(next);
                canvasRef.current = next;
                await save(next);
                message.success("参考图已添加");
            } else if (target === "segAudio") {
                const latest = canvasRef.current;
                if (!latest || !persona) return;
                const seg = parseDigitalHumanCanvas(latest).segments.find((s) => s.id === key);
                if (!seg) return;
                const rid = pick.storageKey.replace(/^resource:/, "");
                // 音频时长探测 + 不足段时长时补尾静音为新资源（防 lock_source 电流声）
                const audioRes = await fetch(`/api/resources/${rid}/file`);
                const blob = await audioRes.blob();
                const speechMs = (await probeMediaDurationMs(new File([blob], pick.name, { type: blob.type }))) ?? 0;
                const seconds = segmentSecondsFor(speechMs);
                let finalKey = pick.storageKey;
                let durationMs = Math.round(speechMs);
                const padded = await padWavTailBlob(blob, seconds * 1000 + 700);
                if (padded.durationMs > durationMs) {
                    const uploaded = await uploadResourceFile(padded.blob, "audio", { fileName: `pad-${pick.name}`, durationMs: Math.round(padded.durationMs) });
                    finalKey = resourceStorageKey(uploaded.id);
                    durationMs = Math.round(padded.durationMs);
                }
                const next = withNodeMeta(latest, `seg-${key}`, (md) => ({
                    ...md,
                    audio: {
                        storageKey: finalKey,
                        url: `/api/resources/${finalKey.replace(/^resource:/, "")}/file`,
                        durationMs,
                        speechMs: Math.round(speechMs),
                        textHash: storybookLineHash(seg.line, persona.voice),
                        voice: persona.voice,
                    },
                    videoLineHash: "",
                }));
                suppressHistoryRef.current = true;
                setCanvas(next);
                canvasRef.current = next;
                await save(next);
                message.success(`${key} 配音已替换（重摇视频后生效）`);
            }
        } catch (error) {
            message.error(`素材挂载失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }, [id, message, persona, picker, save, writeBackMedia]);

    /** 替换场景图（顶层媒体，走 generated-assets 通道） */
    const removeSegRef = useCallback(async (segId: string, storageKey: string) => {
        if (busy) return;
        const existing = canvasRef.current
            ? (parseDigitalHumanCanvas(canvasRef.current).segments.find((s) => s.id === segId)?.extraRefs ?? [])
            : [];
        const next = withNodeMeta(canvasRef.current!, `seg-${segId}`, (md) => ({ ...md, extraRefs: existing.filter((r) => r.storageKey !== storageKey) }));
        suppressHistoryRef.current = true;
        setCanvas(next);
        canvasRef.current = next;
        await save(next);
    }, [busy, save]);

    // ---------- 试听/预览 ----------
    const playAudio = useCallback(async (storageKey: string) => {
        audioRef.current?.pause();
        try {
            const rid = storageKey.replace(/^resource:/, "");
            const audio = new Audio(`/api/resources/${rid}/file`);
            audioRef.current = audio;
            await audio.play();
        } catch {
            message.warning("浏览器阻止了自动播放，请再点一次");
        }
    }, [message]);

    // ---------- 键盘 / 离开防护 ----------
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!segments.length) return;
            const target = e.target instanceof HTMLElement ? e.target : null;
            const inEditor = !!target?.closest("input, textarea, select, [contenteditable='true']");
            if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "z" || e.key === "Z")) {
                if (inEditor) return;
                e.preventDefault();
                if (e.shiftKey) redo(); else undo();
                return;
            }
            if (e.key === "ArrowLeft" && !inEditor) { setSegIndex((i) => Math.max(0, i - 1)); }
            if (e.key === "ArrowRight" && !inEditor) { setSegIndex((i) => Math.min(segments.length - 1, i + 1)); }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [redo, segments.length, undo]);
    useEffect(() => {
        const onBeforeUnload = (e: BeforeUnloadEvent) => {
            if (dirty || busy) e.preventDefault();
        };
        window.addEventListener("beforeunload", onBeforeUnload);
        return () => window.removeEventListener("beforeunload", onBeforeUnload);
    }, [busy, dirty]);

    const goBack = () => {
        if (dirty || busy) {
            modal.confirm({
                title: "离开生产页？",
                content: "有未保存的编辑或进行中的生成，离开将丢失页面内状态（已提交的任务不受影响）。",
                okText: "离开",
                cancelText: "留下",
                onOk: () => navigate("/digital-human-books"),
            });
            return;
        }
        navigate("/digital-human-books");
    };

    // ---------- 渲染 ----------
    if (loading) {
        return <div style={{ padding: 40, opacity: 0.6 }}>正在加载口播画布…</div>;
    }
    if (loadError || !config) {
        return (
            <div style={{ padding: 40 }}>
                <Alert type="error" showIcon message={loadError ?? "这个画布不是数字人口播册（缺少 digitalhuman-config 节点）"} />
                <Button style={{ marginTop: 12 }} icon={<ArrowLeftOutlined />} onClick={() => navigate("/digital-human-books")}>返回列表</Button>
            </div>
        );
    }

    const sceneOptions = [...scenes.values()].map((s) => ({ value: s.key, label: s.key === current?.sceneKey ? `${s.name}（当前）` : s.name }));
    const currentScene = current ? (scenes.get(current.sceneKey) ?? [...scenes.values()][0]) : undefined;
    const videoUrl = current?.videoResourceId ? `/api/resources/${current.videoResourceId}/file` : null;
    const frameUrl = currentScene?.frameStorageKey ? `/api/resources/${currentScene.frameStorageKey.replace(/^resource:/, "")}/file` : null;
    const audioIsStale = current ? segmentAudioStale(current.audio, current.line, persona?.voice) : false;
    const videoIsStale = current ? segmentVideoStale(current) : false;

    const genButton = (key: string, runningText: string) => {
        const tid = generating.get(key);
        if (!tid) return null;
        return (
            <Space size={4}>
                <Tag color="processing">{runningText}</Tag>
                <Button size="small" icon={<StopOutlined />} onClick={() => cancelGen(key)}>取消</Button>
            </Space>
        );
    };

    return (
        <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
            {/* 顶栏 */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 16px", borderBottom: "1px solid var(--user-border, var(--border))", flexWrap: "wrap" }}>
                <Button icon={<ArrowLeftOutlined />} onClick={goBack} />
                <span style={{ fontWeight: 700, fontSize: 16 }}>{config.title}</span>
                <Tag>{persona?.name ?? "未绑定数字人"}</Tag>
                <Tag>{geo.label}</Tag>
                <Tag color={audioReady >= segments.length ? "green" : "orange"}><AudioOutlined /> 配音 {audioReady}/{segments.length}</Tag>
                <Tag color={videoReady >= segments.length ? "green" : "orange"}><VideoCameraOutlined /> 视频 {videoReady}/{segments.length}</Tag>
                <div style={{ flex: 1 }} />
                <Tooltip title="撤销 (Ctrl+Z)"><Button icon={<UndoOutlined />} disabled={historyRef.current.ptr <= 0 || busy} onClick={undo} /></Tooltip>
                <Tooltip title="重做 (Ctrl+Shift+Z)"><Button icon={<RedoOutlined />} disabled={historyRef.current.ptr + 1 >= historyRef.current.stack.length || busy} onClick={redo} /></Tooltip>
                <Button icon={<AudioOutlined />} loading={batch?.label === "配音"} disabled={busy} onClick={() => void batchGenerateAudio()}>生成缺音频</Button>
                <Button type="primary" icon={<ThunderboltOutlined />} loading={batch?.label === "视频"} disabled={busy} onClick={() => void batchGenerateVideos()}>生成缺视频</Button>
                <Button icon={<PlayCircleOutlined />} loading={!!composing} disabled={busy} onClick={() => void compose()}>{composeResult ? "重新合成成片" : "合成成片"}</Button>
                <Button icon={<SaveOutlined />} loading={saving} disabled={!dirty || busy} onClick={() => void save()}>保存{dirty ? "•" : ""}</Button>
                {batch ? (
                    <div style={{ minWidth: 220 }}>
                        <Progress percent={Math.round((batch.done / Math.max(1, batch.total)) * 100)} size="small" />
                        <div style={{ fontSize: 12, opacity: 0.7 }}>{batch.label} {batch.done}/{batch.total} · 当前 {batch.current}</div>
                    </div>
                ) : null}
                {composing ? (
                    <div style={{ minWidth: 180 }}>
                        <Progress percent={composing.percent} size="small" status="active" />
                        <div style={{ fontSize: 12, opacity: 0.7 }}>服务端拼接 + 烧字幕…</div>
                    </div>
                ) : null}
                {batch || composing ? <Button icon={<StopOutlined />} onClick={stopBatch}>停止</Button> : null}
            </div>

            <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
                {/* 左：段导航 */}
                <div style={{ width: 190, borderRight: "1px solid var(--user-border, var(--border))", overflowY: "auto", padding: 8 }}>
                    {segments.map((seg, i) => {
                        const staleA = segmentAudioStale(seg.audio, seg.line, persona?.voice);
                        const staleV = segmentVideoStale(seg);
                        return (
                            <button
                                key={seg.id}
                                type="button"
                                onClick={() => setSegIndex(i)}
                                aria-pressed={i === segIndex}
                                style={{
                                    display: "block", width: "100%", textAlign: "left", padding: "7px 9px", marginBottom: 4, borderRadius: 8, cursor: "pointer",
                                    border: i === segIndex ? "1px solid var(--ant-color-primary, #4f7cff)" : "1px solid transparent",
                                    background: i === segIndex ? "var(--user-fill, rgba(128,128,128,.12))" : "transparent",
                                }}
                            >
                                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                                    <span style={{ opacity: 0.6 }}>{seg.id}</span>
                                    <span>{!staleA ? <AudioOutlined style={{ color: "#52c41a" }} /> : <AudioOutlined style={{ opacity: 0.3 }} />}</span>
                                    <span>{!staleV ? <VideoCameraOutlined style={{ color: "#52c41a" }} /> : <VideoCameraOutlined style={{ opacity: 0.3 }} />}</span>
                                    <span style={{ marginLeft: "auto", opacity: 0.5 }}>~{seg.secondsHint}s</span>
                                </div>
                                <div style={{ fontSize: 12, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.8 }}>{seg.line || "（空）"}</div>
                            </button>
                        );
                    })}
                </div>

                {/* 中：预览 + 单段二次编辑（重摇/抽卡/切换候选） */}
                <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 16, overflow: "auto" }}>
                    <div style={{ aspectRatio: `${geo.width} / ${geo.height}`, width: "min(100%, 400px)", maxHeight: "52vh", borderRadius: 12, overflow: "hidden", border: "1px solid var(--user-border, var(--border))", background: "#000", display: "grid", placeItems: "center" }}>
                        {videoUrl ? (
                            <video key={videoUrl} src={videoUrl} controls style={{ width: "100%", height: "100%" }} />
                        ) : frameUrl ? (
                            <img src={frameUrl} alt="站位首帧" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                        ) : (
                            <div style={{ color: "#888", fontSize: 13, textAlign: "center", padding: 20 }}>
                                <PictureOutlined style={{ fontSize: 30, display: "block", marginBottom: 8, opacity: 0.5 }} />
                                {current ? `${current.id} 待生成` : ""}
                            </div>
                        )}
                    </div>
                    {videoUrl && videoIsStale ? <Alert type="warning" showIcon message="台词已改，这段视频过期——点「用新台词重摇」重新生成" /> : null}
                    {current ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center", width: "min(100%, 420px)" }}>
                            <div style={{ fontSize: 12, opacity: 0.7 }} className="tabular-nums">
                                {current.id}
                                {current.audio ? ` · 配音 ${(current.audio.durationMs / 1000).toFixed(1)}s` : ""}
                                {current.videoDurationMs ? ` · 视频 ${(current.videoDurationMs / 1000).toFixed(1)}s` : ""}
                                {` · 候选 ${(current.takes?.findIndex((t) => t.resourceId === current.videoResourceId) ?? -1) + 1 || 1}/${current.takes?.length ?? (current.videoResourceId ? 1 : 0)}`}
                            </div>
                            {(current.takes?.length ?? 0) > 1 ? (
                                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }} role="listbox" aria-label="候选视频">
                                    {(current.takes ?? []).map((t, ti) => (
                                        <span
                                            key={t.resourceId}
                                            role="option"
                                            aria-selected={t.resourceId === current.videoResourceId}
                                            onClick={() => t.resourceId !== current.videoResourceId && void switchTake(current.id, t.resourceId)}
                                            style={{ position: "relative", width: 58, height: 100, borderRadius: 8, overflow: "hidden", cursor: "pointer", border: t.resourceId === current.videoResourceId ? "2px solid var(--ant-color-primary, #4f7cff)" : "1px solid var(--user-border, var(--border))" }}
                                        >
                                            <video src={`/api/resources/${t.resourceId}/file#t=0.6`} muted preload="metadata" style={{ width: "100%", height: "100%", objectFit: "cover", pointerEvents: "none" }} />
                                            <span style={{ position: "absolute", left: 0, right: 0, bottom: 0, fontSize: 10, textAlign: "center", background: "rgba(0,0,0,.55)", color: "#fff" }}>#{ti + 1}</span>
                                            {t.resourceId !== current.videoResourceId ? (
                                                <button
                                                    type="button"
                                                    aria-label={`删除候选 ${ti + 1}`}
                                                    disabled={busy}
                                                    onClick={(e) => { e.stopPropagation(); void deleteTake(current.id, t.resourceId); }}
                                                    style={{ position: "absolute", top: 0, right: 0, border: "none", background: "rgba(0,0,0,.6)", color: "#fff", fontSize: 11, padding: "1px 5px", cursor: "pointer" }}
                                                >×</button>
                                            ) : null}
                                        </span>
                                    ))}
                                </div>
                            ) : null}
                            <Space wrap>
                                <Button type="primary" icon={<ThunderboltOutlined />} loading={generating.has(`video:${current.id}`)} disabled={busy} onClick={() => void generateSegmentVideo(current.id)}>
                                    {videoIsStale ? "用新台词重摇" : current.videoResourceId ? "重摇本段" : "生成本段视频"}
                                </Button>
                                <Button icon={<ReloadOutlined />} disabled={busy} onClick={() => void regenTakes(current.id, 2)}>再抽 2 张</Button>
                                {generating.has(`video:${current.id}`) ? <Button icon={<StopOutlined />} onClick={() => cancelGen(`video:${current.id}`)}>取消</Button> : null}
                            </Space>
                            <div style={{ fontSize: 11, opacity: 0.5, textAlign: "center" }}>
                                本段视频 = 站位首帧 + 人物稿{current.extraRefs?.length ? ` + 本段参考图×${current.extraRefs.length}` : ""} + 配音 → H3 口型渲染；改台词、换素材或重写表演后重摇即生效，抽卡候选随时切换。
                            </div>
                        </div>
                    ) : null}
                </div>

                {/* 右：编辑面板 */}
                <div style={{ width: 380, borderLeft: "1px solid var(--user-border, var(--border))", overflowY: "auto", padding: 12 }}>
                    <Segmented
                        block
                        value={rightTab}
                        onChange={(v) => setRightTab(v as RightTab)}
                        options={[
                            { value: "script", label: "台词与表演" },
                            { value: "audio", label: "音频" },
                            { value: "scene", label: "场景与数字人" },
                            { value: "export", label: "成片" },
                        ]}
                        style={{ marginBottom: 12 }}
                    />
                    {rightTab === "script" && current ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                            <div>
                                <div style={{ fontSize: 13, marginBottom: 4 }}>台词（改后配音/视频会标记过期）</div>
                                <Input.TextArea rows={3} value={current.line} onChange={(e) => updateSegMeta(current.id, { line: e.target.value }, `line:${current.id}`)} disabled={busy} />
                                <div style={{ fontSize: 12, opacity: 0.55, marginTop: 2 }}>约 {estimateSegmentSeconds(current.line)} 秒 · {current.line.replace(/\s/g, "").length} 字</div>
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                                <div>
                                    <div style={{ fontSize: 13, marginBottom: 4 }}>景别</div>
                                    <Select value={current.camera} onChange={(v) => updateSegMeta(current.id, { camera: v })} disabled={busy} style={{ width: "100%" }}
                                        options={["close-up", "medium close-up", "medium shot"].map((c) => ({ value: c, label: c }))} />
                                </div>
                                <div>
                                    <div style={{ fontSize: 13, marginBottom: 4 }}>场景</div>
                                    <Select value={current.sceneKey} onChange={(v) => updateSegMeta(current.id, { sceneKey: v })} disabled={busy} style={{ width: "100%" }} options={sceneOptions} />
                                </div>
                            </div>
                            <div>
                                <div style={{ fontSize: 13, marginBottom: 4 }}>表情</div>
                                <Input value={current.expression} onChange={(e) => updateSegMeta(current.id, { expression: e.target.value }, `expr:${current.id}`)} disabled={busy} />
                            </div>
                            <div>
                                <div style={{ fontSize: 13, marginBottom: 4 }}>动作（微动作）</div>
                                <Input value={current.action} onChange={(e) => updateSegMeta(current.id, { action: e.target.value }, `act:${current.id}`)} disabled={busy} />
                            </div>
                            <div>
                                <div style={{ fontSize: 13, marginBottom: 4 }}>视频提示词（身份/台词/音频绑定由系统拼装）</div>
                                <Input.TextArea rows={6} value={current.videoPrompt} onChange={(e) => updateSegMeta(current.id, { videoPrompt: e.target.value }, `vp:${current.id}`)} disabled={busy} />
                                <Button size="small" icon={<ReloadOutlined />} style={{ marginTop: 6 }} loading={generating.has(`prompt:${current.id}`)} disabled={busy} onClick={() => void regeneratePrompt(current.id)}>
                                    按表情/动作重写表演
                                </Button>
                            </div>
                            <div style={{ borderTop: "1px solid var(--user-border, var(--border))", paddingTop: 10 }}>
                                <div style={{ fontSize: 13, marginBottom: 6, fontWeight: 600 }}>本段素材（自定义）</div>
                                <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 6 }}>参考图（生成时排在人物稿之后，Picture 4+）</div>
                                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                                    {(current.extraRefs ?? []).map((r) => (
                                        <span key={r.storageKey} style={{ position: "relative", width: 56, height: 56, borderRadius: 8, overflow: "hidden", border: "1px solid var(--user-border, var(--border))" }}>
                                            <img src={`/api/resources/${r.storageKey.replace(/^resource:/, "")}/file`} alt={r.name} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                                            <button
                                                type="button"
                                                aria-label="移除参考图"
                                                disabled={busy}
                                                onClick={() => void removeSegRef(current.id, r.storageKey)}
                                                style={{ position: "absolute", top: 0, right: 0, border: "none", background: "rgba(0,0,0,.6)", color: "#fff", fontSize: 10, padding: "1px 4px", cursor: "pointer" }}
                                            >×</button>
                                        </span>
                                    ))}
                                    <button type="button" disabled={busy} onClick={() => setPicker({ target: "segRef", key: current.id })}
                                        style={{ width: 56, height: 56, borderRadius: 8, border: "1px dashed var(--user-border, var(--border))", background: "transparent", color: "var(--muted, #888)", cursor: "pointer", display: "grid", placeItems: "center" }}><PlusOutlined /></button>
                                </div>
                                <Button size="small" icon={<AudioOutlined />} disabled={busy} onClick={() => setPicker({ target: "segAudio", key: current.id })}>
                                    选择/上传本段配音（替换 TTS）
                                </Button>
                            </div>
                        </div>
                    ) : null}

                    {rightTab === "audio" && current ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                            <Alert type="info" showIcon message={<span>数字人音色：{persona?.voice}（{persona?.voiceModel?.split("::").pop() ?? "TTS"}）{persona?.voiceInstructions ? ` · ${persona.voiceInstructions}` : ""}</span>} />
                            {current.audio && !audioIsStale ? (
                                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                    <Space>
                                        <Button icon={<AudioOutlined />} onClick={() => current.audio && void playAudio(current.audio.storageKey)}>试听</Button>
                                        <Tag><CheckCircleOutlined /> 已配音 {(current.audio.durationMs / 1000).toFixed(1)}s（含尾静音）</Tag>
                                    </Space>
                                    <div style={{ fontSize: 12, opacity: 0.6 }}>说话 {((current.audio.speechMs ?? current.audio.durationMs) / 1000).toFixed(1)}s · 段视频时长 {segmentSecondsFor(current.audio.durationMs)}s</div>
                                </div>
                            ) : (
                                <Alert type={audioIsStale && current.audio ? "warning" : "info"} showIcon message={current.audio ? "台词或音色已变，配音过期" : "尚未配音"} />
                            )}
                            <Space>
                                <Button type="primary" icon={<AudioOutlined />} loading={generating.has(`audio:${current.id}`)} disabled={busy} onClick={() => void generateAudio(current.id)}>
                                    {current.audio ? "重新配音" : "生成配音"}
                                </Button>
                                {genButton(`audio:${current.id}`, "配音中")}
                            </Space>
                        </div>
                    ) : null}

                    {rightTab === "scene" ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                            <div>
                                <div style={{ fontSize: 13, marginBottom: 6, fontWeight: 600 }}>数字人（建册时快照绑定）</div>
                                <div style={{ display: "flex", gap: 10 }}>
                                    {persona?.portraitStorageKey ? (
                                        <img src={`/api/resources/${persona.portraitStorageKey.replace(/^resource:/, "")}/file`} alt={persona.name} style={{ width: 72, height: 96, objectFit: "cover", borderRadius: 8, border: "1px solid var(--user-border, var(--border))" }} />
                                    ) : null}
                                    <div style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 3 }}>
                                        <span style={{ fontSize: 13, fontWeight: 600 }}>{persona?.name}</span>
                                        <span style={{ opacity: 0.7 }}>音色 {persona?.voice}</span>
                                        <span style={{ opacity: 0.55 }}>{persona?.appearanceEn}</span>
                                    </div>
                                </div>
                                <Select
                                    style={{ width: "100%", marginTop: 8 }}
                                    value={persona?.canvasId}
                                    disabled={busy}
                                    placeholder="重新绑定数字人（会重置所有站位首帧）"
                                    onChange={(canvasId) => {
                                        const next = personas.find((p) => p.canvasId === canvasId);
                                        if (!next || !next.ready) return;
                                        modal.confirm({
                                            title: `重新绑定为「${next.name}」？`,
                                            content: "人物参考图与音色切换为新数字人；所有场景的站位首帧会重置（新人物需要重新生成）。",
                                            okText: "绑定",
                                            cancelText: "取消",
                                            onOk: () => {
                                                const { ready: _r, ...snapshot } = next;
                                                updateConfig((cfg) => { cfg.persona = snapshot; });
                                                // 站位首帧重置：旧帧里是旧人物
                                                setCanvas((prev) => {
                                                    if (!prev) return prev;
                                                    return { ...prev, nodes: prev.nodes.map((node) => (node.id.startsWith("scene-") ? { ...node, metadata: { ...(node.metadata ?? {}), frameStorageKey: "" } } : node)) };
                                                });
                                                setDirty(true);
                                            },
                                        });
                                    }}
                                    options={personas.filter((p) => p.ready).map((p) => ({ value: p.canvasId, label: `${p.name}（${p.voice}）` }))}
                                />
                            </div>
                            <div>
                                <div style={{ fontSize: 13, marginBottom: 6, fontWeight: 600 }}>场景（场景图 → 站位首帧，跨段复用）</div>
                                {[...scenes.values()].map((scene) => (
                                    <div key={scene.key} style={{ border: "1px solid var(--user-border, var(--border))", borderRadius: 10, padding: 10, marginBottom: 8 }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                                            <span style={{ fontWeight: 600 }}>{scene.name}</span>
                                            <Tag style={{ marginLeft: "auto" }}>{scene.key}</Tag>
                                        </div>
                                        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                                            <div style={{ flex: 1 }}>
                                                <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 2 }}>场景图</div>
                                                {scene.imageStorageKey
                                                    ? <img src={`/api/resources/${scene.imageStorageKey.replace(/^resource:/, "")}/file`} alt={scene.name} style={{ width: "100%", aspectRatio: `${geo.width} / ${geo.height}`, objectFit: "cover", borderRadius: 6 }} />
                                                    : <div style={{ fontSize: 12, opacity: 0.5 }}>未生成</div>}
                                            </div>
                                            <div style={{ flex: 1 }}>
                                                <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 2 }}>站位首帧</div>
                                                {scene.frameStorageKey
                                                    ? <img src={`/api/resources/${scene.frameStorageKey.replace(/^resource:/, "")}/file`} alt={`${scene.name} 首帧`} style={{ width: "100%", aspectRatio: `${geo.width} / ${geo.height}`, objectFit: "cover", borderRadius: 6 }} />
                                                    : <div style={{ fontSize: 12, opacity: 0.5 }}>未生成</div>}
                                            </div>
                                        </div>
                                        <Input.TextArea rows={2} value={scene.promptEn} onChange={(e) => updateSceneMeta(scene.key, { promptEn: e.target.value })} disabled={busy} placeholder="英文场景描述（无人物）" style={{ marginBottom: 8 }} />
                                        <Space size={6}>
                                            <Tooltip title="从提示词参考库按中文搜场景描述，选中后替换本场景提示词">
                                                <Button size="small" disabled={busy} onClick={() => setSceneLibraryKey(scene.key)}>参考库</Button>
                                            </Tooltip>
                                            <Button size="small" icon={<PictureOutlined />} loading={generating.has(`scene:${scene.key}`)} disabled={busy} onClick={() => void generateSceneImage(scene.key)}>
                                                {scene.imageStorageKey ? "重摇场景图" : "生成场景图"}
                                            </Button>
                                            <Button size="small" icon={<CloudUploadOutlined />} loading={generating.has(`frame:${scene.key}`)} disabled={busy || !scene.imageStorageKey} onClick={() => void generatePlacementFrame(scene.key)}>
                                                {scene.frameStorageKey ? "重摇首帧" : "生成站位首帧"}
                                            </Button>
                                            <Button size="small" icon={<PlusOutlined />} disabled={busy} onClick={() => setPicker({ target: "sceneImage", key: scene.key })}>选择场景图</Button>
                                            <Button size="small" icon={<PlusOutlined />} disabled={busy} onClick={() => setPicker({ target: "sceneFrame", key: scene.key })}>选择站位首帧</Button>
                                            {generating.has(`scene:${scene.key}`) ? <Button size="small" icon={<StopOutlined />} onClick={() => cancelGen(`scene:${scene.key}`)} /> : null}
                                            {generating.has(`frame:${scene.key}`) ? <Button size="small" icon={<StopOutlined />} onClick={() => cancelGen(`frame:${scene.key}`)} /> : null}
                                        </Space>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ) : null}

                    {rightTab === "export" ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                            <Alert type="info" showIcon message={<span>服务端合成：全部段视频顺序拼接 + 逐段台词烧录字幕（{geo.width}×{geo.height} · 24fps）</span>} />
                            <Button type="primary" icon={<ScissorOutlined />} loading={!!composing} disabled={busy} onClick={() => void compose()}>
                                {composeResult ? "重新合成" : "合成成片"}
                            </Button>
                            {composeResult ? (
                                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                    <video src={resourceFileUrl(composeResult.resourceId)} controls style={{ width: "100%", borderRadius: 10, border: "1px solid var(--user-border, var(--border))" }} />
                                    <Space wrap>
                                        <Button icon={<DownloadOutlined />} href={resourceFileUrl(composeResult.resourceId)} download={`${(config.title || "digital-human").replace(/[\\/:*?"<>|]/g, "_")}.mp4`}>下载 MP4</Button>
                                        {composeResult.subtitleSrt ? (
                                            <Button icon={<DownloadOutlined />} onClick={() => {
                                                const blob = new Blob([composeResult.subtitleSrt ?? ""], { type: "text/plain;charset=utf-8" });
                                                const url = URL.createObjectURL(blob);
                                                const a = document.createElement("a");
                                                a.href = url;
                                                a.download = `${(config.title || "digital-human").replace(/[\\/:*?"<>|]/g, "_")}.srt`;
                                                a.click();
                                                setTimeout(() => URL.revokeObjectURL(url), 30_000);
                                            }}>下载字幕 SRT</Button>
                                        ) : null}
                                        {composeResult.durationMs ? <Tag>时长 {(composeResult.durationMs / 1000).toFixed(1)}s</Tag> : null}
                                    </Space>
                                </div>
                            ) : (
                                <div style={{ fontSize: 12, opacity: 0.6, display: "flex", gap: 6, alignItems: "center" }}>
                                    <ExclamationCircleOutlined /> 先把全部段视频生成完毕再合成；台词改过的段需要重摇视频，否则字幕与口型不一致。
                                </div>
                            )}
                        </div>
                    ) : null}
                </div>
            </div>
            <AssetPickerModal
                open={!!picker}
                kind={picker?.target === "segAudio" ? "audio" : "image"}
                title={picker?.target === "sceneImage" ? "选择场景图" : picker?.target === "sceneFrame" ? "选择站位首帧" : picker?.target === "segAudio" ? "选择本段配音" : "添加本段参考图"}
                projectId={id ?? ""}
                imageModel={config?.imageChannel ? `${config.imageChannel}::qwen-image-2.1` : undefined}
                genSize={`${geo.width}x${geo.height}`}
                onClose={() => setPicker(null)}
                onPick={(pick) => { void handleAssetPick(pick); }}
            />
            <CanvasPromptLibraryModal
                open={!!sceneLibraryKey}
                onClose={() => setSceneLibraryKey(null)}
                insertLabel="替换"
                onInsert={(promptText) => {
                    const sceneKey = sceneLibraryKey;
                    if (!sceneKey) return;
                    updateSceneMeta(sceneKey, { promptEn: promptText });
                    setDirty(true);
                }}
            />
        </div>
    );
}
