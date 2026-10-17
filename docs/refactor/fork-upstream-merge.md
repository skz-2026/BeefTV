# Fork 与上游合并指南（客制化分歧管理）

本仓库是 `glanderness/BeefTV` 的客制化 fork。本文记录 fork 相对上游的分歧清单、收敛原则和已验证的合并手册，目标是让每次合入 upstream 只需按清单机械执行，不需要重新考古。

现状快照（2026-10-17 合入 v1.7.24 后）：135 个 fork 独有文件、79 个对上游文件的就地修改。用下面命令随时刷新清单：

```bash
git diff upstream/main main --name-status   # M=就地修改（冲突面），A=fork 独有（零冲突）
```

## 分歧清单（按合并风险分级）

### A 级：上游高频迭代 × 我们就地修改（每次合并预期冲突）

| 位置 | 客制化内容 | 合并口径 |
| --- | --- | --- |
| `plugin-packages/openai-videos/` | 保留多参考图（≤7）/参考音频（≤3）透传与 `providerOptions.newapi` 采样参数，服务本地 ComfyUI/newapi 网关；上游方向是面向官方 Sora API 收紧到单图 | 两边功能并集；上游新增校验只吸收"防素材静默丢弃"思想，数量上限对齐我们的文件槽位；改完跑 `embed-documentation.mjs` + 重建产物 + 同步 `backend/internal/protocol/video_json_test.go` 契约断言 |
| `web/src/router.tsx` | `/prompt-library` 等成书路由 | 保留我们的行，采纳上游新路由 |
| `web/src/components/layout/workspace-sidebar-nav.tsx` | 侧栏四个成书入口 + 参考库 | import 取并集（含上游新增图标），导航项两边叠加 |
| `web/src/components/canvas/canvas-node-prompt-panel.tsx` | 头部"参考库"按钮 | 与上游字号控制等新按钮叠加 |
| `web/src/lib/model-service-presets.ts` + `web/src/stores/use-config-store.ts` | 本机 loopback 渠道免密钥豁免（声线工坊/ComfyUI 网关） | 与上游 `authType:"none"` 协议豁免双机制并存；两处豁免逻辑保持一致 |
| `web/src/services/model-config-repository.ts` | 保存冲突用"最新本地状态"重试（防旧快照覆盖其他标签页） | 保留我们的语义，用上游带确认校验的 `write` 包装 |
| `backend/internal/handler/api.go` | motion 模板路由注册 | 两边路由叠加 |
| `backend/internal/task/`（contracts/specialized/identity/ports/lifecycle） | timeline 本地渲染与 motion 渲染任务类型 | 两边任务类型叠加 |
| `backend/internal/editing/` | Overlays 叠加层渲染管线 | 上游管线重构时保留 Overlays 数据结构与编译步骤 |
| `backend/internal/mediatools/ffmpeg.go` | `ResolveFFprobe` 的"与 CANVAS_FFMPEG_PATH 同目录优先"语义 | 融合口径：我们的同目录探测在前，上游 `resolveTool` 通用链在后；`process_*.go`（HideConsole）必须保留 |
| `backend/go.mod` | gopsutil 等自有依赖 | 取上游版本号 + 保留自有依赖，`go mod tidy` 收敛 |
| `backend/internal/generation/image_recovery.go` | `PaidImageHost` 计费保护（被 `app/image_submission.go` 使用） | `RecoverableImageEndpoint` 用上游协议协商版，`PaidImageHost` 保留 |

### B 级：计数/夹具漂移（机械修复）

| 位置 | 合并动作 |
| --- | --- |
| `backend/internal/agentops/scope_test.go` | 目录计数对齐：nil=35、canvas=31、full-access=34、read-only 随上游 |
| `backend/internal/operations/registry_list_test.go`、`caller_identity_test.go` | 能力计数 35（= 上游 op 数 + canvas.motion.render） |
| `agent-host/operation-descriptors.fixture.json` | `UPDATE_HOST_POLICY_FIXTURE=1 go test ./internal/operations/ -run TestHostPolicyContract` 重新生成 |
| `backend/internal/handler/openapi.yaml` | 随路由手工同步 |
| `web/bun.lock`、`backend/go.sum` | `bun install` / `go mod tidy` 后自然对齐 |

### C 级：fork 独有（新增文件，零冲突）

`backend/internal/motion/`、`app/motion_templates.go`、`task_motion.go`、`operations_motion_adapter.go`、`handler/motion_templates.go`、`operations/canvas_motion.go`、`operations/canvas_render.go`、`canvas_timeline.go`；`web/src/pages/digital-human-book/`、`storybook-book/`、`prompt-library/`、`comic-books/`、`lib/dh-cards.ts`；`.local/` 本地短片流水线。

