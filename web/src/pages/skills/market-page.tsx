import { Alert, App, Button, Card, Input, Modal, Pagination, Select, Spin, Tabs } from "antd";
import { ArrowDownToLine, FilePlus2, Search, Upload } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { PageHeader, WorkspacePage } from "@/components/layout/workspace-page";
import { SkillInstallModal } from "./skill-install-modal";
import { SkillEditorDrawer } from "./skill-editor-drawer";
import { PublishReview } from "./publish-review";
import { deleteSkill, getSkill, listAddedSkills, type Skill } from "@/services/api/skills";
import {
    forkMarketSkill,
    disconnectPublishing,
    installMarketSkill,
    marketCatalog,
    marketRelease,
    marketSubmissions,
    marketVersions,
    openPublishingAuthorization,
    preparePublication,
    publishingAuthorization,
    publishingPlans,
    publishingStatusLabel,
    rollbackMarketSkill,
    startPublishingAuthorization,
    type MarketRelease,
    type PublishPlan,
    type Submission,
} from "@/services/api/skill-market";
import "./market.css";

export default function SkillMarketPage() {
    const { message, modal } = App.useApp();
    const [params, setParams] = useSearchParams();
    const [tab, setTab] = useState("discover");
    const [query, setQuery] = useState("");
    const [page, setPage] = useState(1);
    const [total, setTotal] = useState(0);
    const [releases, setReleases] = useState<MarketRelease[]>([]);
    const [local, setLocal] = useState<Skill[]>([]);
    const [plans, setPlans] = useState<PublishPlan[]>([]);
    const [submissions, setSubmissions] = useState<Submission[]>([]);
    const [connected, setConnected] = useState(false);
    const [authURL, setAuthURL] = useState("");
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [detail, setDetail] = useState<MarketRelease | null>(null);
    const [editor, setEditor] = useState<Skill | null | undefined>(undefined);
    const [installOpen, setInstallOpen] = useState(false);
    const [plan, setPlan] = useState<PublishPlan | null>(null);
    const [prepare, setPrepare] = useState<Skill | null>(null);
    const [license, setLicense] = useState("CC-BY-4.0");
    const [versions, setVersions] = useState<{ skill: Skill; rows: { id: string; versionLabel: string }[] } | null>(null);
    const [versionID, setVersionID] = useState("");
    const [link, setLink] = useState("");
    const refresh = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            const [installed, p, auth] = await Promise.all([listAddedSkills(), publishingPlans(), publishingAuthorization()]);
            setLocal(installed.skills);
            setPlans(p.items);
            setConnected(auth.connected);
            if (tab === "discover") {
                const r = await marketCatalog(query, page);
                setReleases(r.items);
                setTotal(r.total);
            }
            if (tab === "creations" && auth.connected) setSubmissions((await marketSubmissions()).items);
        } catch (e) {
            setError(e instanceof Error ? e.message : "暂时无法读取技能，请重试");
        } finally {
            setLoading(false);
        }
    }, [page, query, tab]);
    useEffect(() => {
        void refresh();
    }, [refresh]);
    useEffect(() => {
        if (!authURL || connected) return;
        let active = true;
        const timer = window.setInterval(() => {
            void publishingAuthorization()
                .then((r) => {
                    if (active && r.connected) {
                        setConnected(true);
                        setAuthURL("");
                        void refresh();
                    }
                })
                .catch((e) => {
                    if (active) setError(e instanceof Error ? e.message : "连接投稿账号未完成");
                });
        }, 5000);
        return () => {
            active = false;
            window.clearInterval(timer);
        };
    }, [authURL, connected, refresh]);
    useEffect(() => {
        const id = params.get("install"),
            version = params.get("version");
        if (!id || !version) return;
        let active = true;
        void marketRelease(id, version)
            .then((r) => {
                if (active) setDetail(r);
            })
            .catch((e) => {
                if (active) setError(e.message);
            });
        return () => {
            active = false;
        };
    }, [params]);
    const action = async (fn: () => Promise<void>) => {
        setBusy(true);
        setError("");
        try {
            await fn();
        } catch (e) {
            setError(e instanceof Error ? e.message : "操作未完成，请重试");
        } finally {
            setBusy(false);
        }
    };
    const authorize = () =>
        action(async () => {
            const r = await startPublishingAuthorization();
            setAuthURL(r.verificationUrl);
            await openPublishingAuthorization(r.verificationUrl);
        });
    const installed = (r: MarketRelease) => local.find((s) => s.sourceType === "market" && s.sourceRef === r.skillId);
    const closeDetail = () => {
        setDetail(null);
        if (params.has("install")) setParams({});
    };
    const edit = (s?: Skill) =>
        action(async () => {
            setEditor(s ? (await getSkill(s.skillId)).skill : null);
        });
    const openLink = () =>
        action(async () => {
            const u = new URL(link);
            if (!(u.protocol === "beeftv:" || (u.protocol === "https:" && u.hostname === "beeftv.app"))) throw new Error("请粘贴 BeefTV 技能安装链接");
            const id = u.searchParams.get("id") || u.searchParams.get("install"),
                v = u.searchParams.get("version");
            if (!id || !v) throw new Error("链接缺少技能版本，请从官网复制完整的安装链接");
            setDetail(await marketRelease(id, v));
        });
    return (
        <WorkspacePage className="skill-market-page">
            <PageHeader
                title="扩展"
                description="找到适合你的创作方法，也让好方法被更多人使用。"
                actions={
                    <div className="flex flex-wrap gap-2">
                        <Button icon={<Upload size={16} />} onClick={() => setInstallOpen(true)}>
                            导入文件
                        </Button>
                        <Button type="primary" icon={<FilePlus2 size={16} />} onClick={() => void edit()}>
                            创作技能
                        </Button>
                    </div>
                }
            />
            <Tabs
                activeKey={tab}
                onChange={(v) => {
                    setTab(v);
                    setPage(1);
                }}
                items={[
                    { key: "discover", label: "发现" },
                    { key: "installed", label: "已安装" },
                    { key: "creations", label: "我的创作" },
                ]}
            />
            {error && (
                <Alert
                    type="error"
                    showIcon
                    title={error}
                    action={
                        <Button size="small" onClick={() => void refresh()}>
                            重试
                        </Button>
                    }
                    className="mb-4"
                />
            )}
            {tab === "discover" && (
                <>
                    <div className="skill-market-toolbar">
                        <Input.Search
                            aria-label="搜索技能"
                            placeholder="想做出什么？"
                            allowClear
                            prefix={<Search size={16} />}
                            onSearch={(v) => {
                                setQuery(v);
                                setPage(1);
                            }}
                        />
                        <Input placeholder="粘贴技能安装链接" aria-label="技能安装链接" value={link} onChange={(e) => setLink(e.target.value)} />
                        <Button onClick={() => void openLink()} disabled={!link.trim()}>
                            查看链接
                        </Button>
                    </div>
                    {loading ? (
                        <Spin className="block py-12" />
                    ) : (
                        <div className="skill-market-grid">
                            {releases.map((r) => (
                                <Card key={r.releaseId} hoverable onClick={() => setDetail(r)} className="skill-market-card">
                                    <p className="skill-market-kicker">
                                        {r.author} · {r.versionLabel}
                                    </p>
                                    <h2>{r.name}</h2>
                                    <p>{r.description}</p>
                                    <div className="skill-market-card-footer">
                                        <span>免费安装</span>
                                        <Button size="small" type="text" icon={<ArrowDownToLine size={15} />}>
                                            {installed(r) ? (installed(r)?.sourceCommit === r.releaseId ? "已安装" : "可更新") : "查看技能"}
                                        </Button>
                                    </div>
                                </Card>
                            ))}
                        </div>
                    )}
                    {!loading && !releases.length && <p className="py-12 text-center text-muted-foreground">还没有匹配的技能，试试换一个关键词。</p>}
                    <Pagination current={page} total={total} pageSize={20} onChange={setPage} className="mt-6" hideOnSinglePage />
                </>
            )}
            {tab === "installed" && (
                <div className="skill-market-list">
                    {local.map((s) => (
                        <Card key={s.skillId}>
                            <div className="skill-market-row">
                                <div>
                                    <h2>{s.skillName}</h2>
                                    <p>{s.description}</p>
                                    <small>
                                        版本 {s.version} · {s.sourceType === "market" ? "来自技能市场" : "本地技能"}
                                    </small>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    <Button
                                        onClick={() => {
                                            setLicense(s.marketRelease?.license || "CC-BY-4.0");
                                            setPrepare(s);
                                        }}
                                    >
                                        投稿
                                    </Button>
                                    {s.sourceType === "market" && (
                                        <Button
                                            onClick={() =>
                                                void action(async () => {
                                                    const r = await forkMarketSkill(s.skillId);
                                                    await refresh();
                                                    await edit(r.skill);
                                                })
                                            }
                                        >
                                            复制并改写
                                        </Button>
                                    )}
                                    {s.sourceType === "market" ? (
                                        <Button
                                            onClick={() =>
                                                void action(async () => {
                                                    const v = await marketVersions(s.skillId);
                                                    setVersions({ skill: s, rows: v.versions });
                                                    setVersionID(s.versionId);
                                                })
                                            }
                                        >
                                            版本管理
                                        </Button>
                                    ) : (
                                        <Button onClick={() => void edit(s)}>编辑</Button>
                                    )}
                                    <Button
                                        danger
                                        onClick={() =>
                                            modal.confirm({
                                                title: `移除「${s.skillName}」？`,
                                                content: "已生成的作品和素材会保留。",
                                                onOk: async () => {
                                                    await deleteSkill(s.skillId);
                                                    await refresh();
                                                },
                                            })
                                        }
                                    >
                                        移除
                                    </Button>
                                </div>
                            </div>
                        </Card>
                    ))}
                    {!local.length && !loading && <p>还没有安装技能。去发现页选一个，或导入自己的文件。</p>}
                </div>
            )}
            {tab === "creations" && (
                <div className="space-y-4">
                    <Card
                        title="投稿账号"
                        extra={
                            connected ? (
                                <Button
                                    onClick={() =>
                                        void action(async () => {
                                            await disconnectPublishing();
                                            setConnected(false);
                                            setSubmissions([]);
                                        })
                                    }
                                >
                                    断开连接
                                </Button>
                            ) : (
                                <Button type="primary" loading={busy} onClick={() => void authorize()}>
                                    连接账号
                                </Button>
                            )
                        }
                    >
                        <p>{connected ? "已连接，可以上传私人稿件并送审。" : "连接账号后，可将本地技能提交到市场。"}</p>
                        {authURL && (
                            <p className="mt-2">
                                <a href={authURL} target="_blank" rel="noreferrer">
                                    打开授权页面
                                </a>
                                ，确认后回到这里。
                            </p>
                        )}
                    </Card>
                    <h2 className="text-base font-semibold">待确认的投稿</h2>
                    {plans.map((p) => (
                        <Card key={p.planId}>
                            <div className="skill-market-row">
                                <div>
                                    <h3>{p.metadata.name}</h3>
                                    <p>{publishingStatusLabel[p.status] || p.status}</p>
                                </div>
                                <Button onClick={() => setPlan(p)}>查看文件与预览</Button>
                            </div>
                        </Card>
                    ))}
                    <h2 className="text-base font-semibold">审核与发布</h2>
                    {submissions.map((s) => (
                        <Card key={s.submissionId}>
                            <h3>{s.metadata.name}</h3>
                            <p>{publishingStatusLabel[s.status] || s.status}</p>
                            {s.reviewReason && <Alert type="warning" title={s.reviewReason} />}
                            <a href={`https://beeftv.app/skills/publish?submission=${encodeURIComponent(s.submissionId)}`} target="_blank" rel="noreferrer">
                                继续编辑投稿
                            </a>
                        </Card>
                    ))}
                    <p className="text-sm text-muted-foreground">也可以让创作助手把方法整理成技能并准备投稿。外部 AI 助手可在官网选择“通过对话投稿”。</p>
                </div>
            )}
            <Modal
                open={Boolean(detail)}
                title={detail?.name}
                onCancel={closeDetail}
                footer={
                    <>
                        <Button onClick={closeDetail}>关闭</Button>
                        <Button
                            type="primary"
                            loading={busy}
                            onClick={() =>
                                void action(async () => {
                                    if (!detail) return;
                                    await installMarketSkill(detail.skillId, detail.releaseId);
                                    message.success("技能已安装，可在画布助手中选择使用");
                                    await refresh();
                                    closeDetail();
                                })
                            }
                        >
                            {detail && installed(detail) ? (installed(detail)?.sourceCommit === detail.releaseId ? "重新安装" : "更新到此版本") : "安装技能"}
                        </Button>
                    </>
                }
            >
                {detail && (
                    <div className="space-y-4">
                        <p>{detail.description}</p>
                        <p>
                            {detail.author} · {detail.versionLabel} · {detail.license}
                        </p>
                        {detail.showcase?.map((m) => (
                            <figure key={m.url}>
                                {m.type === "video" ? <video src={m.url} controls className="w-full rounded-lg" /> : <img src={m.url} alt={m.caption} className="w-full rounded-lg" />}
                                <figcaption>{m.caption}</figcaption>
                            </figure>
                        ))}
                        <Alert type="info" title="技能免费安装；使用模型生成内容可能产生费用，执行前会另行确认。" />
                        {detail.requirements?.length > 0 && <Alert type="warning" title="使用前需要准备" description={detail.requirements.join("、")} />}
                        <ul>
                            {detail.files.map((f) => (
                                <li key={f.path} className="break-all text-sm">
                                    {f.path}
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </Modal>
            <Modal
                open={Boolean(prepare)}
                title="准备投稿"
                onCancel={() => setPrepare(null)}
                onOk={() =>
                    void action(async () => {
                        if (!prepare) return;
                        const p = await preparePublication(prepare.skillId, { license });
                        setPrepare(null);
                        setPlan(p);
                        await refresh();
                    })
                }
                confirmLoading={busy}
                okText="查看待上传文件"
            >
                <p className="mb-3">{prepare?.skillName}，请选择允许其他人如何使用这份技能。</p>
                <Select
                    aria-label="技能许可证"
                    value={license}
                    onChange={setLicense}
                    options={[
                        ...(!["CC-BY-4.0", "CC0-1.0", "MIT"].includes(prepare?.marketRelease?.license ?? "") && prepare?.marketRelease?.license ? [{ value: prepare.marketRelease.license, label: `保留原许可 (${prepare.marketRelease.license})` }] : []),
                        { value: "CC-BY-4.0", label: "署名后可使用与修改 (CC BY 4.0)" },
                        { value: "CC0-1.0", label: "无保留贡献 (CC0)" },
                        { value: "MIT", label: "MIT" },
                    ]}
                    className="w-full"
                />
                <p className="mt-3 text-sm text-muted-foreground">下一步会展示文件清单，此时还不会上传。</p>
            </Modal>
            <Modal
                open={Boolean(versions)}
                title="技能版本"
                onCancel={() => setVersions(null)}
                onOk={() =>
                    void action(async () => {
                        if (versions) {
                            await rollbackMarketSkill(versions.skill.skillId, versionID);
                            setVersions(null);
                            await refresh();
                        }
                    })
                }
                okText="使用所选版本"
                confirmLoading={busy}
            >
                <Select aria-label="选择技能版本" className="w-full" value={versionID} onChange={setVersionID} options={versions?.rows.map((v) => ({ value: v.id, label: v.versionLabel }))} />
                <p className="mt-4 text-sm text-muted-foreground">正在进行的创作继续使用原先选择的版本。</p>
            </Modal>
            <PublishReview
                plan={plan}
                onClose={() => setPlan(null)}
                onChanged={(p) => {
                    setPlan(p);
                    void refresh();
                }}
            />
            <SkillInstallModal
                open={installOpen}
                onClose={() => setInstallOpen(false)}
                onInstalled={() => {
                    setInstallOpen(false);
                    void refresh();
                }}
                onManualCreate={() => {
                    setInstallOpen(false);
                    setEditor(null);
                }}
            />
            <SkillEditorDrawer
                open={editor !== undefined}
                skill={editor ?? null}
                onClose={() => setEditor(undefined)}
                onSaved={() => {
                    setEditor(undefined);
                    void refresh();
                }}
            />
        </WorkspacePage>
    );
}
