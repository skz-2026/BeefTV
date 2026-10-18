# ACP 宿主（BeefTV 调用 Codex / ZCode）

`agent-host/ACP/` 是内置创作助手的第二种执行内核：与 `agent-host/server.mjs`（pi 宿主）实现同一套 HTTP/NDJSON 契约，内部用 [Agent Client Protocol](https://agentclientprotocol.com/) 驱动外部 coding agent。Go、React 和 pi 宿主都不需要改。

```
React -> Go /api/assistant/* -> acp-host.mjs -> codex-acp / zcode-acp
                                     |  ACP(JSON-RPC/stdio)
                                     v
                              beef-mcp.mjs  (每会话一个 stdio MCP server)
                                     |  回环 HTTP + 会话 token
                                     v
                              Go /api/ops  (带 turnId)
```

## 启动

1. 写 `DATA_DIR/acp_host.json`（`DATA_DIR` 与 Go 的 `BEEFTV_AGENT_DATA_DIR` 相同）。
2. 把 `DATA_DIR/agent_config.json` 的 `hostCommand` / `hostArgs` 指到本目录的 `acp-host.mjs`：

```json
{
  "model": "deepseek-v4-pro",
  "hostCommand": "C:/Program Files/nodejs/node.exe",
  "hostArgs": ["C:/work/BeefTV/agent-host/ACP/acp-host.mjs"]
}
```

`hostCommand` 指向 `acp-host.mjs` 时，Go 会跳过“必须先配一个 BeefTV 文本模型”的门禁；`/assistant/status` 里的模型改为读宿主 `/health` 的外部 agent 模型（例如 `glm-5.3-flash`，channel=`acp`）。pi 宿主仍然要求 BeefTV 模型。

打包形态下没有显式 `hostCommand` 时，只要 `DATA_DIR/acp_host.json` 存在，就会使用随包的 `agent-host/ACP/acp-host.mjs`；没有这个文件仍是 pi。

已用 Node 24.15.0 的 windows/amd64 打包验证：`ACP/` 会进入发行目录，打包后的宿主用随包 Node 启动，health ok 且能载入 34 个操作。

3. 重启宿主：`POST /api/assistant/host/restart`（需要 UI 会话或 owner 凭据），或退出应用重开。

回滚：把 `hostCommand` 指回 `agent-host/server.mjs`。两套会话分开存放（pi 在 `DATA_DIR/sessions/`，ACP 在 `DATA_DIR/acp-host/`），互不覆盖。

也可以用脚本切换（会保留已有的 `model`）：

```bash
node agent-host/ACP/switch-host.mjs --data-dir <DATA_DIR> --runtime acp
node agent-host/ACP/switch-host.mjs --data-dir <DATA_DIR> --runtime pi
node agent-host/ACP/switch-host.mjs --data-dir <DATA_DIR> --show
```

## 配置

`DATA_DIR/acp_host.json`：

```json
{
  "agent": {
    "id": "codex",
    "command": "C:/path/to/codex-acp.exe",
    "args": [
      "--message-streaming",
      "--sandbox", "read-only",
      "--codex-args", "-c",
      "--codex-args", "model_provider=ZAI",
      "--codex-args", "-c",
      "--codex-args", "model=glm-5.3-flash",
      "--codex-args", "-c",
      "--codex-args", "features.shell_tool=false"
    ],
    "env": {},
    "model": "glm-5.3-flash"
  },
  "limits": { "toolStepsPerTurn": 40, "turnTimeoutMs": 1800000 },
  "debug": false
}
```

- `args` 是 agent 自己的命令行参数，原样透传。Codex 的模型/供应商用 `codex-acp --codex-args -c ...` 传入；不写入用户 `~/.codex/config.toml`。
- `env` 只用于给 agent 补充它需要的变量（例如自定义 `CODEX_HOME`）。宿主默认会清掉全部 `BEEFTV_*`，只保留 PATH、HOME/USERPROFILE、TEMP、LANG 等系统项。
- `model` 会在 `session/new` 后通过 ACP `session/set_config_option` 设置一次；留空则用 agent 自己的默认值。
- 不给 `args` 时，如果命令名含 `codex-acp`，宿主自动补 `--message-streaming`（否则 Codex 不会逐字输出）。

### 换成 ZCode

```json
{
  "agent": {
    "id": "zcode",
    "command": "C:/Users/you/AppData/Roaming/npm/zcode-acp.cmd",
    "args": [],
    "model": ""
  }
}
```

ZCode 走 `acp-extension-zcode`（`npm i -g acp-extension-zcode`）。它自己管理 `~/.zcode` 登录态，不需要在 BeefTV 配模型。

> 2026-10-18 实测：`acp-extension-zcode@0.47.0` 能 `initialize` 并创建会话；本机 ZCode 0.16.9 的 provider 只暴露本地 Strata 模型（127.0.0.1:8081 未运行），所以真实 prompt 未跑通。0.38.0 还会因为只认 `~/.zcode/v2/config.json` 而报凭据缺失。换 ZCode 时请让 bridge 版本与 ZCode 版本匹配，并确认它有一个可用的云端模型。

## 行为与边界

- **工具身份**：MCP 桥用宿主持有的 token + 当前 `turnId` 调 Go `/api/ops`，因此回合、权限、撤销、提案、操作回执与 pi 模式一致。不是外部 MCP 客户端身份。
- **工具集**：`operation-bridge` 的 `assistantModes` 目录，名称是 `canvas_get` 这类下划线形式；`read-only` 回合在调用时被拒绝，不靠列表隐藏。
- **技能**：`body.skills` 的固定版本 pin 会按 `contentHash` 读 `/ops/skill.get`，正文以 `<skill>` 块注入本轮；选择存在会话里，`skills: []` 清空。测试用「系列套图生成」验证过 26720 字正文注入。
- **附件**：图片/视频附件经 `media.overview` + `media.inspect(frames)` 取帧后作为 ACP image content 发送（视频按 `start/end` 截取，最多 15 秒）；音频附件只提示模型不能直接听，不伪造内容。
- **超时**：`limits.turnTimeoutMs`（默认 30 分钟）到点会发 `session/cancel`，`turn_end` 标记 `turn_timeout`，不会无限挂着。
- **界面标记**：ACP 模式下输入框显示 `ACP · <模型>`，不再显示不影响运行的 BeefTV 渠道模型选择器。
- **提案**：`canvas.generation.propose` 照旧登记，提案在 `turn_end.proposals` 回到界面，执行仍由用户在面板确认。
- **权限**：`session/request_permission` 只自动允许 beeftv 工具；fs/terminal 能力声明为 false。agent 的原生工具由它自己的配置约束。
- **安全**：agent 进程不继承任何 `BEEFTV_*`；MCP 桥只拿到会话级回环 token；工作目录是 `DATA_DIR/acp-host/workspaces/<canvasId>`。
- **会话**：每画布一个 ACP 会话；`session/load` 失败会新建，历史仍可读。进程重启后优先恢复。
- **明确不支持**：`steer`（运行中补充）返回 501；模型请求预算无法拦截（agent 内部发起，只有工具步数预算有效）；面板模型显示仍取 Go 的渠道模型。

### 原生 shell 的限制

ACP 没有“禁用 agent 原生工具”的标准字段。codex-acp 默认会执行自己的 shell 工具（实测能跑 `dir`），`session/request_permission` 不一定会被调用。当前建议配置：

- `--sandbox read-only`：禁止写文件；
- `-c features.shell_tool=false`：关闭 Codex 的 shell 工具（0.162.1 实测有效）；
- 如需完全隔离，后续应在 OS 层限制 agent 子进程（容器/沙箱账户），不能只依赖 ACP 审批。

## 文件

| 文件 | 责任 |
| --- | --- |
| `acp-host.mjs` | HTTP/NDJSON 适配器：鉴权、健康、会话、回合、MCP 回调 |
| `acp-client.mjs` | ACP JSON-RPC over stdio：initialize / session / prompt / cancel / permission |
| `beef-mcp.mjs` | 每会话的 stdio MCP server，转发工具目录与调用 |
| `session-store.mjs` | `DATA_DIR/acp-host/<canvasId>/` 下的会话、历史与 active 回合 |
| `runtime-config.mjs` | 读取 `acp_host.json`、清理 agent 环境变量、准备 workspace |
| `switch-host.mjs` | 在 `agent_config.json` 里切换 pi / ACP 宿主（`--show` 只看不改） |
| `fake-acp-agent.mjs` | 单元测试替身 |
| `acp-host.test.mjs` | ACP client / runtime config / store / MCP 桥测试 |

## 测试

```bash
cd agent-host
bun test ACP/acp-host.test.mjs
```

契约端到端（需要运行中的后端与 Codex 登录）：

```powershell
node .local/acp-chat-test.mjs <canvasId> "读取当前画布，告诉我节点数量" canvas
```

`host.log` 只记录会话、工具名、权限决策和错误，不写 prompt 正文或凭据。
