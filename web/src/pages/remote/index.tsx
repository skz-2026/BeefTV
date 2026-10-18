import { useCallback, useEffect, useState } from "react";
import { Button, QRCode, Spin } from "antd";
import { CheckCircle2, Copy, ExternalLink, RefreshCw, Smartphone, XCircle } from "lucide-react";
import { Link } from "react-router";

import { getRemoteAccess, type RemoteAccessStatus } from "@/services/api/remote-access";

const REASON_TEXT: Record<string, string> = {
    tailscale_not_found: "这台机器没有找到 Tailscale 命令行。先安装 Tailscale 并登录，再回到本页刷新。",
    tailscale_not_running: "Tailscale 没有运行，或者服务还没就绪。启动 Tailscale 后刷新本页。",
    tailscale_not_logged_in: "这台机器还没有加入 tailnet。在 Tailscale 里登录后刷新本页。",
    tailscale_unreadable: "Tailscale 返回的状态无法解析，请更新 Tailscale 后重试。",
};

/**
 * 手机访问入口：显示本机 tailnet 地址和二维码。
 * 页面只读后端 /api/remote/access 的状态，不参与任何流量转发。
 */
export default function RemoteAccessPage() {
    const [status, setStatus] = useState<RemoteAccessStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);
    const [copied, setCopied] = useState(false);

    const load = useCallback(async (signal?: AbortSignal) => {
        setLoading(true);
        setFailed(false);
        try {
            setStatus(await getRemoteAccess(signal));
        } catch {
            if (!signal?.aborted) setFailed(true);
        } finally {
            if (!signal?.aborted) setLoading(false);
        }
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        void load(controller.signal);
        return () => controller.abort();
    }, [load]);

    const url = status?.available ? status.url : undefined;

    const copy = async () => {
        if (!url) return;
        try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1600);
        } catch {
            setCopied(false);
        }
    };

    return (
        <div className="min-h-dvh bg-background text-foreground">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-10 sm:px-8">
                <header className="flex flex-col gap-2">
                    <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        <Smartphone className="size-4" />
                        手机访问
                    </div>
                    <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">用手机扫码打开 BeefTV</h1>
                    <p className="max-w-xl text-sm leading-6 text-muted-foreground">
                        手机和这台机器登录同一个 Tailscale 账号即可。二维码指向本机的 tailnet 地址，不在 tailnet 里的设备打不开。
                    </p>
                </header>

                <section className="grid gap-6 rounded-3xl border border-border bg-card/60 p-5 sm:grid-cols-[auto_1fr] sm:p-7">
                    <div className="flex flex-col items-center gap-3">
                        <div className="flex min-h-[236px] min-w-[236px] items-center justify-center rounded-2xl bg-white p-3 shadow-sm">
                            {loading ? <Spin /> : url ? <QRCode value={url} size={210} bordered={false} color="#0f0f0f" bgColor="#ffffff" /> : <XCircle className="size-10 text-neutral-400" />}
                        </div>
                        <span className="text-xs text-muted-foreground">{url ? (status?.serveOn ? "扫描后直接进入工作区" : "扫码前先开启 Tailscale Serve") : "等待检测"}</span>
                    </div>

                    <div className="flex min-w-0 flex-col gap-4">
                        {failed ? (
                            <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">读取远程访问状态失败，请确认后端已启动。</div>
                        ) : null}

                        {!loading && status && !status.available ? (
                            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm leading-6 text-amber-700 dark:text-amber-200">{REASON_TEXT[status.reason || ""] || "Tailscale 当前不可用。"}</div>
                        ) : null}

                        {url ? (
                            <div className="flex flex-col gap-2">
                                <span className="text-xs font-medium text-muted-foreground">地址</span>
                                <div className="flex items-center gap-2 rounded-xl border border-border bg-background px-3 py-2">
                                    <code className="min-w-0 flex-1 break-all text-xs sm:text-sm">{url}</code>
                                    <Button size="small" type="text" icon={<Copy className="size-4" />} onClick={copy} aria-label="复制地址">
                                        {copied ? "已复制" : "复制"}
                                    </Button>
                                </div>
                                {status?.servePort && status.servePort !== 443 ? <p className="text-xs text-muted-foreground">T3 Code 占用 tailnet 的 443，BeefTV 发布在 {status.servePort} 端口，两个服务互不影响。</p> : null}
                            </div>
                        ) : null}

                        <div className="flex flex-col gap-2 text-sm">
                            <StatusRow label="Tailscale 已登录" on={Boolean(status?.available)} />
                            <StatusRow label="MagicDNS 已开启" on={Boolean(status?.magicDns)} />
                            <StatusRow label="Serve 已发布到 tailnet" on={Boolean(status?.serveOn)} />
                        </div>

                        {status?.available && !status.serveOn ? (
                            <div className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm leading-6">
                                还没把这个端口发布到 tailnet。在这台机器上执行：
                                <code className="mt-1 block rounded bg-background px-2 py-1 text-xs">tailscale serve --bg --https=8443 http://127.0.0.1:3000</code>
                            </div>
                        ) : null}

                        <div className="mt-auto flex flex-wrap items-center gap-2">
                            <Button icon={<RefreshCw className="size-4" />} onClick={() => void load()} loading={loading}>
                                重新检测
                            </Button>
                            <Link to="/">
                                <Button type="primary" icon={<ExternalLink className="size-4" />}>打开工作区</Button>
                            </Link>
                        </div>
                    </div>
                </section>

                <section className="grid gap-3 rounded-2xl border border-border bg-card/40 p-5 text-sm leading-6 sm:grid-cols-3 sm:gap-5">
                    <Step index={1} title="手机装 Tailscale" detail="登录和这台机器相同的账号，确认设备列表里能看到本机。" />
                    <Step index={2} title="相机扫码" detail="直接用系统相机扫二维码，用浏览器打开，不需要安装 App。" />
                    <Step index={3} title="添加到主屏幕" detail="Safari 分享菜单或 Chrome 菜单里选择“添加到主屏幕”，下次点图标即可。" />
                </section>

                <footer className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>本机地址：{status?.localUrl || "http://127.0.0.1:3000/"}</span>
                    <span>二维码只在你自己的 tailnet 内有效。</span>
                </footer>
            </div>
        </div>
    );
}

function StatusRow({ label, on }: { label: string; on: boolean }) {
    return (
        <div className="flex items-center gap-2">
            {on ? <CheckCircle2 className="size-4 text-emerald-500" /> : <XCircle className="size-4 text-muted-foreground" />}
            <span className={on ? "" : "text-muted-foreground"}>{label}</span>
        </div>
    );
}

function Step({ index, title, detail }: { index: number; title: string; detail: string }) {
    return (
        <div className="flex gap-3">
            <span className="grid size-6 shrink-0 place-items-center rounded-full border border-border text-xs font-semibold">{index}</span>
            <div className="min-w-0">
                <div className="font-medium">{title}</div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
            </div>
        </div>
    );
}
