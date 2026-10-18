# ACP Agent Host 落地方案（BeefTV 调用 Codex / ZCode）

日期：2026-10-18。状态：P0/P1 已实现，P2 完成（provider 门禁、模型显示、界面标签、技能、图片/视频附件、提案、打包）；崩溃/断网恢复与 ZCode 真实 prompt 仍待验收。范围：让内置创作助手由 Codex / ZCode 这类外部 coding agent 驱动，而不是让它们反过来通过 MCP 调用 BeefTV。

## 0. 一句话

新增一个 **fork 独有、与现有 pi 宿主同协议** 的 `agent-host/ACP/acp-host.mjs`：Go 仍按 `agent_config.json` 拉起宿主，宿主改用 [Agent Client Protocol](https://agentclientprotocol.com/) 驱动 Codex / ZCode，BeefTV 的业务工具通过一个 stdio MCP 桥回到 Go 的 `/api/ops`。上游文件只动打包白名单一行（可选再加约 20–30 行 Go 让 ACP 模式不依赖 BeefTV 模型）。

## 1. 为什么选这个切法

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| 在 pi 宿主里加一个 `codex_delegate` 工具 | 不采用 | 只是把 Codex 当子工具，编排仍是 pi；而且要在上游 `operation-bridge.mjs` / `durable-session-owner.mjs` 里加工具，属 A 级冲突面 |
| 改 pi 宿主内核，把 Durable 换成 ACP | 不采用 | `agent-host/*` 是上游高频文件（首提交 #64，2026-10-14 / 10-17 仍在改），改内核等于每次合并重做 |
| 另起一个 Codex 面板 + 新 Go 路由 | 不采用 | 绕开 Go 回合/权限/撤销，UI 与业务授权要重做一份 |
| **同协议的 ACP 宿主（本方案）** | 推荐 | 换宿主不换契约：Go 的回合、权限、撤销、操作回执全部复用；上游只多一个目录 |

关键事实：现有 `HostConfig` 已经允许指定宿主启动命令（[config.go](../../backend/internal/assistantruntime/config.go)），Go 只通过 HTTP 调宿主，不关心宿主内部是什么。因此“换内核”可以做到 **Go / React / 上游 host 零改动**。

### 1.1 为什么是 ACP，而不是直接调 `codex exec` / `app-server`

| 通道 | 为什么不选 |
| --- | --- |
| `codex exec --json` | 每轮一个进程，没有权限通道；工具只能靠 `config.toml` 静态挂 MCP，拿不到“每会话一份 BeefTV 工具 + 当前回合”的注入点；也没有 mid-turn 取消/恢复的细粒度事件 |
| `codex app-server` | 能力最全，但只服务 Codex；换 ZCode / Claude 要再写一套，且其 JSON-RPC 仍在演进 |
| **ACP** | Codex / ZCode / Claude 都有现成 ACP 适配器；`session/new` 可带每会话 `mcpServers`；有 `request_permission` 通道；codex-acp 已声明 `session resume`。一套适配器覆盖多家，且协议有公开规范 |

## 2. 现有约束（读代码得到的事实）

- 宿主是 Go 的子进程，Go 注入端口、`BEEFTV_AGENT_HOST_TOKEN`、`BEEFTV_AGENT_*` 模型凭据和 ops 地址；宿主监听本机 HTTP。
- Go 对宿主暴露的入口：`/health`、`/sessions`（GET/POST）、`/sessions/activate`、`/active`、`/history`、`/chat`、`/cancel`、`/steer`、`/tools`、`/skill-context`。
- `/chat` 请求体由 Go 补齐 `turnId`、`revisionBefore`、`references`、`permissionMode`；宿主必须先 `GET /assistant/runtime/turns/:turnId` 校验回合存在、仍开放、canvas 匹配，不能自报权限。
- 宿主回 `application/x-ndjson`：`session`、`text_delta`、`lifecycle`（tool / tool_end），最后恰好一条 `turn_end`，且 `turnId` 必须与 Go 注入的一致，否则 Go 不结算。
- 工具调用由宿主带 `X-Beeftv-Agent-Token` + `X-Beeftv-Agent-Turn` 打到 Go 的 `/api/ops`；`operation-bridge.mjs` 负责 scope、幂等键、写链 rebase、效果收集（`collectTurnEffects` 会自动生成 `change` 和 `proposals`）。
- `/assistant/status` 在 `ResolveProvider()` 失败时直接返回不可用，并且不会拉起宿主。也就是说：即使 Codex 用不到 BeefTV 的模型，也必须先配一个文本模型（或做第 9 节的小补丁），宿主才会启动。
- host 与 Go 的认证是双头的：`X-Beeftv-Agent-Token` + `X-Beeftv-Instance-Nonce`；`/health` 返回 `instance = sha256(nonce)[:16]`，Go 用它证明“这是我拉起的那个实例”。

## 3. 目标架构

```
BeefTV Web (React)
   │  /api/assistant/chat  (NDJSON, 原样)
   ▼
Go backend ────────────────┐  回合、权限、ops、撤销、付费确认
   │  启动子进程 + token/port │
   ▼                        │
agent-host/ACP/acp-host.mjs│  ← C 级新文件，实现与 pi 宿主相同的 HTTP/NDJSON
   │  ACP (JSON-RPC over stdio)  │
   ▼                        │
codex-acp / zcode-acp       │
   │  MCP (stdio, 每会话一个)   │
   ▼                        │
agent-host/ACP/beef-mcp.mjs│
   │  本机回环 HTTP + 会话级 token
   └────────────────────────┘
          POST /api/ops/:op  (带 turnId)
```

要点：

1. **换的是“模型循环”，不是“业务权威”**。画布读写仍然只经过 Go 的 operation 层。
2. **工具身份仍是内置助手**。MCP 桥用的是宿主持有的 host token 和当前 `turnId`，不是外部客户端凭据，所以 `assistant` 回合、undo、提案、权限模式全部照旧。
3. **ACP 只做传输**。Codex 的原生工具（shell、文件读写）默认关闭；BeefTV 工具才是它的工具面。

## 4. 组件与文件

全部为新增文件，放在 `agent-host/ACP/`：

| 文件 | 责任 |
| --- | --- |
| `acp-host.mjs` | HTTP/NDJSON 适配器：实现第 2 节的宿主契约；鉴权、实例 nonce、健康检查、每画布串行队列 |
| `acp-client.mjs` | 最小 ACP 客户端：spawn agent、JSON-RPC framing、initialize、session/new、session/prompt、session/cancel、session/load/resume、request_permission 应答、进程退出处理 |
| `acp-events.mjs` | `session/update` → BeefTV 事件映射：`agent_message_chunk`→`text_delta`，`tool_call*`→`lifecycle`，汇总 reply / toolCalls |
| `turn-runner.mjs` | 单回合编排：校验 Go 回合 → 组装上下文 → prompt → 事件 → `turn_end` → `POST .../complete` |
| `beef-mcp.mjs` | stdio MCP server：`initialize` / `tools/list` / `tools/call`，把调用转发给宿主的本机回调端点 |
| `mcp-tools.mjs` | 把 `operation-bridge` 的 descriptors / `buildTools` 适配成 MCP 工具定义与调用 |
| `session-store.mjs` | 每画布会话、当前指针、transcript、active turn 的落盘（JSON，目录结构与 pi 的 `sessions/` 分开） |
| `runtime-config.mjs` | 读 `DATA_DIR/acp_host.json`：agent 命令/参数/模型、工具策略、工作目录 |
| `fake-acp-agent.mjs` | 契约测试替身：按脚本吐 `session/update`，不发真实模型请求 |
| `*.test.mjs` | 单元与宿主集成测试 |
| `README.md` | 本地切换、调试、已知限制 |

复用（直接 import，不复制）：

- `../operation-bridge.mjs`：descriptors、`opsRequest`、`buildTools`（scope、幂等、`collectTurnEffects` 都在里面）
- `../canvas-turn.mjs`：`turnContextPrefix`、`turnChange`、`collectTurnEffects`
- `../system-prompt.mjs`：`SYSTEM_PROMPT`（作为上下文前缀，不覆盖 agent 自身提示词）
- `../request-budget.mjs`：工具步数预算（模型请求预算在 ACP 模式下失效，见第 8 节）

不新增 npm 依赖：ACP 与 MCP 都用手写 JSON-RPC framing（几百行），避免改动上游的 `agent-host/package.json` 与 `bun.lock`，也避免发行包多一层第三方依赖。

## 5. 协议映射

### 5.1 BeefTV → ACP

| BeefTV | ACP |
| --- | --- |
| 启动 agent | 宿主 `spawn(agent.command, agent.args)`，stdio 管道 |
| 建立会话 | `initialize`（protocolVersion 1）→ `session/new { cwd, mcpServers }` |
| 恢复会话 | `session/resume` 或 `session/load`（以 agent 的 `sessionCapabilities` 为准） |
| 发送一轮 | `session/prompt { sessionId, prompt: [{type:"text",...}, {type:"image",...}] }` |
| 取消 | `session/cancel { sessionId }`（notification） |
| 权限请求 | `session/request_permission` → 宿主按策略选 option |
| 结束 | `session/prompt` 的 `stopReason` → `turn_end` |

### 5.2 ACP → BeefTV

| ACP `session/update` | BeefTV NDJSON |
| --- | --- |
| `agent_message_chunk`（text） | `{type:"text_delta", delta}` |
| `agent_thought_chunk` | 丢弃（当前面板不展示思考） |
| `tool_call` / `tool_call_update` | `{type:"lifecycle", phase:"tool"/"tool_end", toolName}` |
| `plan` / `usage_update` / `config_option_update` | 丢弃 |
| prompt 返回 `stopReason` | `{type:"turn_end", turnId, reply, toolCalls, change, proposals, error, cancelled, sessionId}` |

`turn_end.change` / `proposals` 直接取 `turnChange(turn)` / `turn.proposals`，与 pi 宿主同源。

每轮 prompt 的第一个 text block 由宿主组装：`SYSTEM_PROMPT`（精简版）+ `turnContextPrefix(body)`（当前画布、权限模式、选中对象、已校验引用）+ 用户消息。附件图片按 agent 的 `promptCapabilities.image` 决定是否用 `media.inspect` 取字节后内联；不支持就降级为素材描述文本。

## 6. 工具桥

1. 宿主启动时 `ops.loadDescriptors()`，拿到与 pi 宿主相同的操作目录（165 业务 + 27 运维，数量随版本变化）。
2. `session/new` 时带一个 stdio MCP server：
   ```json
   { "name": "beeftv", "command": "<node>", "args": ["<absolute>/agent-host/ACP/beef-mcp.mjs"],
     "env": [ {"name":"BEEFTV_ACP_CALLBACK","value":"http://127.0.0.1:<port>/_mcp"},
              {"name":"BEEFTV_ACP_SESSION","value":"<session-scoped token>"} ] }
   ```
   注意 ACP 的 `env` 是 `{name,value}` 数组，不是对象。
3. `tools/list` 返回操作目录里有 `assistantModes` 的工具名、描述、`parameters`（`canvasId` 已被 `scopedSchema` 拿掉，由宿主注入）。列表发生在 prompt 之前，按“不区分权限模式”的全集返回；真正的权限判定在调用时用当前 turn 重建 `buildTools` 执行。
4. `tools/call` → 宿主 `POST /_mcp` → 按桥接 token 找到该 canvas 的 active turn → 用它的 `generation` / `turn` 调 `execute(toolCallId, args, signal)`；同一画布串行，token 与回合一一对应，不会串轮：
   - 工具内部走 `opsRequest`，带 `X-Beeftv-Agent-Turn`；
   - `assertToolGeneration` 继续执行 read-only / intent 变更拦截；
   - 结果经 `collectTurnEffects` 累积到 `turn`，失败写 `log`。
5. 返回给 agent 的是 MCP `content: [{type:"text", text: JSON}]`；`isError` 按工具结果设置。
6. 付费生成仍走 `canvas.generation.propose`，提案在 `turn_end.proposals` 里回到界面，用户确认后才由 Go 执行——与 pi 模式一致。

工具可见性：默认只暴露 `assistantModes` 非空的操作；`read-only` 回合在调用时由 `assertToolGeneration` 拒绝写操作，不靠工具列表藏权限。

## 7. 会话、历史与恢复

落盘目录（与 pi 的 `sessions/` 隔离，避免污染官方格式）：

```
DATA_DIR/acp-host/
  <canvasId>/
    current.json                 # 当前 sessionId 指针（tmp + rename 原子写）
    <sessionId>.json             # { agentSessionId, title, updatedAt, turns: [...] }
    active.json                  # 未完成回合 { turnId, startedAt, ... }
```

- `turns` 直接存界面要的形状：`turnId / userText / reply / toolCalls / change / proposals / error / cancelled / createdAt`。
- `/history` 返回 `{sessionId, turns, active?}`；`/active` 返回 `{sessionId, turnId, busy}`；`/sessions` 返回列表与当前指针。
- 进程重启后：读 `current.json`，下一次 prompt 先尝试 `session/resume`（codex-acp 已声明支持），失败则新建 ACP 会话，历史仍可读。
- 启动时若发现 `active.json`，尽力 `POST /assistant/runtime/turns/:id/complete` 结算悬空回合（幂等，404 忽略），避免界面永远转圈。
- 并发：一个画布同一时刻只允许一个 prompt；不同画布并行。排队逻辑不共享 pi 的预约队列。

## 8. 安全、权限与预算

**必须做（P1 前）**：

- 启动 agent 时 **清理环境变量**：移除全部 `BEEFTV_*`（尤其 `BEEFTV_AGENT_HOST_TOKEN` / `BEEFTV_AGENT_API_KEY` / `BEEFTV_OWNER_TOKEN` / desktop token），只保留 PATH、HOME/USERPROFILE、TEMP、LANG 和用户显式配置的 agent 变量。否则第三方 agent 进程可拿到能调用全部 ops 的宿主 token。
- agent 的 `cwd` 用每画布独立的空工作目录，不指向仓库、数据目录或用户主目录。
- `initialize` 时声明 `clientCapabilities.fs.readTextFile/writeTextFile=false`、`terminal=false`；对 `session/request_permission`：
  - 工具调用命中 beeftv MCP 工具名 → `allow_once`；
  - shell / 文件写入 / 网络等原生工具 → 选拒绝项（`reject_once`）；
  - 没有拒绝项时回 `cancelled`。
- 只把会话级回环 token 交给 MCP 桥，不把 host token 写进 agent 配置。
- 日志不打印 prompt 正文、凭据、cookie、agent stderr 的敏感内容。

**原生工具必须由 agent 配置关闭，不能只靠 ACP 审批**：实测 codex-acp 默认会直接执行自己的 shell 工具，不经过 `session/request_permission`。当前可用配置是 `--sandbox read-only` + `-c features.shell_tool=false`（Codex 0.162.1 实测 shell 工具消失）。Windows 上仍建议后续加 OS 层隔离；不要把“ACP 权限回调”当成沙箱。

**明确放弃**：

- `BEEFTV_AGENT_MAX_REQUESTS_PER_TURN` / `TOTAL_REQUEST_BUDGET` 在 ACP 模式下无法拦截（模型请求发生在 agent 内部）。工具步数预算仍可用。
- `steer` / 运行中补充输入没有 ACP v1 标准方法；zcode-acp 已明确在 ZCode 0.16 后移除 steer，codex-acp 也未见公开的 steer 方法。MVP 返回 `501 steer_unsupported`，界面按失败提示。后续可做“结束当前轮后作为下一轮发送”，不伪造同轮补充。
- 压缩、自动重试、思考等级由 agent 自己管理，BeefTV 面板不映射内部事件。

## 9. 上游改动面与合并策略

| 文件 | 级别 | 改动 |
| --- | --- | --- |
| `agent-host/ACP/**` | C（新增） | 全部实现与测试 |
| `docs/refactor/acp-agent-host-plan.md` | C（新增） | 本文 |
| `scripts/package-agent-host.mjs` | A（2 行） | `sourceFiles` 增加 `'ACP'`，并把 `cpSync` 改为 `recursive: true`；否则发行包不带 ACP 宿主或直接 EISDIR |
| `web/src/pages/canvas/canvas-assistant-composer.tsx`、`canvas-assistant-sidebar.tsx`、`canvas-assistant-sidebar.css` | A（约 20 行） | ACP 模式下用 `ACP · <model>` 标签替换 BeefTV 模型选择器；只在 `status.model.channelId === "acp"` 时生效 |
| `local/dev-owner-proxy/proxy.ts` | C（fork 工具） | 修复 PUT 转发（原 fetch 流水在 Node 24 下 502），让浏览器 UI 的 owner 写路径可用 |
| `backend/internal/assistantruntime/config.go`、`handler/agent_proxy.go`、`handler/agent_host_lifecycle.go` | A（已实现，约 30 行） | `hostCommand` 指向 `acp-host.mjs` 时跳过 provider 门禁，并用 host `/health` 的模型覆盖状态显示；pi 路径完全不变 |

合并口径：

- 上游改宿主契约（`server.mjs` / `operation-bridge.mjs` / `canvas-turn.mjs`）时，ACP 宿主通过 **直接 import** 自动继承大部分行为；只有 endpoint / 事件字段变化需要跟。建议在 P0 加一组“契约快照”测试：用固定请求跑一遍 ACP 宿主，断言 endpoint、字段、事件名。
- 打包白名单那一行冲突概率低，按 A 级清单机械合并。
- 可选 Go 补丁用独立函数 + 环境变量开关（如 `BEEFTV_AGENT_RUNTIME=acp`），不改变 pi 默认路径。
- Go 补丁的开关是 `Host.ACPRuntime()`：只认 `hostCommand/hostArgs` 里的 `acp-host.mjs`。合并时保留该函数与三处 `!acp` 守卫，不要把它扩散成全局运行时开关。

## 10. 分阶段落地

| 阶段 | 内容 | 验收 | 估时 |
| --- | --- | --- | --- |
| **P0 契约宿主** | `acp-host.mjs` + `fake-acp-agent.mjs` + session store；跑通 chat / 流式 / turn_end / sessions / history / cancel | 用假 agent 发一轮，Go 回合结算、界面出字；`git diff upstream/main -- agent-host` 只有 `ACP/` | 1–2 天 |
| **P1 Codex 主路径** | `acp-client.mjs` + MCP 桥 + permission 策略；真实 codex-acp；读画布、改节点、取消 | Codex 读当前画布、重命名节点；提案卡出现；取消后 Go 回合结束 | 2–4 天 |
| **P2 硬化** | 会话 resume、附件图片、技能 pins、错误映射、悬空回合回收、打包、Windows 启停 | 重启 app 后继续对话；断网/崩溃有明确错误；发行包内含 ACP 宿主 | 3–5 天 |
| **P3 多 agent / 设置** | 同一适配器接 zcode-acp / claude-agent-acp；设置页选运行时与模型；可选 Go 门禁补丁 | 切换 Codex/ZCode 不改代码；未配 BeefTV 模型也能启动 ACP | 2–3 天 |

## 11. 验证清单

- 单元：ACP framing、事件映射、MCP tools/list-call、store 原子写。
- 集成：`fake-acp-agent` + 真实 Go 后端 + 临时数据目录；断言 ops 调用、`turn_end.turnId`、`complete`、历史。
- 真机：codex-acp + Codex 登录；读、写、提案、取消、重启恢复各一条。
- 安全：让 agent 尝试 shell / 写文件 → 必须被拒绝；检查 agent 进程环境无 `BEEFTV_*`。
- 合并演练：在临时分支改一行上游 `server.mjs`，合并后 ACP 宿主仍能启动、契约测试通过。

## 12. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| ACP 桥是第三方（codex-acp 由 baldaworks 维护，zcode-acp 为社区项目；ACP 官方生态也在推进自己的适配器） | 版本漂移、行为差异 | 固定版本；P1 只承诺已验证的 codex-acp 1.11.0；升级前跑契约测试；配置层允许替换 command，不绑定某一家实现 |
| 上游宿主契约漂移 | 宿主适配器失效 | 直接 import 上游模块 + 契约快照测试 |
| 无模型请求预算 | 成本不可控 | 文档写明；依赖 agent 侧配额；必要时保留 pi 作为默认/付费路径 |
| 无 steer / 压缩事件 | 与 pi 体验有差异 | 明确降级提示；P3 再评估 ACP v2 或 agent 扩展 |
| 面板显示的是 Go 渠道模型，不是 Codex/ZCode 实际模型 | 用户误判当前用什么模型 | P1 在设置/面板标注“运行时：Codex”；P3 读 ACP `configOptions` 覆盖显示 |
| ACP 会话 resume 失败 | agent 丢上下文，用户以为还在原会话 | 历史仍可读；失败时明确提示“已开新会话”，不静默假装连续 |
| Windows `.cmd` 启动与路径空格 | 启不来 | 优先独立 exe；`.cmd` 走 `cmd.exe /d /s /c` 并正确引用；P0 在 Windows 上验收 |
| 代码里没有 provider 时状态不可用 | ACP 模式起不来 | 已用 `Host.ACPRuntime()` 放宽；默认 pi 路径仍要求 provider |

## 13. 待确认

1. 默认运行时：保留 pi 为默认、ACP 做成可切换（推荐），还是一步替换？
2. 首批支持：Codex（已实测）→ ZCode → Claude，是否按这个顺序？
3. 计费：ACP 模式使用 agent 自己的订阅/额度，BeefTV 不再计模型请求预算，是否接受？
4. 权限：ACP 模式是否永远只给 BeefTV 工具（不开 shell / 文件），还是 `full-access` 时放开？

## 附录 A：本机探测结果（2026-10-18）

用 `npx -y codex-acp@1.11.0` 做了一次不发 prompt、不花模型 token 的 ACP 探测：

- `initialize`（protocolVersion 1）成功；agent 返回 `mcpCapabilities.http=true`、`promptCapabilities.image=true`、`sessionCapabilities: close/list/resume`，auth 方式为 Codex 原生登录。
- `session/new { cwd, mcpServers: [] }` 成功，返回 `model` / `reasoning_effort` 等 configOptions。
- `session/new` 带 `mcpServers: [{name:"beeftv", command:<node>, args:[fake-mcp], env:[]}]` 成功，返回 `_meta.codex.mcp.contract = "merge"` 并列出 requested server。
- 结论：**ACP + 每会话 MCP server + 会话 resume 的链路成立**，可以作为 P1 的技术前提。

本机同时有 `codex` 0.162.1（含 `app-server` / `mcp` / `exec`）与 `zcode` 0.16.9（含 `app-server`）；`codex-acp` 未全局安装，可 `npx` 或装独立二进制。

## 附录 B：开发期切换

1. 写 `DATA_DIR/acp_host.json`（agent 命令、参数、模型、工具策略）。
2. 把 `DATA_DIR/agent_config.json` 的 `hostCommand` / `hostArgs` 指到 `node <repo>/agent-host/ACP/acp-host.mjs`（现有 dev 配置已经用同样方式指 `server.mjs`）。
3. 重启宿主（后端 `POST /api/assistant/host/restart` 或杀掉子进程后重新打开助手），`/api/assistant/status` 应返回 `available:true`。
4. 回滚：把 `hostCommand` 指回 `agent-host/server.mjs`，数据目录里的 pi 会话不受影响。

ACP 宿主与 pi 宿主共用同一个 `DATA_DIR`，但会话分别落在 `sessions/`（pi，官方格式）与 `acp-host/`（ACP 宿主），互不覆盖。

## 附录 C：Codex 端到端实测（2026-10-18）

环境：`codex-acp` 1.11.0 + Codex CLI 0.162.1，模型 `glm-5.3-flash`（provider 通过 `--codex-args -c model_provider=ZAI` 传入）；画布 `digitalhuman-paper-001__P03`（只读）与临时画布 `acp-test-001`（写/撤销）。

| 场景 | 结果 |
| --- | --- |
| 只读回合 | `canvas_get` 一次，约 16s 返回节点分类；`turn_end.toolCalls` / `change:null` 正常 |
| 写回合 | `canvas_nodes_create` 创建文本节点，revision 1→2，`change.createdNodeIds` 正确 |
| 撤销 | `POST /api/assistant/turns/:id/undo` 后 revision=3、nodes=0 |
| 会话恢复 | 重启宿主后 `session/load` 恢复上下文，Codex 能复述上一轮操作 |
| 取消 | `/cancel` 后 `turn_end.cancelled=true`，Go 回合结算 |
| 只读模式 | 请求创建节点被拒绝，画布无变化 |
| UI 面板 | 打开 Agent、加载历史、发送消息并收到回复；截图 `.local/acp-ui.png` |
| 技能 pins | 注入 26720 字固定版本文本，Codex 能复述技能名与第一条要求 |
| 附件图片 | 读取 `scene-S1` 后，Codex 准确描述画面场景（约 30s） |
| 视频附件 | 读取 `seg-P03` 的 0–5s 抽帧（4 帧），Codex 描述画面并声明抽帧局限（约 29s） |
| 无模型启动 | 临时后端（无渠道）+ ACP hostCommand：4s 内 `available:true`，不再报 `model_not_configured` |
| 模型显示 | 状态改用 host `/health` 的 `glm-5.3-flash`（channelId=`acp`），不再显示 BeefTV 渠道模型 |
| 界面标签 | 输入框显示 `ACP · glm-5.3-flash`，BeefTV 模型选择器不再出现 |
| 打包 | Node 24.15.0 windows/amd64 打包成功，`ACP/` 进入发行目录；打包后的宿主用随包 Node 启动，health ok、载入 34 个操作 |
| 付费提案 | `canvas_generation_propose` 返回 proposalId，`turn_end.proposals` 含 model/modelKey/source |
| ZCode | bridge 0.47.0 可 initialize + session/new；本机只暴露本地 Strata 模型（未运行），prompt 未跑通 |
| shell 默认行为 | codex-acp **直接执行** `powershell dir`，不经过 ACP 审批 |
| shell 关闭后 | `--sandbox read-only` + `features.shell_tool=false` 后 shell 工具消失，agent 无法执行命令 |
| 工具目录 | `assistantModes` 过滤后 34 个 |

仍需补的验收：崩溃/断网恢复、完全干净环境下的安装包升级、ZCode 的真实 prompt。

单元测试：`cd agent-host && bun test ACP/acp-host.test.mjs`（4 项：ACP client、runtime config、session store、MCP bridge）。

配置落点：`DATA_DIR/acp_host.json`；开发期切换与回滚见 [README](../../agent-host/ACP/README.md)。