## 结构原则（让 A 级不再增长）

1. **新能力一律走新增文件**。操作注册用 `AssistantCanvas`/`ReplaySafe` 标记挂在 fork 自己的 op 文件上（如 `canvas_motion.go`），不回去改 `agentops/scope.go`——上游的可见策略已下沉到 op 标记，标记即注册。
2. **热点注入点收敛为 fork 专有模块**。侧栏入口/路由表、loopback 免密钥豁免、参考库按钮，后续重构方向是抽成 `web/src/lib/fork-*` 模块再被上游文件 import，把"逻辑冲突"降级为"一行 import 冲突"。
3. **不删上游文件**。删任何上游文件前先 `git log --oneline <merge-base>..HEAD -- <file>` 溯源；曾发生误删 `process_windows.go` 导致静默合并丢失（合并对"我方删除"不报冲突）。
4. **openai-videos 是最高摩擦点**。若上游持续收紧，备选方案是把 fork 版本改名为独立插件 id（需迁移已保存渠道配置，代价另评估）；在此之前按 A 级口径手工融合。
5. **改 `AGENTS.md` 等上游强约定文件要克制**，每加一行都是未来合并面。

## 合并手册（2026-10-17 全流程验证过）

```bash
# 1. 直连 GitHub 拉上游（gitclone 镜像可能滞后数周；-c 长前缀自映射绕过全局 insteadOf 改写）
git -c url."https://github.com/glanderness/".insteadOf="https://github.com/glanderness/" \
  fetch https://github.com/glanderness/BeefTV.git main
git update-ref refs/remotes/upstream/main FETCH_HEAD

# 2. 试合并评估（不碰工作区）
git merge-tree --write-tree --name-only HEAD upstream/main

# 3. 真合并在分支上做
git checkout -b merge/upstream-YYYYMMDD && git merge --no-ff upstream/main
#    解冲突按上面 A/B 级清单逐项核对

# 4. 必做收尾
cd backend && GOPROXY=https://goproxy.cn,direct go mod tidy && go build ./...
cd ../web && bun install && bun run build
cd .. && node plugin-packages/embed-documentation.mjs   # 改过插件源码时
#    重建 .beeftv-plugin 产物（无 zip 命令时用等价 Go 打包器，见下）

# 5. 测试甄别 + 冒烟后并回 main 推送
```

Windows 下没有 `zip` 命令，`plugin-packages/build-packages.sh` 会失败；用一次性 Go 程序等价替代（archive/zip，同样按排序清单、deflate），或装 zip 后直接跑脚本。

### 静默删除扫描

合并后跑一遍文件清单比对，揪出"我方删除 × 上游保留"的静默丢失（本次靠它发现 process_*.go）：

```bash
MB=$(git merge-base HEAD upstream/main)
git ls-tree -r $MB --name-only | sort > /tmp/s-mb.txt
git ls-tree -r upstream/main --name-only | sort > /tmp/s-up.txt
git ls-tree -r <合并前HEAD> --name-only | sort > /tmp/s-ours.txt
git ls-tree -r HEAD --name-only | sort > /tmp/s-merged.txt
comm -12 /tmp/s-mb.txt /tmp/s-up.txt > /tmp/s-exist.txt
comm -23 <(comm -23 /tmp/s-exist.txt /tmp/s-ours.txt) /tmp/s-merged.txt   # 输出即丢失文件
```

## Windows 测试基线（环境固有失败，勿当合并回归追查）

以下失败在**合并前的代码上同样出现**，属于 Windows 环境限制，合并时不必修复：

- SQLite 临时目录锁：大量 `TempDir RemoveAll cleanup ... being used by another process`（测试功能断言本身通过）。
- Unix 权限断言：`0600`/`666` 权位（Windows chmod 语义不同）。
- symlink 特权：`A required privilege is not held by the client`（需开发者模式）。
- `/bin/sh` 夹具：editing 的 native_ffmpeg 测试。
- 环境变量大小写：desktopnet/depthcapture 的代理测试（Windows env 名不区分大小写，`HTTPS_PROXY`/`https_proxy` 互覆）。
- 需要外部工具/产物：ffmpeg 不在 PATH 的探测类测试、需构建 `beeftv` CLI 的集成测试、未重建的 `.beeftv-plugin` 产物测试。

判别方法：`git worktree add ../premerge <合并前commit>` 后在同一包上跑对照，两边同败即环境问题。
