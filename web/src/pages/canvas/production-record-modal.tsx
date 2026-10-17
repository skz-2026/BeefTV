import { Alert, App, Modal, Select, Spin } from "antd";
import { useEffect, useState } from "react";
import {
    getCanvasProductionContext,
    getProjectUnitWorkspace,
    listProjects,
    listProjectUnits,
    registerCanvasProductionTask,
    type CanvasProductionContext,
    type CanvasProductionStep,
    type ProjectShot,
    type ProjectSummary,
    type ProjectUnit,
} from "@/services/api/projects";
import type { CanvasNodeData } from "@/types/canvas";

export function ProductionRecordModal({ node, canvasId, projectId: initialProject, onClose }: { node: CanvasNodeData | null; canvasId: string; projectId?: string; onClose: () => void }) {
    const { message } = App.useApp();
    const [projects, setProjects] = useState<ProjectSummary[]>([]),
        [units, setUnits] = useState<ProjectUnit[]>([]),
        [shots, setShots] = useState<ProjectShot[]>([]);
    const [project, setProject] = useState(initialProject || ""),
        [unit, setUnit] = useState(""),
        [shot, setShot] = useState("");
    const [step, setStep] = useState<CanvasProductionStep>("storyboard");
    const [context, setContext] = useState<CanvasProductionContext | null>(null),
        [error, setError] = useState(""),
        [busy, setBusy] = useState(false);
    useEffect(() => {
        if (!node) return;
        setProject(initialProject || "");
        setUnit("");
        setShot("");
        setContext(null);
        setError("");
        setStep(node.type === "video" ? "video" : "storyboard");
        let active = true;
        void listProjects()
            .then((r) => {
                if (active) setProjects(r.projects);
            })
            .catch((e) => {
                if (active) setError(e.message);
            });
        return () => {
            active = false;
        };
    }, [node, initialProject]);
    useEffect(() => {
        setUnits([]);
        setUnit("");
        setShots([]);
        setShot("");
        if (!node || !project) return;
        let active = true;
        void listProjectUnits(project)
            .then((r) => {
                if (active) setUnits(r.units);
            })
            .catch((e) => {
                if (active) setError(e.message);
            });
        return () => {
            active = false;
        };
    }, [project, node]);
    useEffect(() => {
        setShots([]);
        setShot("");
        if (!node || !project || !unit) return;
        let active = true;
        void getProjectUnitWorkspace(project, unit)
            .then((r) => {
                if (active) setShots(r.shots);
            })
            .catch((e) => {
                if (active) setError(e.message);
            });
        return () => {
            active = false;
        };
    }, [project, unit, node]);
    useEffect(() => {
        setContext(null);
        setError("");
        if (!node || !project || !unit || !shot) return;
        let active = true;
        void getCanvasProductionContext(project, canvasId, { unitId: unit, shotId: shot, stepKey: step })
            .then((r) => {
                if (active) setContext(r.context);
            })
            .catch((e) => {
                if (active) setError(e.message);
            });
        return () => {
            active = false;
        };
    }, [project, unit, shot, step, canvasId, node]);
    const save = async () => {
        if (!node?.metadata?.taskId || !context) return;
        setBusy(true);
        setError("");
        try {
            await registerCanvasProductionTask(project, canvasId, { unitId: unit, shotId: shot, shotRevisionId: context.shotRevisionId, stepKey: step, taskId: node.metadata.taskId, resourceId: node.metadata.storageKey?.startsWith("resource:") ? node.metadata.storageKey.slice("resource:".length) : undefined });
            message.success("已关联现有产物，可在项目中确认使用");
            onClose();
        } catch (e) {
            setError(e instanceof Error ? e.message : "关联未完成，请重试");
            setContext(null);
        } finally {
            setBusy(false);
        }
    };
    return (
        <Modal open={Boolean(node)} title="关联制作记录" onCancel={onClose} onOk={() => void save()} okText="确认关联现有产物" confirmLoading={busy} okButtonProps={{ disabled: !context }} destroyOnHidden>
            <div className="space-y-4">
                <p>{node?.title}</p>
                <Alert type="info" title="把已有产物归入项目镜头，随后在项目中确认使用。此操作不会重新生成或产生生成费用。" />
                <label className="block">
                    项目
                    <Select
                        aria-label="制作项目"
                        className="mt-1 w-full"
                        value={project || undefined}
                        placeholder="选择项目"
                        disabled={Boolean(initialProject)}
                        onChange={setProject}
                        options={projects.map((p) => ({ value: p.project.id, label: p.project.name }))}
                    />
                </label>
                <label className="block">
                    章节
                    <Select aria-label="制作章节" className="mt-1 w-full" value={unit || undefined} placeholder={project ? "选择章节" : "请先选择项目"} disabled={!project} onChange={setUnit} options={units.map((u) => ({ value: u.id, label: u.title }))} />
                </label>
                <label className="block">
                    镜头
                    <Select aria-label="制作镜头" className="mt-1 w-full" value={shot || undefined} placeholder={unit ? "选择镜头" : "请先选择章节"} disabled={!unit} onChange={setShot} options={shots.map((s) => ({ value: s.id, label: s.title }))} />
                </label>
                <label className="block">
                    阶段
                    <Select
                        aria-label="制作阶段"
                        className="mt-1 w-full"
                        value={step}
                        onChange={setStep}
                        options={[
                            { value: "storyboard", label: "分镜" },
                            { value: "previz", label: "预演" },
                            { value: "video", label: "视频" },
                            { value: "delivery", label: "交付" },
                        ]}
                    />
                </label>
                {shot && !context && !error && <Spin size="small" />}
                {context && <p>将关联到当前镜头版本；之后修改镜头，需要重新确认受影响的制作步骤。</p>}
                {error && <Alert type="error" title={error} description="可重新选择镜头以读取当前版本。" />}
            </div>
        </Modal>
    );
}
