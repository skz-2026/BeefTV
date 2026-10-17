import { Button, Tooltip } from "antd";
import { useEffect, useRef, useState } from "react";
import { ApiError, http } from "@/services/api/request";
import { uiSessionConfig, type AssistantSkillSelection } from "@/services/api/agent-assistant";
import { captureUserScopeEpoch, getActiveUserScope, userScopeEpochMatches } from "@/lib/user-scope";
import { beginSkillContextMutation, finishSkillContextMutation, readSkillContextMutation, skillContextMutationKey, type SkillContextAction, type SkillContextMutation } from "./skill-context-mutation";

type SkillContext = { scopeId: string; revision: number; activePins: AssistantSkillSelection[]; lifecycle: string };
export function CanvasSkillContext({ canvasId, sessionId, busy, readOnly, onChanged }: { canvasId: string; sessionId: string; busy: boolean; readOnly: boolean; onChanged: () => void }) {
    const [value, setValue] = useState<SkillContext | null>(null);
    const [error, setError] = useState("");
    const [pending, setPending] = useState(false);
    const [unfinished, setUnfinished] = useState<SkillContextMutation | null>(null);
    const [reload, setReload] = useState(0);
    const key = skillContextMutationKey(getActiveUserScope(), canvasId, sessionId);
    const liveKey = useRef(key);
    liveKey.current = key;
    useEffect(() => {
        setValue(null);
        setPending(false);
        setError("");
        try {
            setUnfinished(readSkillContextMutation(sessionStorage, key, sessionId));
        } catch {
            setError("无法保存操作进度，请允许浏览器存储后重试");
        }
    }, [key, sessionId]);
    useEffect(() => {
        if (!sessionId.startsWith("durable:") || busy) return;
        let active = true;
        const owner = captureUserScopeEpoch();
        void uiSessionConfig()
            .then((config) => http.get<SkillContext>(`/assistant/canvases/${encodeURIComponent(canvasId)}/skill-context`, { ...config, params: { sessionId } }))
            .then((v) => {
                if (active && userScopeEpochMatches(owner)) {
                    setValue(v);
                    setError("");
                }
            })
            .catch((e) => {
                if (active && userScopeEpochMatches(owner)) setError(e instanceof Error ? e.message : "当前技能状态暂时无法读取");
            });
        return () => {
            active = false;
        };
    }, [key, canvasId, sessionId, busy, reload]);
    const change = async (action: SkillContextAction) => {
        if (!value || busy || pending || readOnly) return;
        const owner = captureUserScopeEpoch();
        const isCurrent = () => liveKey.current === key && userScopeEpochMatches(owner);
        let mutation: SkillContextMutation | undefined;
        setPending(true);
        setError("");
        try {
            mutation = beginSkillContextMutation(sessionStorage, key, sessionId, action, value.revision);
            setUnfinished(mutation);
            const config = await uiSessionConfig();
            if (!isCurrent()) return;
            const v = await http.post<SkillContext>(`/assistant/canvases/${encodeURIComponent(canvasId)}/skill-context`, mutation, config);
            finishSkillContextMutation(sessionStorage, key, mutation);
            if (!isCurrent()) return;
            setUnfinished(null);
            setValue(v);
            onChanged();
        } catch (e) {
            if (!isCurrent()) return;
            if (mutation && e instanceof ApiError && ["skill_context_revision_conflict", "skill_context_request_conflict"].includes(e.reason ?? "")) {
                finishSkillContextMutation(sessionStorage, key, mutation);
                setUnfinished(null);
                setReload((v) => v + 1);
            }
            setError(e instanceof Error ? e.message : "技能状态未更新，请重试");
        } finally {
            if (isCurrent()) setPending(false);
        }
    };
    if (!sessionId.startsWith("durable:")) return null;
    return (
        <div className="px-3 py-2 text-xs text-muted-foreground" aria-live="polite">
            <div className="flex flex-wrap items-center justify-between gap-1">
                <span>{value?.activePins?.length ? `当前使用 ${value.activePins.length} 个技能` : "当前没有活动技能"}</span>
                <div className="flex gap-1">
                    {unfinished || value?.lifecycle === "reset_pending" ? (
                        <Button size="small" type="text" loading={pending} disabled={!value || busy || readOnly} onClick={() => void change(unfinished?.action ?? "refresh")}>
                            恢复上次操作
                        </Button>
                    ) : (
                        <>
                            {Boolean(value?.activePins?.length) && (
                                <>
                                    <Button size="small" type="text" disabled={busy || pending || readOnly} onClick={() => void change("refresh")}>
                                        重新读取
                                    </Button>
                                    <Tooltip title="停止采用当前技能，仍可引用历史内容">
                                        <Button size="small" type="text" disabled={busy || pending || readOnly} onClick={() => void change("clear")}>
                                            停用
                                        </Button>
                                    </Tooltip>
                                </>
                            )}
                            <Tooltip title="开始独立任务，助手不再沿用旧任务指令，历史记录会保留">
                                <Button size="small" type="text" disabled={!value || busy || pending || readOnly} onClick={() => void change("new_scope")}>
                                    开始独立任务
                                </Button>
                            </Tooltip>
                        </>
                    )}
                </div>
            </div>
            {error && (
                <p role="alert" className="mt-1 text-destructive">
                    {error}
                </p>
            )}
        </div>
    );
}
