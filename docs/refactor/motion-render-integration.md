# Motion 模板本地渲染接入设计

状态:设计稿(基于 2026-10-15 Windows 本机原型验证,未实现)。原型证据:kinetic-tech 0.2.7 模板在 Edge headless + ffmpeg 8 下渲染 18s 中文片头成功,产物已经 `PUT /api/canvas-projects/:id/generated-assets` 入 bazong-pets-e01 画布(rev 673,节点 `title-card-E01`)。

## 目标与边界

用开源 `.motion` 模板(MotionGit 规范 0.1.0-draft,如 kinetic-tech)在本地确定性渲染片头/看点卡/字幕条类动效:零 GPU、同 inputs 逐帧可复现,与 ComfyUI 生成链互补。不做在线模板市场;第一版只支持本地导入模板包。渲染合同是模板 runtime 的 `renderFrame(frame, inputs)`(HTML Canvas 逐帧),协议参考 https://motiongit.com/spec 。

## 三层架构

| 层 | 载体 | 职责 |
| --- | --- | --- |
| 模板资产 | `<dataDir>/motion-templates/<templateId>/<versionId>/` | 解包后的模板 + 元数据(params.schema.json、integrity digest、runtime 入口) |
| 渲染任务 | 新任务类型 `motion_render` + op `canvas.motion.render` | 沙箱子进程执行模板渲染,产物走现有交付链 |
| 助手技能 | 现有技能包服务(SKILL.md 文本) | 指南文本:业务字段(剧名/看点/素材)→ 模板 params 的映射知识 |

关键原则:LLM 不参与逐帧渲染。agent 只做参数映射与调参;渲染是纯代码任务,免费、可重放。

## 已核实的集成点(现状代码)

- 新增授权操作:`backend/internal/operations/ops.go:17` RegisterDefaultOps 注册;助手可见需登 `backend/internal/agentops/scope.go:31-48` 白名单;写操作自动获得 operationId 幂等(`operations/registry.go:109-145`)。
- 新增本地任务类型:`backend/internal/model/timeline_task_type.go:6-10` 加常量 → `backend/internal/task/specialized.go` 输入契约 + Create 方法 → `backend/internal/app/task_worker.go:89-94` 加分叉 + `:286-302` 超时分支。
- 子进程先例(二选一仿写):
  - worker 内一次性子进程 + stdout 进度流:`backend/internal/depthcapture/command.go:62-116`(python -m,退出码分类);
  - Go 常驻拉起 Node + env 注入:`backend/internal/assistantruntime/{config,process,env}.go`(BEEFTV_OPS_URL 指回后端)。
- 产物物化三段式(照抄 timeline_render):`backend/internal/app/task_render.go:22-99` 的 `RecoverOwned(taskID:0)` 写 resource → ResultJSON → `SaveTaskCompletion` + `DeliverSucceededTask`(`app/task_delivery.go`)→ `canvas.task.bind`(`operations/task_bind.go`,领域校验 `internal/taskbinding/bind.go`)。无 TargetBinding 的任务不自动绑节点,渲染 op 需显式带绑定意图或让前端二次调 bind。
- 素材归属校验:仿 `operations/canvas_timeline.go:67-178` 的 `timelineSources`——槽位引用只接受画布节点/已保存时间线关联的 `OwnedReadyResource` + asset,模型给的 assetId 不作为归属依据。
- ffmpeg 版本:桌面打包钉 **FFmpeg 8.0.1**(`scripts/package-media-runtime-windows.ps1:9-11`,manifest.json 记录),满足模板渲染要求的 ≥8.0(scale 滤镜 in_primaries/out_transfer 色彩选项,FFmpeg 8.0 加入)。开发机需自带或设 `CANVAS_FFMPEG_PATH`。
- 技能包模型:`backend/internal/skills/agent_resources.go` pin(skillId/versionId/contentHash)校验、正文 ≤64KiB;`scripts/` 前缀文件标记 `unsupportedCapabilities=["script_execution"]` —— **技能层只放指南文本,渲染器永远不进技能包**。

## 模板资产层

