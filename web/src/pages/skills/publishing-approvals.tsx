import { Alert, Button } from "antd";
import { useEffect, useState } from "react";
import { publishingPlans, type PublishPlan } from "@/services/api/skill-market";
import { PublishReview } from "./publish-review";

export function PublishingApprovals({ refreshKey = "", canvasId }: { refreshKey?: string; canvasId: string }) {
    const [plans, setPlans] = useState<PublishPlan[]>([]);
    const [error, setError] = useState("");
    const [selected, setSelected] = useState<PublishPlan | null>(null);
    useEffect(() => {
        let active = true;
        const load = () =>
            publishingPlans()
                .then((r) => {
                    if (active) {
                        setError("");
                        setPlans(r.items.filter((p) => p.canvasId === canvasId && (p.status.startsWith("awaiting_") || p.status === "uploading")));
                    }
                })
                .catch((e) => {
                    if (active) setError(e instanceof Error ? e.message : "投稿确认暂时无法读取");
                });
        void load();
        const timer = window.setInterval(() => void load(), 8000);
        return () => {
            active = false;
            window.clearInterval(timer);
        };
    }, [refreshKey, canvasId]);
    if (!plans.length && !selected && !error) return null;
    return (
        <div className="space-y-2 px-3 pb-2">
            {error && <Alert type="warning" title={error} description="稍后会自动重试，也可到扩展页查看投稿。" />}
            {plans.slice(0, 3).map((p) => (
                <Alert
                    key={p.planId}
                    type="info"
                    title={p.metadata.name}
                    description={p.status === "awaiting_submit_confirmation" ? "技能预览已准备好，等待你确认送审。" : "助手已准备好投稿文件，等待你确认上传。"}
                    action={
                        <Button size="small" onClick={() => setSelected(p)}>
                            查看并确认
                        </Button>
                    }
                />
            ))}
            <PublishReview
                plan={selected}
                onClose={() => setSelected(null)}
                onChanged={(p) => {
                    setSelected(p);
                    setPlans((items) => items.map((old) => (old.planId === p.planId ? p : old)).filter((item) => item.status.startsWith("awaiting_") || item.status === "uploading"));
                }}
            />
        </div>
    );
}
