import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { App, Alert, Button, Collapse, Image, Input, Modal, Progress, Segmented, Select, Space, Tag, Tooltip } from "antd";
import { ArrowLeftOutlined, ArrowRightOutlined, AudioOutlined, CheckCircleOutlined, CloudUploadOutlined, CopyOutlined, DeleteOutlined, DownloadOutlined, EditOutlined, ExclamationCircleOutlined, ExpandAltOutlined, PictureOutlined, PlayCircleOutlined, PlusOutlined, RedoOutlined, ReloadOutlined, SaveOutlined, ScissorOutlined, SoundOutlined, StopOutlined, ThunderboltOutlined, UndoOutlined, UserSwitchOutlined, VideoCameraOutlined } from "@ant-design/icons";

import { http } from "@/services/api/request";
import { listGenerationTasks, waitForGenerationTask } from "@/services/api/task-center";
import { resourceFileUrl, resourceStorageKey, uploadResourceFile } from "@/services/api/resources";
import { createZip } from "@/lib/zip";
import { padWavTailBlob } from "@/lib/audio/wav-pad";
import { probeMediaDurationMs } from "@/lib/media-metadata";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { resolveModelRequestConfig, useConfigStore } from "@/stores/use-config-store";
import { storybookLineHash } from "@/services/storybook-audio";
import { saveChannelVoice, fetchChannelVoices, requestAudioGeneration } from "@/services/api/audio";
import {
    DIGITAL_HUMAN_ASPECTS,
    estimateSegmentSeconds,
    listDigitalHumanPersonas,
    parseDigitalHumanCanvas,
    personaPortraitPrompt,
    segmentAudioStale,
    segmentVideoStale,
    type DigitalHumanPersonaCard,
    type SegmentCard,
    type SegmentNodeInfo,
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
import { buildSegmentVideoPrompt, extractSegmentCards, fillSegmentVideoPrompt, imageGenMeta, syncLineIntoVideoPrompt, videoGenMeta } from "@/services/digital-human-split";
import type { TimelineRenderResult } from "@/services/api/timeline-tasks";
import { AssetPickerModal, type AssetPick } from "./asset-picker-modal";
import { MediaDraftBar, type MediaDraft } from "./media-draft-bar";
import { SegmentPipeline, type PipelineStep } from "./segment-pipeline";
import { VideoLightbox } from "./video-lightbox";
import { VoiceDesignPanel } from "./voice-design-panel";
import { applyEditOverlay, collectEditOverlay, withNodeMeta } from "./edit-overlay";
import { CardPreviewOverlay } from "./card-preview";
import { renderCardPng } from "@/lib/dh-cards";
import { CanvasPromptLibraryModal } from "@/components/canvas/canvas-prompt-library-modal";

// 数字人口播生产页：画布文档的专用视图（与绘本成书同模式）。
// 顶栏批量操作（串行可停）｜左段导航｜中预览（段视频/站位首帧）｜右 Segmented
// 台词·音频·场景·成片。链路：逐段 TTS（IndexTTS-2+尾静音）→ 场景图/站位首帧
// （qwen 车道）→ 段视频（h3 dub：首帧+人物稿+配音口型）→ 服务端拼接烧字幕。

type RightTab = "script" | "material" | "scene" | "export";

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
    /** 右栏宽度（可拖拽分隔条调整，本地记忆） */
    const [rightWidth, setRightWidth] = useState(() => {
        const saved = Number(localStorage.getItem("dh-right-width"));
        return Number.isFinite(saved) && saved >= 300 && saved <= 720 ? saved : 380;
    });
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    /** 进行中的生成键（audio:P01 / video:P01 / scene:S1 / frame:S1 / prompt:P01）→ taskId|pending */
    const [generating, setGenerating] = useState<Map<string, string>>(new Map());
    const cancelGenRef = useRef(new Set<string>());
    const batchStopRef = useRef(false);
    const [batch, setBatch] = useState<{ label: string; done: number; total: number; current: string; perItemMs?: number } | null>(null);
    const [composing, setComposing] = useState<{ percent: number } | null>(null);
    const [composeResult, setComposeResult] = useState<TimelineRenderResult | null>(null);
    const [personas, setPersonas] = useState<DigitalHumanPersonaCard[]>([]);
    /** 素材选择器：picker:{target} 确定要写入的位置 */
    const [picker, setPicker] = useState<null | { target: "sceneImage" | "sceneFrame" | "segRef" | "segAudio" | "cover"; key: string }>(null);
    const [sceneLibraryKey, setSceneLibraryKey] = useState<string | null>(null);
    /** 生成草稿：页面内所有提示词生成先进预览条，点「使用」才落画布 */
    const [draft, setDraft] = useState<MediaDraft | null>(null);
    const draftBlobRef = useRef<Blob | null>(null);
    const [voicePanelOpen, setVoicePanelOpen] = useState(false);
    const [portraitPrompt, setPortraitPrompt] = useState("");
    const [coverPrompt, setCoverPrompt] = useState("");
    const [exportingZip, setExportingZip] = useState(false);
    /** 视频全屏预览（src） */
    const [lightbox, setLightbox] = useState<string | null>(null);
    /** 新增场景弹窗草稿（null=关闭） */
    const [sceneDraft, setSceneDraft] = useState<null | { name: string; promptEn: string }>(null);
    /** 合成成片时各段视频指纹（resourceId 序列）；段视频增删/重摇后标记成片过期 */
    const composeFingerprintRef = useRef("");
    /** compose 延迟调用（批量完成回调需要跨 render 取最新闭包，compose 定义在批量函数之后） */
    const composeRef = useRef<() => void>(() => undefined);
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
    /** 编辑锁：批量/合成进行中才锁编辑；单段生成时仍可继续改台词/提示词（overlay 合并保证写回不冲突） */
    const editLocked = !!batch || !!composing;

    const audioReady = segments.filter((s) => s.audio?.storageKey).length;
    const videoReady = segments.filter((s) => !segmentVideoStale(s)).length;

    // 人物形象提示词预填（快照锚点+画风后缀），可改后重新生成预览
    useEffect(() => {
        if (persona && !portraitPrompt) setPortraitPrompt(personaPortraitPrompt({ appearanceEn: persona.appearanceEn, ...(persona.style ? { style: persona.style } : {}) }));
    }, [persona, portraitPrompt]);

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
                // revision 回写是纯保存反馈，不入撤销栈（否则撤销要先回退一份空快照）
                suppressHistoryRef.current = true;
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
    // ---------- 分镜结构编辑：插入/复制/删除段、新增/删除场景 ----------
    // overlay 保存只做字段合并、不增删节点；结构变更走「本地快照 + 服务端 fresh 重放」
    // （apply 重放节点增删，字段仍由 overlay 合并），与生成写回共用 409 重试保证一致。
    type CanvasNode = CanvasProject["nodes"][number];

    const saveStructural = useCallback(async (next: CanvasProject, apply: (nodes: CanvasProject["nodes"]) => CanvasProject["nodes"]) => {
        if (!id) return;
        const overlay = collectEditOverlay(next);
        setSaving(true);
        try {
            let lastRevision: number | undefined;
            for (let attempt = 0; attempt < 3 && lastRevision === undefined; attempt++) {
                const base = attempt === 0
                    ? next
                    : (await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`)).project;
                const nodes = apply(applyEditOverlay(base.nodes, overlay));
                try {
                    const res = await http.put<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(id)}`, { project: { ...base, nodes }, assets: [] });
                    lastRevision = res.project?.revision;
                } catch { /* revision 冲突，重拉重放 */ }
            }
            if (typeof lastRevision !== "number") throw new Error("连续冲突");
            const rev = lastRevision;
            // 同 save()：revision 回写不进撤销栈
            suppressHistoryRef.current = true;
            setCanvas((prev) => (prev ? { ...prev, revision: rev } : prev));
            setDirty(false);
        } catch (error) {
            message.error(`结构保存失败（刷新后以服务端为准）：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setSaving(false);
        }
    }, [id, message]);

    /** config 节点直改（updateConfig 是 setState 异步链，结构操作需要同步拿到 next 文档） */
    const withConfig = useCallback((doc: CanvasProject, mutate: (cfg: NonNullable<ReturnType<typeof parseDigitalHumanCanvas>["config"]>) => void): CanvasProject => ({
        ...doc,
        nodes: doc.nodes.map((node) => {
            if (node.id !== "digitalhuman-config") return node;
            const md = { ...(node.metadata ?? {}) } as Record<string, unknown>;
            try {
                const cfg = JSON.parse(String(md.content ?? "{}"));
                if (cfg?.kind === "digitalhuman-config") {
                    mutate(cfg);
                    md.content = JSON.stringify(cfg);
                }
            } catch { /* 配置损坏忽略 */ }
            return { ...node, metadata: md } as CanvasNode;
        }),
    }), []);

    /** 撤销/重做跨结构变更时对账：把 prev→next 的节点增删重放到服务端，否则刷新后结构回跳 */
    const reconcileStructure = useCallback((prev: CanvasProject | null, next: CanvasProject) => {
        if (!id || !prev) return;
        const prevIds = new Set(prev.nodes.map((n) => n.id));
        const added = next.nodes.filter((n) => !prevIds.has(n.id));
        const removedIds = prev.nodes.filter((n) => !next.nodes.some((x) => x.id === n.id)).map((n) => n.id);
        if (!added.length && !removedIds.length) return;
        void saveStructural(next, (nodes) => [
            ...nodes.filter((n) => !removedIds.includes(n.id)),
            ...added.filter((n) => !nodes.some((x) => x.id === n.id)),
        ]);
    }, [id, saveStructural]);

    const undo = useCallback(() => {
        const h = historyRef.current;
        if (h.ptr <= 0) return;
        h.ptr -= 1;
        const target = h.stack[h.ptr];
        const prev = canvasRef.current;
        suppressHistoryRef.current = true;
        setCanvas(target);
        reconcileStructure(prev, target);
        h.lastKey = "";
        setHistoryVersion((v) => v + 1);
        setDirty(true);
    }, [reconcileStructure]);
    const redo = useCallback(() => {
        const h = historyRef.current;
        if (h.ptr + 1 >= h.stack.length) return;
        h.ptr += 1;
        const target = h.stack[h.ptr];
        const prev = canvasRef.current;
        suppressHistoryRef.current = true;
        setCanvas(target);
        reconcileStructure(prev, target);
        h.lastKey = "";
        setHistoryVersion((v) => v + 1);
        setDirty(true);
    }, [reconcileStructure]);

    /** 在 afterIndex 后插入新段（给 template 则复制其分镜字段；不带音频/视频，生成链路自动补） */
    const insertSegment = useCallback(async (afterIndex: number, template?: SegmentNodeInfo) => {
        const doc = canvasRef.current;
        if (!doc || !config || editLocked) return;
        let num = 1 + segments.reduce((m, s) => Math.max(m, Number(s.id.replace(/^P/, "")) || 0), 0);
        let segId = `P${String(num).padStart(2, "0")}`;
        while (segments.some((s) => s.id === segId)) { num += 1; segId = `P${String(num).padStart(2, "0")}`; }
        const line = template?.line ?? "";
        const camera = template?.camera ?? "medium close-up";
        const sceneKey = template?.sceneKey ?? current?.sceneKey ?? [...scenes.values()][0]?.key ?? "S1";
        const performance = `The presenter talks to camera with a ${template?.expression || "lively, focused"} expression, ${template?.action || "subtle hand gestures emphasizing key words"}, then returns to rest.`;
        const videoPrompt = template?.videoPrompt || buildSegmentVideoPrompt({ line, camera }, performance, "the presenter");
        const now = new Date().toISOString();
        const node = {
            id: `seg-${segId}`,
            type: "video",
            title: `${segId}${line ? ` ${line.slice(0, 12)}` : ""}`,
            position: { x: 1200 + Math.floor(segments.length / 6) * 460, y: 100 + (segments.length % 6) * 460 },
            width: 396,
            height: 396,
            createdAt: now,
            updatedAt: now,
            metadata: videoGenMeta(`${config.videoChannel}::${config.videoModel}`, videoPrompt, `${geo.width}x${geo.height}`, {
                line,
                expression: template?.expression ?? "",
                action: template?.action ?? "",
                camera,
                sceneKey,
                secondsHint: estimateSegmentSeconds(line),
            }),
        } as unknown as CanvasNode;
        const next = withConfig({ ...doc, nodes: [...doc.nodes, node] }, (cfg) => {
            const order = [...(cfg.segmentOrder?.length ? cfg.segmentOrder : segments.map((s) => s.id))];
            order.splice(Math.min(order.length, afterIndex + 1), 0, segId);
            cfg.segmentOrder = order;
        });
        pendingKeyRef.current = "";
        setCanvas(next);
        canvasRef.current = next;
        setDirty(true);
        setSegIndex(Math.max(0, Math.min(afterIndex + 1, segments.length)));
        setRightTab("script");
        await saveStructural(next, (nodes) => (nodes.some((n) => n.id === node.id) ? nodes : [...nodes, node]));
    }, [config, current?.sceneKey, editLocked, geo, saveStructural, scenes, segments, withConfig]);

    /** 删除段（台词/配音/视频引用一并移除；已入库资源保留在资产库，Ctrl+Z 可撤销） */
    const deleteSegment = useCallback((segId: string) => {
        const doc = canvasRef.current;
        if (!doc || editLocked) return;
        const idx = segments.findIndex((s) => s.id === segId);
        if (idx < 0) return;
        const nodeId = `seg-${segId}`;
        modal.confirm({
            title: `删除段 ${segId}？`,
            content: "台词、配音与视频引用一并移除（已入库资源保留在资产库）；Ctrl+Z 可撤销。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                const latest = canvasRef.current;
                if (!latest) return;
                const next = withConfig({ ...latest, nodes: latest.nodes.filter((n) => n.id !== nodeId) }, (cfg) => {
                    cfg.segmentOrder = (cfg.segmentOrder ?? []).filter((x) => x !== segId);
                });
                pendingKeyRef.current = "";
                setCanvas(next);
                canvasRef.current = next;
                setDirty(true);
                setSegIndex((i) => (idx < i ? i - 1 : Math.min(i, Math.max(0, segments.length - 2))));
                await saveStructural(next, (nodes) => nodes.filter((n) => n.id !== nodeId));
            },
        });
    }, [editLocked, modal, saveStructural, segments, withConfig]);

    /** 新增场景（空节点 + 名称/英文提示词；场景图和站位首帧到「场景」Tab 生成） */
    const addScene = useCallback(async (name: string, promptEn: string) => {
        const doc = canvasRef.current;
        if (!doc || !config || editLocked || !promptEn.trim()) return;
        const sceneList = [...scenes.values()];
        let num = 1 + sceneList.reduce((m, s) => Math.max(m, Number(s.key.replace(/^S/, "")) || 0), 0);
        let key = `S${num}`;
        while (scenes.has(key)) { num += 1; key = `S${num}`; }
        const now = new Date().toISOString();
        const node = {
            id: `scene-${key}`,
            type: "image",
            title: `场景·${name}`,
            position: { x: 720, y: 100 + sceneList.length * 560 },
            width: 405,
            height: 540,
            createdAt: now,
            updatedAt: now,
            metadata: imageGenMeta(`${config.imageChannel}::qwen-image-2.1`, `${promptEn.trim()}, no people, no human figures, empty scene ready for a presenter`, `${geo.width}x${geo.height}`, {
                sceneKey: key,
                sceneName: name,
                promptEn: promptEn.trim(),
            }),
        } as unknown as CanvasNode;
        const next = { ...doc, nodes: [...doc.nodes, node] };
        pendingKeyRef.current = "";
        setCanvas(next);
        canvasRef.current = next;
        setDirty(true);
        await saveStructural(next, (nodes) => (nodes.some((n) => n.id === node.id) ? nodes : [...nodes, node]));
    }, [config, editLocked, geo, saveStructural, scenes]);

    /** 删除场景：引用它的段改挂到第一个剩余场景；至少保留一个场景 */
    const deleteScene = useCallback((sceneKey: string) => {
        const doc = canvasRef.current;
        if (!doc || editLocked) return;
        const remaining = [...scenes.values()].filter((s) => s.key !== sceneKey);
        if (!remaining.length) { message.warning("至少保留一个场景"); return; }
        const fallback = remaining[0].key;
        const usedBy = segments.filter((s) => s.sceneKey === sceneKey).map((s) => s.id);
        const nodeId = `scene-${sceneKey}`;
        modal.confirm({
            title: `删除场景 ${sceneKey}？`,
            content: `${usedBy.length ? `${usedBy.join("、")} 段将改用场景「${remaining[0].name}」；` : ""}场景图与站位首帧引用一并移除（已入库资源保留在资产库）。`,
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                const latest = canvasRef.current;
                if (!latest) return;
                const next = {
                    ...latest,
                    nodes: latest.nodes
                        .filter((n) => n.id !== nodeId)
                        .map((n) => {
                            if (n.type !== "video" || !n.id.startsWith("seg-")) return n;
                            const md = (n.metadata ?? {}) as Record<string, unknown>;
                            return md.sceneKey === sceneKey ? { ...n, metadata: { ...md, sceneKey: fallback } } : n;
                        }) as CanvasProject["nodes"],
                };
                pendingKeyRef.current = "";
                setCanvas(next);
                canvasRef.current = next;
                setDirty(true);
                await saveStructural(next, (nodes) => nodes.filter((n) => n.id !== nodeId));
            },
        });
    }, [editLocked, message, modal, saveStructural, scenes, segments]);

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

    /** 段落排序：交换 segmentOrder 相邻两项，选中态跟随移动的段 */
    const moveSegment = useCallback((index: number, dir: 1 | -1) => {
        const to = index + dir;
        if (to < 0 || to >= segments.length) return;
        updateConfig((cfg) => {
            const order = [...(cfg.segmentOrder?.length ? cfg.segmentOrder : segments.map((s) => s.id))];
            const idA = order[index];
            const idB = order[to];
            if (idA == null || idB == null) return;
            order[index] = idB;
            order[to] = idA;
            cfg.segmentOrder = order;
        });
        setSegIndex(to);
    }, [segments, updateConfig]);

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
        projectIdArg?: string,
    ) => {
        const projectId = projectIdArg ?? id;
        if (!projectId) return;
        const doc = canvasRef.current;
        if (!doc) return;
        const overlay = collectEditOverlay(doc);
        const rid = result.resourceId;
        for (let attempt = 0; attempt < 3; attempt++) {
            const fresh = await http.get<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(projectId)}`);
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
                const res = await http.put<{ project: CanvasProject }>(`/canvas-projects/${encodeURIComponent(projectId)}/generated-assets`, { project: { ...fresh.project, nodes }, assets: [asset] });
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

    // ---------- 页内工作室：提示词生成 → 草稿预览 → 使用/丢弃 ----------
    const voiceRequestConfig = useMemo(
        () => (persona?.voiceModel ? resolveModelRequestConfig(globalConfig, persona.voiceModel) : null),
        [globalConfig, persona?.voiceModel],
    );

    /** 渠道音色列表（/voices 实时拉取；中转未放行时回落为空，仅显示当前值） */
    const [channelVoices, setChannelVoices] = useState<string[] | null>(null);
    const [voicePreviewing, setVoicePreviewing] = useState<string | null>(null);
    useEffect(() => {
        if (!voiceRequestConfig) { setChannelVoices(null); return; }
        let cancelled = false;
        void fetchChannelVoices(voiceRequestConfig)
            .then((voices) => { if (!cancelled) setChannelVoices(voices); })
            .catch(() => { if (!cancelled) setChannelVoices([]); });
        return () => { cancelled = true; };
    }, [voiceRequestConfig]);

    /** 音色试听：示例句快速合成即播，不补静音、不落库、不动段落数据 */
    const previewVoice = useCallback(async (voice: string) => {
        if (!persona?.voiceModel || !voiceRequestConfig || !voice.trim()) return;
        setVoicePreviewing(voice);
        try {
            const sample = `大家好，我是${persona.name}。这是我的声音，往后就由我陪你看完这一期。`;
            const blob = await requestAudioGeneration(
                { ...voiceRequestConfig, audioVoice: voice.trim(), audioInstructions: persona.voiceInstructions ?? "", audioFormat: "wav" },
                sample,
                {},
            );
            audioRef.current?.pause();
            const typed = blob.type.startsWith("audio/") ? blob : new Blob([blob], { type: "audio/wav" });
            const url = URL.createObjectURL(typed);
            const audio = new Audio(url);
            audioRef.current = audio;
            audio.onended = () => URL.revokeObjectURL(url);
            await audio.play().catch(() => message.warning("浏览器阻止了自动播放，请再点一次"));
        } catch (error) {
            message.error(`音色试听失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setVoicePreviewing(null);
        }
    }, [message, persona, voiceRequestConfig]);

    /** 换绑本册音色：只影响之后的配音；现有配音按音色指纹标记过期 */
    const changePersonaVoice = useCallback(async (voice: string) => {
        if (!voice.trim() || voice.trim() === persona?.voice) return;
        updateConfig((cfg) => { cfg.persona.voice = voice.trim(); });
        setDirty(true);
        await save();
        message.success(`音色已切换为 ${voice.trim()}：现有配音标记过期，重新生成后生效`);
    }, [message, persona?.voice, save, updateConfig]);

    /** 场景图 → 草稿（不落画布） */
    const draftSceneImage = useCallback(async (sceneKey: string) => {
        const doc = canvasRef.current;
        if (!doc || !config) return;
        const scene = parseDigitalHumanCanvas(doc).scenes.get(sceneKey);
        if (!scene || !config.imageChannel) { message.error("场景或生图渠道缺失，请先在模型配置确认 qwen 渠道"); return; }
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
            setDraft({ id: crypto.randomUUID(), kind: "image", url: result.url, label: `场景 ${sceneKey} · 场景图`, detail: scene.promptEn.slice(0, 60), payload: { type: "sceneImage", sceneKey, resourceId: result.resourceId } });
        } catch (error) {
            if (!cancelGenRef.current.has(key)) message.error(`场景图生成失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setGen(key, null);
        }
    }, [aspect, config, id, message, persona?.style]);

    /** 站位首帧 → 草稿（把人物稿放进场景，参考顺序：场景第1、人物第2） */
    const draftPlacementFrame = useCallback(async (sceneKey: string) => {
        const doc = canvasRef.current;
        if (!doc || !config || !persona) return;
        const parsed = parseDigitalHumanCanvas(doc);
        const scene = parsed.scenes.get(sceneKey);
        if (!scene) return;
        if (!scene.imageStorageKey) { message.error("先生成或选择场景图，再造站位首帧"); return; }
        if (!persona.portraitStorageKey) { message.error("数字人缺人物参考图"); return; }
        const key = `frame:${sceneKey}`;
        cancelGenRef.current.delete(key);
        setGen(key, "pending");
        try {
            const { prompt, size } = placementFramePrompt(persona.style, aspect);
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
            setDraft({ id: crypto.randomUUID(), kind: "image", url: result.url, label: `场景 ${sceneKey} · 站位首帧`, detail: "人物放入场景（构图+身份合一）", payload: { type: "sceneFrame", sceneKey, resourceId: result.resourceId } });
        } catch (error) {
            if (!cancelGenRef.current.has(key)) message.error(`站位首帧生成失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setGen(key, null);
        }
    }, [aspect, config, id, message, persona]);

    /** 人物形象 → 草稿（使用后绑定本册数字人快照，并同步回写数字人档案画布） */
    const draftPortrait = useCallback(async () => {
        if (!config?.imageChannel || !portraitPrompt.trim()) { message.error("先填写人物形象提示词并配置生图渠道"); return; }
        const key = "portrait";
        setGen(key, "pending");
        try {
            const result = await runCanvasImageTask({
                projectId: id ?? "",
                model: `${config.imageChannel}::qwen-image-2.1`,
                prompt: portraitPrompt.trim(),
                size: "960x960",
                nodeId: `portrait-draft-${Date.now()}`,
            });
            setDraft({ id: crypto.randomUUID(), kind: "image", url: result.url, label: "人物形象 · 参考图", detail: portraitPrompt.slice(0, 60), payload: { type: "portrait", resourceId: result.resourceId } });
        } catch (error) {
            message.error(`人物形象生成失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setGen(key, null);
        }
    }, [config?.imageChannel, id, message, portraitPrompt]);

    /** 本段配音 → 草稿（TTS 已含尾静音；试听满意才写回） */
    const draftSegAudio = useCallback(async (segId: string) => {
        const doc = canvasRef.current;
        if (!doc || !persona) return;
        const seg = parseDigitalHumanCanvas(doc).segments.find((s) => s.id === segId);
        if (!seg) return;
        if (!seg.line.trim()) { message.warning("台词为空，先写台词"); return; }
        const ttsModel = persona.voiceModel || "";
        if (!ttsModel) { message.error("数字人档案缺配音模型"); return; }
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
            setDraft({
                id: crypto.randomUUID(),
                kind: "audio",
                url: audio.url,
                label: `${segId} · 配音（${persona.voice}）`,
                detail: `说话 ${(audio.speechMs / 1000).toFixed(1)}s · 含尾静音 ${(audio.durationMs / 1000).toFixed(1)}s`,
                payload: { type: "segAudio", segId, audio },
            });
        } catch (error) {
            if (!cancelGenRef.current.has(key)) message.error(`配音生成失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setGen(key, null);
        }
    }, [globalConfig, message, persona]);

    /** 草稿统一提交：按 payload 类型写回对应位置 */
    /** 封面 → 草稿（竖版海报构图，顶部留标题负空间） */
    const draftCover = useCallback(async () => {
        if (!config?.imageChannel || !coverPrompt.trim()) { message.error("先填写封面提示词并配置生图渠道"); return; }
        const key = "cover";
        setGen(key, "pending");
        try {
            const result = await runCanvasImageTask({
                projectId: id ?? "",
                model: `${config.imageChannel}::qwen-image-2.1`,
                prompt: coverPrompt.trim(),
                size: `${geo.width}x${geo.height}`,
                nodeId: `cover-draft-${Date.now()}`,
            });
            setDraft({ id: crypto.randomUUID(), kind: "image", url: result.url, label: "成片封面", detail: coverPrompt.slice(0, 60), payload: { type: "cover", resourceId: result.resourceId } });
        } catch (error) {
            message.error(`封面生成失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setGen(key, null);
        }
    }, [config?.imageChannel, coverPrompt, geo, id, message]);

    /** 发布包导出：MP4 + SRT + 封面 + 文案 打包 zip */
    const exportPublishPackage = useCallback(async () => {
        if (!config || !composeResult?.resourceId) { message.warning("先合成成片，再导出发布包"); return; }
        setExportingZip(true);
        try {
            const pub = config.publish ?? { title: config.title, description: "", tags: "" };
            const safe = (pub.title || "digital-human").replace(/[\\/:*?"<>|]/g, "_");
            const files: Array<{ name: string; data: BlobPart }> = [];
            const mp4 = await (await fetch(resourceFileUrl(composeResult.resourceId))).blob();
            files.push({ name: `${safe}.mp4`, data: mp4 });
            if (composeResult.subtitleSrt) files.push({ name: `${safe}.srt`, data: new Blob([composeResult.subtitleSrt], { type: "text/plain;charset=utf-8" }) });
            const coverKey = pub.coverStorageKey || ([...scenes.values()].find((s) => s.frameStorageKey)?.frameStorageKey ?? persona?.portraitStorageKey);
            if (coverKey) {
                const cover = await (await fetch(`/api/resources/${coverKey.replace(/^resource:/, "")}/file`)).blob();
                files.push({ name: `${safe}-封面.png`, data: cover });
            }
            const copy = [
                `【标题】${pub.title || config.title}`,
                "",
                `【简介】${pub.description || ""}`,
                "",
                `【标签】${pub.tags || ""}`,
                "",
                `【规格】竖屏 ${geo.width}×${geo.height} · ${segments.length} 段 · 时长 ${((composeResult.durationMs ?? 0) / 1000).toFixed(0)}s`,
                "【声明】本视频由 AI 生成",
            ].join("\n");
            files.push({ name: "发布文案.txt", data: new Blob([copy], { type: "text/plain;charset=utf-8" }) });
            const zip = await createZip(files);
            const url = URL.createObjectURL(zip);
            const a = document.createElement("a");
            a.href = url;
            a.download = `${safe}-发布包.zip`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 30_000);
            message.success(`发布包已导出（${files.length} 个文件）`);
        } catch (error) {
            message.error(`导出失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setExportingZip(false);
        }
    }, [composeResult, config, geo, message, persona?.portraitStorageKey, scenes, segments.length]);

    const commitDraft = useCallback(async () => {
        if (!draft) return;
        const p = draft.payload as { type: string } & Record<string, unknown>;
        try {
            if (p.type === "sceneImage" || p.type === "portrait") {
                const rid = String(p.resourceId);
                if (p.type === "sceneImage") {
                    await writeBackMedia(`scene-${String(p.sceneKey)}`, { resourceId: rid, url: resourceFileUrl(rid) }, "image", "场景图", {});
                    message.success("场景图已使用");
                } else {
                    // 人物形象：更新本册快照 + 回写数字人档案画布（跨期一致）
                    updateConfig((cfg) => { cfg.persona.portraitStorageKey = `resource:${rid}`; });
                    setDirty(true);
                    await save();
                    if (persona?.canvasId && persona.canvasId !== id) {
                        await writeBackMedia("portrait", { resourceId: rid, url: resourceFileUrl(rid) }, "image", "人物图", {}, persona.canvasId);
                    }
                    message.success("人物形象已使用（后续段视频按新形象生成）");
                }
            } else if (p.type === "sceneFrame") {
                const latest = canvasRef.current;
                if (!latest) return;
                const next = withNodeMeta(latest, `scene-${String(p.sceneKey)}`, (md) => ({ ...md, frameStorageKey: `resource:${String(p.resourceId)}` }));
                suppressHistoryRef.current = true;
                setCanvas(next);
                canvasRef.current = next;
                await save(next);
                message.success("站位首帧已使用");
            } else if (p.type === "cover") {
                updateConfig((cfg) => {
                    cfg.publish = { ...(cfg.publish ?? { title: cfg.title, description: "", tags: "" }), coverStorageKey: `resource:${String(p.resourceId)}` };
                });
                setDirty(true);
                await save();
                message.success("封面已使用");
            } else if (p.type === "segAudio") {
                const latest = canvasRef.current;
                if (!latest) return;
                const segId = String(p.segId);
                const seg = parseDigitalHumanCanvas(latest).segments.find((s) => s.id === segId);
                if (!seg) return;
                const audio = p.audio as NonNullable<typeof seg.audio>;
                const next = withNodeMeta(latest, `seg-${segId}`, (md) => ({ ...md, audio, videoLineHash: "" }));
                suppressHistoryRef.current = true;
                setCanvas(next);
                canvasRef.current = next;
                await save(next);
                message.success(`${segId} 配音已使用（重摇视频后生效）`);
            } else if (p.type === "voice") {
                const blob = draftBlobRef.current;
                if (!blob || !persona?.voiceModel || !voiceRequestConfig) { message.error("音色草稿失效，请重新设计"); return; }
                const voices = await saveChannelVoice(voiceRequestConfig, { name: String(p.name), wav: blob, text: String(p.text ?? "") });
                updateConfig((cfg) => { cfg.persona.voice = String(p.name); });
                setDirty(true);
                await save();
                draftBlobRef.current = null;
                message.success(`音色 ${String(p.name)} 已入库并绑定（现有配音将标记过期，重新生成后生效）`);
            }
            setDraft(null);
        } catch (error) {
            message.error(`使用失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }, [draft, id, message, persona, save, updateConfig, voiceRequestConfig, writeBackMedia]);

    // ---------- 批量（串行 + 可停；本机 GPU 单并发） ----------
    const batchGenerateAudio = useCallback(async () => {
        const doc = canvasRef.current;
        if (!doc) return;
        const targets = parseDigitalHumanCanvas(doc).segments.filter((s) => segmentAudioStale(s.audio, s.line, persona?.voice));
        if (!targets.length) { message.info("没有待配音的段"); return; }
        batchStopRef.current = false;
        setBatch({ label: "配音", done: 0, total: targets.length, current: targets[0].id, perItemMs: 30_000 });
        let ok = 0;
        let stopped = false;
        for (let i = 0; i < targets.length; i++) {
            if (batchStopRef.current) { stopped = true; break; }
            setBatch({ label: "配音", done: i, total: targets.length, current: targets[i].id, perItemMs: 30_000 });
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
        setBatch({ label: "视频", done: 0, total: targets.length, current: "场景准备", perItemMs: 15 * 60_000 });
        for (const sceneKey of sceneKeys) {
            if (batchStopRef.current) break;
            await ensureSceneReady(sceneKey);
        }
        let ok = 0;
        let fail = 0;
        let stopped = false;
        for (let i = 0; i < targets.length; i++) {
            if (batchStopRef.current) { stopped = true; break; }
            setBatch({ label: "视频", done: i, total: targets.length, current: targets[i].id, perItemMs: 15 * 60_000 });
            if (await generateSegmentVideo(targets[i].id)) ok++; else fail++;
        }
        setBatch(null);
        if (stopped) message.info(`已停止（完成 ${ok} 段视频）`);
        else if (fail) message.warning(`批量完成：成功 ${ok} 段，失败 ${fail} 段`);
        else {
            message.success(`全部段视频已生成（${ok} 段）`);
            modal.confirm({
                title: "全部段视频已就绪",
                content: "是否立即合成成片？服务端顺序拼接全部段并烧录字幕。",
                okText: "立即合成",
                cancelText: "稍后再说",
                onOk: () => { composeRef.current(); },
            });
        }
    }, [ensureSceneReady, generateSegmentVideo, message, modal]);

    const stopBatch = useCallback(() => {
        batchStopRef.current = true;
        for (const key of generating.keys()) cancelGen(key);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [generating]);

    // ---------- 重写单段表演提示词 ----------
    const regeneratePrompt = useCallback(async (segId: string) => {
        const doc = canvasRef.current;
        if (!doc) return;
        const seg = parseDigitalHumanCanvas(doc).segments.find((s) => s.id === segId);
        if (!seg) return;
        // 无文本渠道（回档画布常见）：降级为程序化拼装——按当前表情/动作直接生成，不依赖 LLM
        if (!config?.textModel) {
            const videoPrompt = buildSegmentVideoPrompt(
                { line: seg.line, camera: seg.camera },
                `The presenter talks to camera with a ${seg.expression || "lively, focused"} expression, ${seg.action || "subtle hand gestures emphasizing key words"}, playful head tilts, then returns to rest.`,
                "the presenter",
            );
            updateSegMeta(segId, { videoPrompt }, `prompt:${segId}`);
            await save();
            message.success(`${segId} 表演提示词已按表情/动作重写（程序拼装，未用 LLM）`);
            return;
        }
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

    // ---------- 信息卡（讲到重点时浮出画面的文字卡） ----------
    const updateCards = useCallback((segId: string, next: SegmentCard[]) => {
        updateSegMeta(segId, { cards: next }, `cards:${segId}`);
    }, [updateSegMeta]);

    /** AI 从本段台词提取信息卡（复用拆书文本渠道） */
    const aiExtractCards = useCallback(async (seg: SegmentNodeInfo) => {
        if (!config?.textModel) { message.error("口播册缺少文本模型配置，无法 AI 提取；可手动添加信息卡"); return; }
        if (!seg.line.trim()) { message.warning("先写台词，AI 才能提炼重点"); return; }
        const channelId = config.textModel.includes("::") ? config.textModel.split("::")[0] : "";
        const modelName = config.textModel.includes("::") ? config.textModel.split("::")[1] : config.textModel;
        const channel = (globalConfig.channels ?? []).find((c) => c.id === channelId);
        if (!channel) { message.error("拆分渠道不可用，请在画布 config 里检查 textModel"); return; }
        const key = `cards:${seg.id}`;
        setGen(key, "pending");
        try {
            const extracted = await extractSegmentCards({ config: { ...channel, apiFormat: channel.apiFormat ?? "openai" } as never, model: modelName, line: seg.line });
            if (!extracted.length) { message.info("AI 没有从这段台词提炼出重点，可手动添加信息卡"); return; }
            const stamp = Date.now().toString(36);
            updateCards(seg.id, extracted.map((c, i) => ({ id: `c-${stamp}-${i}`, ...c })));
            await save();
            message.success(`已提取 ${extracted.length} 张信息卡，中栏播放本段可预览浮出效果`);
        } catch (error) {
            message.error(`AI 提取失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setGen(key, null);
        }
    }, [config?.textModel, globalConfig.channels, message, save, updateCards]);

    /** 附加行 <-> 文本互转（一行一条，行首 * 表示金色强调） */
    const cardLinesToText = useCallback((card: SegmentCard) => (card.lines ?? []).map((l) => (l.gold ? `*${l.text}` : l.text)).join("\n"), []);
    const textToCardLines = useCallback((text: string) => text.split("\n").map((t) => t.trim()).filter(Boolean).map((t) => (t.startsWith("*") ? { text: t.slice(1).trim(), gold: true } : { text: t })).filter((l) => l.text), []);

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
            const composeSegments: ComposeSegment[] = segments.map((s) => {
                const cards = (s.cards ?? []).filter((c) => c.title.trim() || c.highlight?.trim() || c.lines?.length);
                return {
                    id: s.id,
                    line: s.line,
                    resourceId: s.videoResourceId ?? "",
                    durationMs: s.videoDurationMs ?? (s.audio ? segmentSecondsFor(s.audio.durationMs) * 1000 + 170 : estimateSegmentSeconds(s.line) * 1000),
                    speechMs: s.audio?.speechMs ?? (s.audio?.durationMs ?? 0),
                    ...(cards.length ? { cards } : {}),
                };
            }).filter((s) => s.resourceId);
            if (!composeSegments.length) { message.error("没有可合成的段视频"); return; }
            // 信息卡 → 透明 PNG → 渲染叠加层；时间窗与字幕同源（按各段配音时长均分轮播）
            const overlays: Array<{ sourceId: string; startMs: number; durationMs: number; x: number; y: number; w: number; h: number }> = [];
            let overlayCursorMs = 0;
            let cardCount = 0;
            for (const s of composeSegments) {
                const segDuration = Math.max(500, Math.round(s.durationMs));
                if (s.cards?.length) {
                    const windowMs = Math.max(600, Math.round((s.speechMs || s.durationMs) / s.cards.length));
                    for (let i = 0; i < s.cards.length; i++) {
                        const { blob, box } = await renderCardPng(s.cards[i], geo);
                        const uploaded = await uploadResourceFile(blob, "image", { fileName: `card-${s.id}-${i + 1}.png` });
                        overlays.push({
                            sourceId: uploaded.id,
                            startMs: overlayCursorMs + 300 + i * windowMs,
                            durationMs: windowMs,
                            x: box.x,
                            y: box.y,
                            w: box.w / geo.width,
                            h: box.h / geo.height,
                        });
                        cardCount++;
                    }
                }
                overlayCursorMs += segDuration;
            }
            const result = await composeEpisodeVideo({
                projectId: id,
                segments: composeSegments,
                aspect,
                ...(overlays.length ? { overlays } : {}),
                onTaskUpdate: (t) => setComposing({ percent: Math.round(((t as { progress?: number }).progress ?? 0) * 100) }),
            });
            composeFingerprintRef.current = composeSegments.map((s) => s.resourceId).join("|");
            setComposeResult(result);
            setRightTab("export");
            message.success(overlays.length ? `成片已合成（含 ${cardCount} 张信息卡）` : "成片已合成");
        } catch (error) {
            message.error(`合成失败：${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setComposing(null);
        }
    }, [aspect, config, confirmComposeReadiness, id, message, segments]);
    composeRef.current = () => { void compose(); };

    // 自动保存：编辑静默 2.5s 后自动落库（生成写回有自己的保存链路，overlay 合并保证不冲突）
    useEffect(() => {
        if (!dirty || saving) return;
        const timer = setTimeout(() => { void save(); }, 2500);
        return () => clearTimeout(timer);
    }, [canvas, dirty, saving, save]);

    // 进行中任务恢复：刷新/重开页面后，后端仍在跑的段视频/场景图任务继续跟踪并写回
    const resumedRef = useRef(false);
    useEffect(() => {
        if (loading || resumedRef.current || !id) return;
        resumedRef.current = true;
        (async () => {
            try {
                const tasks = await listGenerationTasks(50, { projectId: id, activeOnly: true });
                let resumed = 0;
                for (const t of tasks) {
                    const nodeId = ((t.clientContext ?? {}) as { nodeId?: string }).nodeId ?? "";
                    if (t.type === "canvas_video" && nodeId.startsWith("seg-")) {
                        const segId = nodeId.slice(4);
                        const key = `video:${segId}`;
                        setGen(key, t.id);
                        resumed++;
                        void (async () => {
                            try {
                                const done = await waitForGenerationTask(t.id, { initialTask: t, intervalMs: 5000, timeoutMs: 45 * 60 * 1000 });
                                const video = JSON.parse(done.resultJson ?? "{}").video as { resourceId?: string; durationMs?: number } | undefined;
                                const rid = video?.resourceId;
                                if (!rid) throw new Error("任务未返回视频");
                                const doc = canvasRef.current;
                                const seg = doc ? parseDigitalHumanCanvas(doc).segments.find((s) => s.id === segId) : undefined;
                                if (!seg) throw new Error("段落已不存在");
                                const nextTakes = [...(seg.takes ?? []), { resourceId: rid, ...(video?.durationMs ? { durationMs: video.durationMs } : {}), lineHash: storybookLineHash(seg.line), createdAt: new Date().toISOString() }].slice(-8);
                                await writeBackMedia(`seg-${segId}`, { resourceId: rid, url: resourceFileUrl(rid) }, "video", `${segId} 口播段`, {
                                    videoResourceId: rid,
                                    videoLineHash: storybookLineHash(seg.line),
                                    ...(video?.durationMs ? { videoDurationMs: video.durationMs } : {}),
                                    takes: nextTakes,
                                });
                                message.success(`已恢复：${segId} 口播视频生成完成`);
                            } catch (error) {
                                message.error(`任务恢复失败（${segId}）：${error instanceof Error ? error.message : String(error)}`);
                            } finally {
                                setGen(key, null);
                            }
                        })();
                    } else if (t.type === "canvas_image" && nodeId.startsWith("scene-")) {
                        const sceneKey = nodeId.slice(6);
                        const key = `scene:${sceneKey}`;
                        setGen(key, t.id);
                        resumed++;
                        void (async () => {
                            try {
                                const done = await waitForGenerationTask(t.id, { initialTask: t, intervalMs: 4000, timeoutMs: 10 * 60 * 1000 });
                                const images = JSON.parse(done.resultJson ?? "{}").images as Array<{ resourceId?: string }> | undefined;
                                const rid = images?.[0]?.resourceId;
                                if (!rid) throw new Error("任务未返回图片");
                                await writeBackMedia(nodeId, { resourceId: rid, url: resourceFileUrl(rid) }, "image", "场景图", {});
                                message.success(`已恢复：场景 ${sceneKey} 图生成完成`);
                            } catch (error) {
                                message.error(`任务恢复失败（场景 ${sceneKey}）：${error instanceof Error ? error.message : String(error)}`);
                            } finally {
                                setGen(key, null);
                            }
                        })();
                    }
                }
                if (resumed > 0) message.info(`已恢复跟踪 ${resumed} 个进行中的生成任务`);
            } catch { /* 任务列表拉取失败静默 */ }
        })();
    }, [loading, id, message, writeBackMedia]);

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
            } else if (target === "cover") {
                const latest = canvasRef.current;
                if (!latest) return;
                updateConfig((cfg) => {
                    cfg.publish = { ...(cfg.publish ?? { title: cfg.title, description: "", tags: "" }), coverStorageKey: pick.storageKey };
                });
                setDirty(true);
                await save(latest);
                message.success("封面已设置");
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
    }, [id, message, persona, picker, save, updateConfig, writeBackMedia]);

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
    /** 成片过期：合成后段视频有增删/重摇，旧成片不包含最新内容 */
    const composeStale = !!composeResult && composeFingerprintRef.current !== segments.map((s) => s.videoResourceId ?? "").filter(Boolean).join("|");

    /** 本段镜头流水线：把画布里的节点连线翻译成"这个镜头需要什么、还缺什么" */
    const portraitMissing = !persona?.portraitStorageKey;
    const pipelineSteps: PipelineStep[] = !current ? [] : [
        {
            key: "line",
            label: "台词",
            icon: <EditOutlined />,
            status: current.line.trim() ? "done" : "todo",
            statusText: current.line.trim() ? `${current.line.replace(/\s/g, "").length} 字` : "未写",
            tooltip: "本段口播台词，是后面所有环节的上游；在下方「台词」里编辑。改台词后配音和视频会标记过期。",
        },
        {
            key: "audio",
            label: "配音",
            icon: <AudioOutlined />,
            status: audioIsStale ? (current.audio ? "stale" : "todo") : "done",
            statusText: !current.audio ? "未生成" : audioIsStale ? "已过期" : `${(current.audio.durationMs / 1000).toFixed(1)}s`,
            tooltip: audioIsStale
                ? `台词或音色已变。点此用数字人音色（${persona?.voice ?? ""}）重新合成——先进底部草稿条试听，满意再落库。`
                : `数字人音色 ${persona?.voice ?? ""} 朗读本段台词。点此试听。`,
            loading: generating.has(`audio:${current.id}`),
            onAction: () => {
                if (current.audio && !audioIsStale) void playAudio(current.audio.storageKey);
                else void draftSegAudio(current.id);
            },
        },
        {
            key: "sceneImage",
            label: "场景图",
            icon: <PictureOutlined />,
            status: currentScene?.imageStorageKey ? "done" : "todo",
            statusText: !currentScene ? "无场景" : currentScene.imageStorageKey ? currentScene.name : "未生成",
            tooltip: currentScene?.imageStorageKey
                ? `本段挂在场景「${currentScene.name}」的底图上（同一场景跨段复用）。点此到「场景与形象」看大图。`
                : "场景的英文描述先生成无人物底图（同一场景跨段复用）。点此生成，先进底部草稿条预览。",
            loading: !!currentScene && generating.has(`scene:${currentScene.key}`),
            onAction: () => {
                if (!currentScene || currentScene.imageStorageKey) { setRightTab("scene"); return; }
                void draftSceneImage(currentScene.key);
            },
        },
        {
            key: "frame",
            label: "站位首帧",
            icon: <UserSwitchOutlined />,
            status: !currentScene?.imageStorageKey || portraitMissing ? "blocked" : (currentScene.frameStorageKey ? "done" : "todo"),
            statusText: currentScene?.frameStorageKey ? "就绪" : !currentScene?.imageStorageKey ? "待场景图" : portraitMissing ? "缺人物稿" : "未生成",
            tooltip: !currentScene?.imageStorageKey
                ? "站位首帧 = 把数字人放进场景图的构图帧，是段视频的起幅。需要先有场景图——点此先把场景图生成出来。"
                : portraitMissing
                    ? "缺数字人人物稿（身份参考图）。点此到「场景与形象」生成人物形象。"
                    : currentScene.frameStorageKey
                        ? "数字人已放进场景，作为段视频的首尾帧。点此到「场景与形象」看大图。"
                        : "把数字人人物稿合成进场景图（场景第 1 参考、人物第 2 参考）。点此生成，先进底部草稿条预览。",
            loading: !!currentScene && generating.has(`frame:${currentScene.key}`),
            onAction: () => {
                if (!currentScene) { setRightTab("scene"); return; }
                if (!currentScene.imageStorageKey) { void draftSceneImage(currentScene.key); return; }
                if (portraitMissing || currentScene.frameStorageKey) { setRightTab("scene"); return; }
                void draftPlacementFrame(currentScene.key);
            },
        },
        {
            key: "video",
            label: "段视频",
            icon: <VideoCameraOutlined />,
            status: portraitMissing ? "blocked" : videoIsStale ? (current.videoResourceId ? "stale" : "todo") : "done",
            statusText: portraitMissing ? "缺人物稿" : !current.videoResourceId ? "未生成" : videoIsStale ? "已过期" : `${((current.videoDurationMs ?? 0) / 1000).toFixed(1)}s`,
            tooltip: portraitMissing
                ? "缺数字人人物稿。点此到「场景与形象」生成人物形象。"
                : videoIsStale
                    ? "点此生成本段口播视频——配音、场景图、站位首帧缺什么会自动补齐，然后 H3 按配音驱动口型。"
                    : "本段口播视频已就绪，中栏可预览；不满意可重摇或切换候选（抽卡）。",
            loading: generating.has(`video:${current.id}`),
            onAction: () => {
                if (portraitMissing) { setRightTab("scene"); return; }
                void generateSegmentVideo(current.id);
            },
        },
    ];

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
                {composeStale ? <Tooltip title="段视频有变化（重摇/增删/换候选），旧成片不含最新内容"><Tag color="orange">成片已过期</Tag></Tooltip> : null}
                <Button icon={<PlayCircleOutlined />} loading={!!composing} disabled={busy} onClick={() => void compose()}>{composeResult ? "重新合成成片" : "合成成片"}</Button>
                <Tooltip title={saving ? "正在保存…" : dirty ? "有未保存修改（2.5 秒后自动保存）" : "已自动保存"}>
                    <Button icon={<SaveOutlined />} loading={saving} onClick={() => void save()}>{saving ? "保存中…" : dirty ? "保存 •" : "已保存"}</Button>
                </Tooltip>
                {batch ? (
                    <div style={{ minWidth: 240 }}>
                        <Progress percent={Math.round((batch.done / Math.max(1, batch.total)) * 100)} size="small" />
                        <div style={{ fontSize: 12, opacity: 0.7 }}>
                            {batch.label} {batch.done}/{batch.total} · 当前 {batch.current}
                            {batch.perItemMs ? ` · 预计剩余 ${(() => { const m = Math.round(((batch.total - batch.done) * batch.perItemMs) / 60000); return m < 1 ? "不到 1" : `约 ${m}`; })()} 分钟` : ""}
                        </div>
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

            {/* 流程步骤条：全局进度自动高亮"当前该做什么"，点击直达 */}
            {(() => {
                const sceneReady = segments.length > 0 && [...scenes.values()].length > 0 && [...scenes.values()].every((s) => !!s.frameStorageKey);
                const steps: Array<{ label: string; done: boolean; tab: RightTab; jump?: () => void }> = [
                    { label: "① 台词分镜", done: segments.length > 0 && segments.every((s) => s.line.trim().length > 0), tab: "script" },
                    { label: "② 配音", done: segments.length > 0 && audioReady >= segments.length, tab: "material" },
                    { label: "③ 场景首帧", done: sceneReady, tab: "scene" },
                    {
                        label: "④ 段视频", done: segments.length > 0 && videoReady >= segments.length, tab: "script",
                        jump: () => { const i = segments.findIndex((s) => segmentVideoStale(s)); if (i >= 0) setSegIndex(i); },
                    },
                    { label: "⑤ 合成发布", done: !!composeResult, tab: "export" },
                ];
                const currentStep = steps.findIndex((s) => !s.done);
                return (
                    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", borderBottom: "1px solid var(--user-border, var(--border))", background: "var(--card, #1a1d22)", flexWrap: "wrap" }} aria-label="制作进度">
                        <span style={{ fontSize: 12, opacity: 0.55, marginRight: 2 }}>进度</span>
                        {steps.map((s, i) => (
                            <Tooltip key={s.label} title={s.done ? "已完成" : i === currentStep ? "当前步骤——点这里去处理" : "待处理"}>
                                <button
                                    type="button"
                                    onClick={() => { setRightTab(s.tab); s.jump?.(); }}
                                    aria-current={i === currentStep || undefined}
                                    style={{
                                        display: "inline-flex", alignItems: "center", gap: 4, border: "1px solid", borderRadius: 999, padding: "2px 10px", fontSize: 12, cursor: "pointer",
                                        background: s.done ? "rgba(82,196,26,.12)" : i === currentStep ? "var(--ant-color-primary, #4f7cff)" : "transparent",
                                        color: s.done ? "#52c41a" : i === currentStep ? "#fff" : "var(--muted, #8b929e)",
                                        borderColor: s.done ? "rgba(82,196,26,.4)" : i === currentStep ? "transparent" : "var(--user-border, var(--border))",
                                    }}
                                >
                                    {s.done ? <CheckCircleOutlined /> : null}{s.label}
                                </button>
                            </Tooltip>
                        ))}
                        <span style={{ fontSize: 12, opacity: 0.55, marginLeft: "auto" }}>
                            {currentStep < 0 ? "全部就绪，可随时重新合成 🎉" : `下一步：${steps[currentStep].label.replace(/^[①②③④⑤] /, "")}`}
                        </span>
                    </div>
                );
            })()}
            <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
                {/* 左：段导航 */}
                <div style={{ width: 190, borderRight: "1px solid var(--user-border, var(--border))", overflowY: "auto", padding: 8 }}>
                    {!segments.length ? <div style={{ fontSize: 12, opacity: 0.5, padding: "8px 4px" }}>还没有口播段</div> : null}
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
                                    {/* 三态：灰=未生成，橙=已生成但过期（改过台词/换过音色），绿=就绪 */}
                                    <Tooltip title={!seg.audio ? "未配音" : staleA ? "配音过期（台词/音色已变）" : "配音就绪"}>
                                        <span>{!seg.audio ? <AudioOutlined style={{ opacity: 0.3 }} /> : staleA ? <AudioOutlined style={{ color: "#faad14" }} /> : <AudioOutlined style={{ color: "#52c41a" }} />}</span>
                                    </Tooltip>
                                    <Tooltip title={!seg.videoResourceId ? "未生成视频" : staleV ? "视频过期（台词已改）" : "视频就绪"}>
                                        <span>{!seg.videoResourceId ? <VideoCameraOutlined style={{ opacity: 0.3 }} /> : staleV ? <VideoCameraOutlined style={{ color: "#faad14" }} /> : <VideoCameraOutlined style={{ color: "#52c41a" }} />}</span>
                                    </Tooltip>
                                    <span style={{ marginLeft: "auto", opacity: 0.5 }}>~{seg.secondsHint}s</span>
                                    <Tooltip title="上移本段"><button type="button" aria-label={`上移 ${seg.id}`} disabled={editLocked || i <= 0} onClick={(e) => { e.stopPropagation(); moveSegment(i, -1); }} style={{ border: "none", background: "transparent", color: "inherit", opacity: 0.45, cursor: "pointer", padding: "0 1px", fontSize: 10, lineHeight: 1 }}>▲</button></Tooltip>
                                    <Tooltip title="下移本段"><button type="button" aria-label={`下移 ${seg.id}`} disabled={editLocked || i >= segments.length - 1} onClick={(e) => { e.stopPropagation(); moveSegment(i, 1); }} style={{ border: "none", background: "transparent", color: "inherit", opacity: 0.45, cursor: "pointer", padding: "0 1px", fontSize: 10, lineHeight: 1 }}>▼</button></Tooltip>
                                </div>
                                <div style={{ fontSize: 12, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: 0.8 }} title={seg.line}>{seg.line || "（空）"}</div>
                            </button>
                        );
                    })}
                    <Button block size="small" type="dashed" icon={<PlusOutlined />} disabled={editLocked} onClick={() => void insertSegment(segments.length - 1)}>
                        新增段
                    </Button>
                </div>

                {/* 中：预览 + 单段二次编辑（重摇/抽卡/切换候选） */}
                <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 16, overflow: "auto" }}>
                    <div style={{ position: "relative", aspectRatio: `${geo.width} / ${geo.height}`, width: "100%", maxWidth: `calc(68vh * ${geo.width} / ${geo.height})`, maxHeight: "68vh", borderRadius: 12, overflow: "hidden", border: "1px solid var(--user-border, var(--border))", background: "#000", display: "grid", placeItems: "center" }}>
                        <Tooltip title="全屏预览">
                            <button type="button" aria-label="全屏预览视频" onClick={() => videoUrl && setLightbox(videoUrl)} disabled={!videoUrl}
                                style={{ position: "absolute", top: 8, right: 8, zIndex: 5, border: "none", background: "rgba(0,0,0,.5)", color: "#fff", width: 30, height: 30, borderRadius: 8, cursor: videoUrl ? "pointer" : "not-allowed", opacity: videoUrl ? 0.9 : 0.3, display: "grid", placeItems: "center" }}>
                                <ExpandAltOutlined />
                            </button>
                        </Tooltip>
                        {current && generating.has(`video:${current.id}`) ? (
                            <div style={{ position: "absolute", top: 8, left: 8, zIndex: 5 }}>
                                <Tag color="processing">H3 口型渲染中 · 一段约 10-20 分钟，期间可编辑其他段</Tag>
                            </div>
                        ) : null}
                        {!segments.length ? (
                            <div style={{ color: "#888", fontSize: 13, textAlign: "center", padding: 20, display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
                                <PictureOutlined style={{ fontSize: 30, opacity: 0.5 }} />
                                <div>还没有口播段</div>
                                <Button type="primary" icon={<PlusOutlined />} disabled={editLocked} onClick={() => void insertSegment(-1)}>新增第一段</Button>
                                <div style={{ fontSize: 12, opacity: 0.7 }}>或回到列表「新建口播」，让 AI 按主题拆书生成分镜</div>
                            </div>
                        ) : videoUrl ? (
                            <video key={videoUrl} src={videoUrl} controls style={{ width: "100%", height: "100%" }} />
                        ) : frameUrl ? (
                            <Image src={frameUrl} alt="站位首帧" preview={{ mask: "放大" }} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
                        ) : (
                            <div style={{ color: "#888", fontSize: 13, textAlign: "center", padding: 20 }}>
                                <PictureOutlined style={{ fontSize: 30, display: "block", marginBottom: 8, opacity: 0.5 }} />
                                {current ? `${current.id} 待生成` : ""}
                            </div>
                        )}
                        {(() => {
                            const previewCards = (current?.cards ?? []).filter((c) => c.title.trim() || c.highlight?.trim() || c.lines?.length);
                            return previewCards.length && videoUrl ? (
                                <CardPreviewOverlay
                                    cards={previewCards}
                                    windowMs={Math.max(600, Math.round((current.audio?.speechMs ?? current.audio?.durationMs ?? current.videoDurationMs ?? 4000) / previewCards.length))}
                                />
                            ) : null;
                        })()}
                    </div>
                    {videoUrl && videoIsStale ? <Alert type="warning" showIcon message="台词已改，这段视频过期——点「用新台词重摇」重新生成" /> : null}
                    {current ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "center", width: "min(100%, 420px)" }}>
                            <div style={{ fontSize: 12, opacity: 0.7 }} className="tabular-nums">
                                {current.id}
                                {current.source ? <Tag style={{ marginLeft: 6 }}>{current.source.includes("插画") ? "插画段（回档）" : "真人原片（回档）"}</Tag> : null}
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
                                <Tooltip title="上一段（←）"><Button icon={<ArrowLeftOutlined />} disabled={segIndex <= 0} onClick={() => setSegIndex((i) => Math.max(0, i - 1))} aria-label="上一段" /></Tooltip>
                                <Button type="primary" icon={<ThunderboltOutlined />} loading={generating.has(`video:${current.id}`)} disabled={busy} onClick={() => void generateSegmentVideo(current.id)}>
                                    {videoIsStale ? "用新台词重摇" : current.videoResourceId ? "重摇本段" : "生成本段视频"}
                                </Button>
                                <Button icon={<ReloadOutlined />} disabled={busy} onClick={() => void regenTakes(current.id, 2)}>再抽 2 张</Button>
                                {generating.has(`video:${current.id}`) ? <Button icon={<StopOutlined />} onClick={() => cancelGen(`video:${current.id}`)}>取消</Button> : null}
                                <Tooltip title="下一段（→）"><Button icon={<ArrowRightOutlined />} disabled={segIndex >= segments.length - 1} onClick={() => setSegIndex((i) => Math.min(segments.length - 1, i + 1))} aria-label="下一段" /></Tooltip>
                            </Space>
                            <div style={{ fontSize: 11, opacity: 0.5, textAlign: "center" }}>
                                {current.source?.includes("插画")
                                    ? "本段是回档导入的插画成品段（画面=插画+字幕）；点「重摇本段」会改用真人管线（站位首帧+人物稿+配音）重新生成。"
                                    : <>本段视频 = 站位首帧 + 人物稿{current.extraRefs?.length ? ` + 本段参考图×${current.extraRefs.length}` : ""} + 配音 → H3 口型渲染；改台词、换素材或重写表演后重摇即生效，抽卡候选随时切换。</>}
                            </div>
                        </div>
                    ) : null}
                </div>

                {/* 可拖拽分隔条：左右拉宽预览区或编辑区 */}
                <div
                    role="separator"
                    aria-label="调整预览区宽度"
                    onPointerDown={(e) => {
                        e.preventDefault();
                        (e.target as HTMLElement).setPointerCapture(e.pointerId);
                        const startX = e.clientX;
                        const startWidth = rightWidth;
                        let latest = startWidth;
                        const move = (ev: PointerEvent) => {
                            latest = Math.min(720, Math.max(300, startWidth + (startX - ev.clientX)));
                            setRightWidth(latest);
                        };
                        const up = (ev: PointerEvent) => {
                            (e.target as HTMLElement).releasePointerCapture(ev.pointerId);
                            window.removeEventListener("pointermove", move);
                            window.removeEventListener("pointerup", up);
                            localStorage.setItem("dh-right-width", String(Math.round(latest)));
                        };
                        window.addEventListener("pointermove", move);
                        window.addEventListener("pointerup", up);
                    }}
                    style={{ width: 7, flex: "none", cursor: "col-resize", background: "transparent", display: "grid", placeItems: "center" }}
                >
                    <div style={{ width: 3, height: 48, borderRadius: 2, background: "var(--user-border, var(--border))" }} />
                </div>

                {/* 右：编辑面板 */}
                <div style={{ width: rightWidth, flex: "none", borderLeft: "1px solid var(--user-border, var(--border))", overflowY: "auto", padding: 12 }}>
                    <Segmented
                        block
                        value={rightTab}
                        onChange={(v) => setRightTab(v as RightTab)}
                        options={[
                            { value: "script", label: "台词" },
                            { value: "material", label: "配音·素材" },
                            { value: "scene", label: "场景与形象" },
                            { value: "export", label: "成片" },
                        ]}
                        style={{ marginBottom: 12 }}
                    />
                    {current ? (
                        <SegmentPipeline
                            title="本段流水线"
                            hint="段视频 = 站位首帧 + 数字人人物稿 + 配音 → H3 口型渲染；点灰色/橙色步骤直接补齐"
                            steps={pipelineSteps}
                        />
                    ) : null}
                    {rightTab === "script" && current ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                            <div>
                                <div style={{ fontSize: 13, marginBottom: 4 }}>台词（改后配音/视频会标记过期）</div>
                                <Input.TextArea rows={3} value={current.line} onChange={(e) => updateSegMeta(current.id, { line: e.target.value, videoPrompt: syncLineIntoVideoPrompt(current.videoPrompt, e.target.value) }, `line:${current.id}`)} disabled={editLocked} />
                                <div style={{ fontSize: 12, opacity: 0.55, marginTop: 2 }}>约 {estimateSegmentSeconds(current.line)} 秒 · {current.line.replace(/\s/g, "").length} 字</div>
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                                <div>
                                    <div style={{ fontSize: 13, marginBottom: 4 }}>景别</div>
                                    <Select value={current.camera} onChange={(v) => updateSegMeta(current.id, { camera: v })} disabled={editLocked} style={{ width: "100%" }}
                                        options={["close-up", "medium close-up", "medium shot"].map((c) => ({ value: c, label: c }))} />
                                </div>
                                <div>
                                    <div style={{ fontSize: 13, marginBottom: 4 }}>场景</div>
                                    <Select value={current.sceneKey} onChange={(v) => updateSegMeta(current.id, { sceneKey: v })} disabled={editLocked} style={{ width: "100%" }} options={sceneOptions} />
                                </div>
                            </div>
                            <div>
                                <div style={{ fontSize: 13, marginBottom: 4 }}>表情</div>
                                <Input value={current.expression} onChange={(e) => updateSegMeta(current.id, { expression: e.target.value }, `expr:${current.id}`)} disabled={editLocked} />
                            </div>
                            <div>
                                <div style={{ fontSize: 13, marginBottom: 4 }}>动作（微动作）</div>
                                <Input value={current.action} onChange={(e) => updateSegMeta(current.id, { action: e.target.value }, `act:${current.id}`)} disabled={editLocked} />
                            </div>
                            <Collapse
                                size="small"
                                items={[{
                                    key: "advanced",
                                    label: "高级：视频提示词（通常无需手改）",
                                    children: (
                                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                            <Input.TextArea rows={6} value={current.videoPrompt} onChange={(e) => updateSegMeta(current.id, { videoPrompt: e.target.value }, `vp:${current.id}`)} disabled={editLocked} />
                                            <Button size="small" icon={<ReloadOutlined />} loading={generating.has(`prompt:${current.id}`)} disabled={busy} onClick={() => void regeneratePrompt(current.id)}>
                                                按表情/动作重写表演
                                            </Button>
                                        </div>
                                    ),
                                }]}
                            />
                            <div style={{ borderTop: "1px solid var(--user-border, var(--border))", paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <span style={{ fontSize: 13, fontWeight: 600 }}>信息卡（讲到重点时浮出画面）</span>
                                    <Tooltip title="让 AI 从本段台词提炼 1-3 张重点卡；也可手动添加">
                                        <Button size="small" icon={<ThunderboltOutlined />} loading={generating.has(`cards:${current.id}`)} disabled={busy || !config?.textModel} onClick={() => void aiExtractCards(current)}>AI 提取</Button>
                                    </Tooltip>
                                    <Button size="small" type="dashed" icon={<PlusOutlined />} disabled={editLocked} onClick={() => updateCards(current.id, [...(current.cards ?? []), { id: `c-${Date.now().toString(36)}`, title: "" }])} style={{ marginLeft: "auto" }}>添加</Button>
                                </div>
                                {(current.cards ?? []).map((card, ci) => (
                                    <div key={card.id} style={{ border: "1px solid var(--user-border, var(--border))", borderRadius: 10, padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                                        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                                            <Input size="small" value={card.title} placeholder="标题（白色大字）" disabled={editLocked}
                                                onChange={(e) => updateCards(current.id, (current.cards ?? []).map((c, i) => (i === ci ? { ...c, title: e.target.value } : c)))} />
                                            <Input size="small" value={card.highlight ?? ""} placeholder="强调词（金色）" disabled={editLocked} style={{ maxWidth: 132 }}
                                                onChange={(e) => updateCards(current.id, (current.cards ?? []).map((c, i) => (i === ci ? { ...c, highlight: e.target.value } : c)))} />
                                            <Tooltip title="删除这张卡">
                                                <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={`删除信息卡 ${ci + 1}`} disabled={editLocked}
                                                    onClick={() => updateCards(current.id, (current.cards ?? []).filter((_, i) => i !== ci))} />
                                            </Tooltip>
                                        </div>
                                        <Input.TextArea size="small" rows={2} value={cardLinesToText(card)} placeholder={"附加行，一行一条；行首加 * 显示金色\n例如：*1.3MB/s"} disabled={editLocked}
                                            onChange={(e) => updateCards(current.id, (current.cards ?? []).map((c, i) => (i === ci ? { ...c, lines: textToCardLines(e.target.value) } : c)))} />
                                        <div style={{ fontSize: 11, opacity: 0.5 }}>
                                            第 {ci + 1}/{current.cards?.length ?? 0} 张 · 播放本段视频可在中栏预览浮出效果
                                        </div>
                                    </div>
                                ))}
                                {!current.cards?.length ? (
                                    <div style={{ fontSize: 12, opacity: 0.5 }}>还没有信息卡。添加或 AI 提取后，合成成片时卡片会按配音节奏浮在画面左上。</div>
                                ) : null}
                            </div>
                            <div style={{ display: "flex", gap: 8, borderTop: "1px solid var(--user-border, var(--border))", paddingTop: 10 }}>
                                <Tooltip title="在当前段之后插入空段，写好台词即可配音"><Button size="small" icon={<PlusOutlined />} disabled={editLocked} onClick={() => void insertSegment(segIndex)}>下方插入新段</Button></Tooltip>
                                <Tooltip title="复制当前段的分镜与表演（不带配音/视频）"><Button size="small" icon={<CopyOutlined />} disabled={editLocked} onClick={() => void insertSegment(segIndex, current)}>复制本段</Button></Tooltip>
                                <Tooltip title="移除本段及其配音/视频引用（资源保留在资产库）"><Button size="small" danger icon={<DeleteOutlined />} disabled={editLocked} onClick={() => deleteSegment(current.id)}>删除本段</Button></Tooltip>
                            </div>
                        </div>
                    ) : null}

                    {rightTab === "material" && current ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                            <div style={{ border: "1px solid var(--user-border, var(--border))", borderRadius: 10, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                                    <span style={{ fontSize: 13, fontWeight: 600 }}>数字人音色</span>
                                    <Tag>{persona?.voice || "未绑定"}</Tag>
                                    <span style={{ fontSize: 12, opacity: 0.6 }}>{persona?.voiceModel?.split("::").pop() ?? "TTS"}</span>
                                    <Tooltip title="用一句示例快速听这个音色的效果（不落库）">
                                        <Button size="small" icon={<SoundOutlined />} style={{ marginLeft: "auto" }} loading={voicePreviewing === persona?.voice} disabled={!persona?.voice} onClick={() => persona?.voice && void previewVoice(persona.voice)}>
                                            试听音色
                                        </Button>
                                    </Tooltip>
                                </div>
                                {persona?.voiceInstructions ? <div style={{ fontSize: 12, opacity: 0.55 }}>语气指令：{persona.voiceInstructions}</div> : null}
                                <div style={{ display: "flex", gap: 8 }}>
                                    <Select
                                        style={{ flex: 1, minWidth: 0 }}
                                        value={persona?.voice}
                                        disabled={editLocked}
                                        loading={channelVoices === null}
                                        placeholder="换绑音色（现有配音将标记过期）"
                                        showSearch
                                        optionFilterProp="label"
                                        onChange={(v) => void changePersonaVoice(v)}
                                        options={(channelVoices?.length ? channelVoices : [persona?.voice ?? ""]).filter(Boolean).map((v) => ({ value: v, label: v }))}
                                        notFoundContent={channelVoices === null ? "音色列表加载中…" : "渠道未返回音色列表"}
                                    />
                                    <Button icon={<AudioOutlined />} disabled={editLocked} onClick={() => setVoicePanelOpen((v) => !v)}>
                                        {voicePanelOpen ? "收起音色工坊" : "设计新音色"}
                                    </Button>
                                </div>
                                {voicePanelOpen && voiceRequestConfig ? (
                                    <VoiceDesignPanel
                                        requestConfig={voiceRequestConfig}
                                        sampleText={current.line || "大家好，每天三分钟，带你看懂一个有趣的知识。"}
                                        onDraft={(blob, name, text) => {
                                            draftBlobRef.current = blob;
                                            const url = URL.createObjectURL(blob);
                                            setDraft({ id: crypto.randomUUID(), kind: "audio", url, label: `新音色 · ${name}`, detail: "试听满意点「使用」入库并绑定", payload: { type: "voice", name, text } });
                                        }}
                                    />
                                ) : null}
                            </div>
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
                                <Tooltip title="按当前台词与音色合成，先在底部预览条试听，满意再使用">
                                    <Button type="primary" icon={<AudioOutlined />} loading={generating.has(`audio:${current.id}`)} disabled={busy} onClick={() => void draftSegAudio(current.id)}>
                                        {current.audio ? "重新配音（试听）" : "生成配音（试听）"}
                                    </Button>
                                </Tooltip>
                                <Button icon={<PlusOutlined />} disabled={editLocked} onClick={() => setPicker({ target: "segAudio", key: current.id })}>选择/上传配音</Button>
                                {genButton(`audio:${current.id}`, "配音中")}
                            </Space>
                            <div style={{ borderTop: "1px solid var(--user-border, var(--border))", paddingTop: 10 }}>
                                <div style={{ fontSize: 13, marginBottom: 6, fontWeight: 600 }}>参考图（生成时排在人物稿之后）</div>
                                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                    {(current.extraRefs ?? []).map((r) => (
                                        <span key={r.storageKey} style={{ position: "relative", width: 56, height: 56, borderRadius: 8, overflow: "hidden", border: "1px solid var(--user-border, var(--border))" }}>
                                            <Image src={`/api/resources/${r.storageKey.replace(/^resource:/, "")}/file`} alt={r.name} preview={{ mask: "放大" }} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
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
                            </div>
                        </div>
                    ) : null}

                    {rightTab === "scene" ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                            <div>
                                <div style={{ fontSize: 13, marginBottom: 6, fontWeight: 600 }}>数字人（建册时快照绑定）</div>
                                <div style={{ display: "flex", gap: 10 }}>
                                    {persona?.portraitStorageKey ? (
                                        <Image src={`/api/resources/${persona.portraitStorageKey.replace(/^resource:/, "")}/file`} alt={persona.name} preview={{ mask: "放大" }} style={{ width: 72, height: 96, objectFit: "cover", borderRadius: 8, border: "1px solid var(--user-border, var(--border))" }} />
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
                                    disabled={editLocked}
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
                                <div style={{ marginTop: 10, borderTop: "1px solid var(--user-border, var(--border))", paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                                    <div style={{ fontSize: 12, opacity: 0.7 }}>人物形象提示词（改完重新生成，预览满意再使用）</div>
                                    <Input.TextArea rows={3} value={portraitPrompt} onChange={(e) => setPortraitPrompt(e.target.value)} disabled={editLocked} placeholder="character reference portrait, front-facing..." />
                                    <Space size={6} wrap>
                                        <Button size="small" type="primary" icon={<ThunderboltOutlined />} loading={generating.has("portrait")} disabled={busy || !portraitPrompt.trim()} onClick={() => void draftPortrait()}>
                                            生成形象（预览）
                                        </Button>
                                    </Space>
                                    <div style={{ fontSize: 11, opacity: 0.55 }}>换形象/换音色只影响之后的生成；已生成的段不变，需要时重摇即可。音色试听与设计在「配音·素材」页签。</div>
                                </div>
                            </div>
                            <div>
                                <div style={{ fontSize: 13, marginBottom: 6, fontWeight: 600 }}>场景（场景图 → 站位首帧，跨段复用）</div>
                                {[...scenes.values()].map((scene) => (
                                    <div key={scene.key} style={{ border: "1px solid var(--user-border, var(--border))", borderRadius: 10, padding: 10, marginBottom: 8 }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                                            <span style={{ fontWeight: 600 }}>{scene.name}</span>
                                            <Tag style={{ marginLeft: "auto" }}>{scene.key}</Tag>
                                            <Tooltip title="删除场景（引用段改挂第一个剩余场景）">
                                                <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={`删除场景 ${scene.key}`} disabled={editLocked} onClick={() => deleteScene(scene.key)} />
                                            </Tooltip>
                                        </div>
                                        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                                            <div style={{ flex: 1 }}>
                                                <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 2 }}>场景图</div>
                                                {scene.imageStorageKey
                                                    ? <Image src={`/api/resources/${scene.imageStorageKey.replace(/^resource:/, "")}/file`} alt={scene.name} preview={{ mask: "放大" }} style={{ width: "100%", aspectRatio: `${geo.width} / ${geo.height}`, objectFit: "cover", borderRadius: 6 }} />
                                                    : <div style={{ fontSize: 12, opacity: 0.5 }}>未生成</div>}
                                            </div>
                                            <div style={{ flex: 1 }}>
                                                <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 2 }}>站位首帧</div>
                                                {scene.frameStorageKey
                                                    ? <Image src={`/api/resources/${scene.frameStorageKey.replace(/^resource:/, "")}/file`} alt={`${scene.name} 首帧`} preview={{ mask: "放大" }} style={{ width: "100%", aspectRatio: `${geo.width} / ${geo.height}`, objectFit: "cover", borderRadius: 6 }} />
                                                    : <div style={{ fontSize: 12, opacity: 0.5 }}>未生成</div>}
                                            </div>
                                        </div>
                                        <Input.TextArea rows={2} value={scene.promptEn} onChange={(e) => updateSceneMeta(scene.key, { promptEn: e.target.value })} disabled={editLocked} placeholder="英文场景描述（无人物）" style={{ marginBottom: 8 }} />
                                        <Space size={6}>
                                            <Tooltip title="从提示词参考库按中文搜场景描述，选中后替换本场景提示词">
                                                <Button size="small" disabled={editLocked} onClick={() => setSceneLibraryKey(scene.key)}>参考库</Button>
                                            </Tooltip>
                                            <Tooltip title="按上方提示词生成，先在底部预览条确认满意再使用">
                                                <Button size="small" icon={<PictureOutlined />} loading={generating.has(`scene:${scene.key}`)} disabled={busy} onClick={() => void draftSceneImage(scene.key)}>
                                                    生成场景图（预览）
                                                </Button>
                                            </Tooltip>
                                            <Tooltip title="把人物参考图放进本场景，预览满意再使用">
                                                <Button size="small" icon={<CloudUploadOutlined />} loading={generating.has(`frame:${scene.key}`)} disabled={busy || !scene.imageStorageKey} onClick={() => void draftPlacementFrame(scene.key)}>
                                                    造站位首帧（预览）
                                                </Button>
                                            </Tooltip>
                                            <Button size="small" icon={<PlusOutlined />} disabled={busy} onClick={() => setPicker({ target: "sceneImage", key: scene.key })}>选择场景图</Button>
                                            <Button size="small" icon={<PlusOutlined />} disabled={busy} onClick={() => setPicker({ target: "sceneFrame", key: scene.key })}>选择站位首帧</Button>
                                            {generating.has(`scene:${scene.key}`) ? <Button size="small" icon={<StopOutlined />} onClick={() => cancelGen(`scene:${scene.key}`)} /> : null}
                                            {generating.has(`frame:${scene.key}`) ? <Button size="small" icon={<StopOutlined />} onClick={() => cancelGen(`frame:${scene.key}`)} /> : null}
                                        </Space>
                                    </div>
                                ))}
                                <Button block icon={<PlusOutlined />} disabled={editLocked} onClick={() => setSceneDraft({ name: "", promptEn: "" })}>新增场景</Button>
                            </div>
                        </div>
                    ) : null}

                    {rightTab === "export" ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                            <Alert type="info" showIcon message={<span>服务端合成：全部段视频顺序拼接 + 逐段台词烧录字幕（{geo.width}×{geo.height} · 24fps）</span>} />
                            <Button type="primary" icon={<ScissorOutlined />} loading={!!composing} disabled={busy} onClick={() => void compose()}>
                                {composeResult ? "重新合成" : "合成成片"}
                            </Button>
                            {composeStale ? <Alert type="warning" showIcon message="成片已过期：合成后段视频有增删、重摇或换过候选，建议重新合成。" /> : null}
                            {composeResult ? (
                                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                    <div style={{ position: "relative" }}>
                                            <video src={resourceFileUrl(composeResult.resourceId)} controls style={{ width: "100%", borderRadius: 10, border: "1px solid var(--user-border, var(--border))" }} />
                                            <Tooltip title="全屏预览">
                                                <button type="button" aria-label="全屏预览成片" onClick={() => setLightbox(resourceFileUrl(composeResult.resourceId))}
                                                    style={{ position: "absolute", top: 8, right: 8, zIndex: 5, border: "none", background: "rgba(0,0,0,.5)", color: "#fff", width: 30, height: 30, borderRadius: 8, cursor: "pointer", display: "grid", placeItems: "center" }}>
                                                    <ExpandAltOutlined />
                                                </button>
                                            </Tooltip>
                                        </div>
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
                            <div style={{ borderTop: "1px solid var(--user-border, var(--border))", paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                                <div style={{ fontSize: 13, fontWeight: 600 }}>发布包</div>
                                <div style={{ display: "flex", gap: 10 }}>
                                    <div style={{ width: 72, flex: "none" }}>
                                        {(() => {
                                            const coverKey = config.publish?.coverStorageKey || ([...scenes.values()].find((s) => s.frameStorageKey)?.frameStorageKey ?? persona?.portraitStorageKey);
                                            return coverKey
                                                ? <Image src={`/api/resources/${coverKey.replace(/^resource:/, "")}/file`} alt="封面" preview={{ mask: "放大" }} style={{ width: 72, aspectRatio: `${geo.width} / ${geo.height}`, objectFit: "cover", borderRadius: 8, border: "1px solid var(--user-border, var(--border))" }} />
                                                : <div style={{ width: 72, aspectRatio: `${geo.width} / ${geo.height}`, borderRadius: 8, border: "1px dashed var(--user-border, var(--border))", display: "grid", placeItems: "center", fontSize: 11, opacity: 0.5 }}>无封面</div>;
                                        })()}
                                    </div>
                                    <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
                                        <Input.TextArea rows={2} value={coverPrompt} onChange={(e) => setCoverPrompt(e.target.value)} disabled={editLocked} placeholder="封面提示词（竖版海报，顶部留标题空间）" />
                                        <Space size={6} wrap>
                                            <Button size="small" icon={<ThunderboltOutlined />} loading={generating.has("cover")} disabled={busy || !coverPrompt.trim()} onClick={() => void draftCover()}>生成封面（预览）</Button>
                                            <Button size="small" icon={<PlusOutlined />} disabled={editLocked} onClick={() => setPicker({ target: "cover", key: "cover" })}>选择封面</Button>
                                        </Space>
                                    </div>
                                </div>
                                <div>
                                    <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 4 }}>标题</div>
                                    <Input value={config.publish?.title ?? config.title} disabled={editLocked} onChange={(e) => updateConfig((cfg) => { cfg.publish = { ...(cfg.publish ?? { title: cfg.title, description: "", tags: "" }), title: e.target.value }; })} />
                                </div>
                                <div>
                                    <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 4 }}>简介</div>
                                    <Input.TextArea rows={3} value={config.publish?.description ?? ""} disabled={editLocked} placeholder="发布用文案" onChange={(e) => updateConfig((cfg) => { cfg.publish = { ...(cfg.publish ?? { title: cfg.title, description: "", tags: "" }), description: e.target.value }; })} />
                                    <Button size="small" type="link" disabled={editLocked} onClick={() => updateConfig((cfg) => {
                                        const head = segments.slice(0, 2).map((s) => s.line).join(" ");
                                        const tail = segments[segments.length - 1]?.line ?? "";
                                        cfg.publish = { ...(cfg.publish ?? { title: cfg.title, tags: "" }), description: `${head}\n……\n${tail}` };
                                    })}>用台词自动生成</Button>
                                </div>
                                <div>
                                    <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 4 }}>标签（逗号分隔）</div>
                                    <Input value={config.publish?.tags ?? ""} disabled={editLocked} placeholder="科普,冷知识,造纸术" onChange={(e) => updateConfig((cfg) => { cfg.publish = { ...(cfg.publish ?? { title: cfg.title, description: "", tags: "" }), tags: e.target.value }; })} />
                                </div>
                                <Button type="primary" icon={<DownloadOutlined />} loading={exportingZip} disabled={!composeResult} onClick={() => void exportPublishPackage()}>
                                    导出发布包（MP4 + SRT + 封面 + 文案）
                                </Button>
                                {!composeResult ? <div style={{ fontSize: 12, opacity: 0.55 }}>合成成片后可导出。</div> : null}
                            </div>
                        </div>
                    ) : null}
                </div>
            </div>
            <AssetPickerModal
                open={!!picker}
                kind={picker?.target === "segAudio" ? "audio" : "image"}
                title={picker?.target === "sceneImage" ? "选择场景图" : picker?.target === "sceneFrame" ? "选择站位首帧" : picker?.target === "segAudio" ? "选择本段配音" : picker?.target === "cover" ? "选择封面" : "添加本段参考图"}
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
            <Modal
                open={!!sceneDraft}
                title="新增场景"
                okText="创建"
                cancelText="取消"
                okButtonProps={{ disabled: !sceneDraft?.name.trim() || !sceneDraft?.promptEn.trim() }}
                onOk={() => {
                    const d = sceneDraft;
                    setSceneDraft(null);
                    if (d) void addScene(d.name.trim(), d.promptEn.trim());
                }}
                onCancel={() => setSceneDraft(null)}
            >
                <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 6 }}>
                    <div>
                        <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 4 }}>场景名（中文）</div>
                        <Input value={sceneDraft?.name ?? ""} onChange={(e) => setSceneDraft((d) => (d ? { ...d, name: e.target.value } : d))} placeholder="演播室" />
                    </div>
                    <div>
                        <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 4 }}>英文场景描述（不含人物；创建后可改、可从参考库替换）</div>
                        <Input.TextArea rows={3} value={sceneDraft?.promptEn ?? ""} onChange={(e) => setSceneDraft((d) => (d ? { ...d, promptEn: e.target.value } : d))} placeholder="minimal modern studio room with soft ambient lighting, no people" />
                    </div>
                </div>
            </Modal>
            <MediaDraftBar draft={draft} busy={busy} onUse={() => void commitDraft()} onDiscard={() => { draftBlobRef.current = null; setDraft(null); }} />
            <VideoLightbox src={lightbox} onClose={() => setLightbox(null)} />
        </div>
    );
}