- 导入:上传 `.motion`(ZIP)→ 校验 motion.json(specVersion/template id+version/params schema 路径)→ 解包落盘 → 生成版本 pin(templateId + versionId + 内容 digest,digest 口径仿 `skills/skill_packages.go:723-747` 对排序文件清单做 SHA256)。
- 元数据投影:params.schema.json 原文存档并提供给前端(表单生成)与 agent(映射依据);记录 runtime 依赖声明(如 kinetic-tech 需要 Node22+、Python3.11+、uv、ffmpeg、Chrome/Edge)。
- 版本策略:同 templateId 多版本并存,任务 InputJSON 钉死 versionId + digest;digest 不匹配拒绝执行(防模板文件被改后重放旧任务)。

## 渲染任务层(motion_render)

- InputJSON 契约(MotionRenderInput):`{templatePin, params(经 params.schema 校验的 JSON), slots: {角色名 → 画布 resource 引用}, targetBinding?}`。`mode:"user-media"`、语言/布局由 params 内字段表达(注意 kinetic-tech 的 `language` 钉 `"en"` 但文本字段支持中文,已实测)。
- 执行(方案 A,首版):worker 内 spawn `uv run adapter.py prepare/render`(`depthcapture/command.go` 模式:stdout 逐行进度、退出码分类)。前置依赖 Python3.11+/uv/Node22+/Chromium 声明在模板元数据,缺依赖时任务失败并给出可读原因。取舍:adapter 是模板官方入口,免重实现;代价是运行时依赖重。方案 B(打包期):用 Go 直写 instance 构建与 `render.mjs` 等价驱动(本地 127.0.0.1 HTTP + headless Chromium 逐帧 + ffmpeg 管道),去掉 Python 依赖——留给桌面打包阶段决策,接口不变。
- 沙箱边界:子进程 cwd=任务临时目录;env 白名单(不透传后端凭据/owner token);渲染进程网络自封(模板 render.mjs 自带 127.0.0.1 本地服务,Chromium `--disable-gpu` headless);素材先经 `OpenResource` 授权读出落盘再供模板消费;产物只回收 instance 输出目录的 mp4。
- 浏览器发现:仿模板 `chrome.mjs` 的候选序(Chrome/Edge 标准路径 + `CHROME` 覆盖),桌面环境已有 Edge 即可用。

## 操作层(canvas.motion.render)

- 入参:canvasId、expectedRevision(CAS)、templatePin、params、slots、targetBinding(nodeId)。
- 流程:读画布 → revision CAS → 槽位素材归属校验(仿 timelineSources)→ params 对模板版本 schema 校验(JSON Schema Draft 2020-12,Go 侧引入或预校验后存)→ 建任务 → 返回 taskId。
- 撤销:操作 receipts 已覆盖任务创建回滚(参考 agent-local-render 验收的模式)。

## 助手技能层

- 把模板的 guide.json/CREATION.md 精简为 SKILL.md(中文,≤64KiB),上架现有技能包服务;agent 会话内 pin 选定版本。
- agent 工作流:读技能指南 → 从剧集数据(title/shots 台词,如 `.local/episodes/e0N.json` 的字段)构造 params → 调 `canvas.motion.render` → 轮询任务 → 预览不满意改参数重调。不新增模型会话循环,复用 `/api/assistant/*`。

## 实施切片与验收

- 切片 A(后端闭环):模板导入 API + motion_render 任务 + canvas.motion.render op + 手动 JSON 触发。验收:同 inputs 两次渲染产物帧级一致;未授权素材槽位被拒;任务失败路径可读;产物绑节点可在画布播放。
- 切片 B(前端):模板库页(列表/导入/版本)+ params.schema 驱动表单 + 渲染任务进度复用现有任务 UI。
- 切片 C(助手):指南技能上架 + scope 白名单登记 + 面板端到端("给 E02 生成片头")。
- 每片按验证纪律记证据;涉及数据库新表时同步 `docs/content/docs/backend/backend-database.mdx`。

## 已知风险

- 模板 runtime 依赖(Python/uv)对桌面打包的重量;方案 B 可消除但工作量另计。
- `.motion` 规范仍是 0.1.0-draft:导入层按 templateId+specVersion 白名单放行,未知 specVersion 拒绝并提示。
- 第三方模板 JS 是不可信代码:沙箱边界(无凭据、无外网、目录受限)是硬要求,评审时逐条对照。
