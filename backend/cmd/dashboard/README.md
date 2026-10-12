# 本机控制看板（beeftv-dashboard）

单文件 exe 的本机控制看板：启动/停止 BeefTV 前后端与生成链路，查看 CPU、内存、GPU、
磁盘、温度、ComfyUI 显存/队列遥测，以及最近的生成任务流。页面内嵌在 exe 中，
只监听 `127.0.0.1`，无需浏览器扩展或前端构建。

## 面向工作流的功能

- **生成任务流**：直连后端 `/api/tasks`（owner 凭据）展示最近 15 条生成任务的状态、
  模型、提示词、失败原因与进度；挂机时不必开工作台也能盯生成进度。
- **过夜守护**：页头开关（默认关闭，持久化在 `.local/dashboard-settings.json`）。
  开启后每 30 秒探测 ComfyUI，连续两次失败才判定崩溃：自动归档 `comfy-console.log`
  为 `comfy-crash-<时间戳>.log` 并通过 `ComfyUI-Start` 计划任务重新拉起，全程零弹窗。
  手动停止 ComfyUI 后守护自动暂停 15 分钟。需保持看板进程运行。
- **GPU 进程**：nvidia-smi compute-apps 列出占用显存的进程；Windows WDDM 模式下
  单进程显存可能不上报，此时只显示进程名。
- **一键启动提速**：ComfyUI（最慢，模型加载 1-3 分钟）先异步点火，后端/代理/前端/
  网关按依赖顺序同步拉起，互不等待。
- **快捷入口**：页脚提供数据目录、`.local` 目录、ComfyUI 界面一键打开。

## 使用

双击 `C:\work\BeefTV\.local\tools\beeftv-dashboard.exe`（或命令行运行）：

- 自动打开浏览器访问看板（`-no-open` 或环境变量 `BEEFTV_DASHBOARD_NO_OPEN=1` 关闭）。
- 监听端口从 8899 起自动顺延；已有实例在运行时直接打开它，不会双开。
- 关闭控制台窗口或 Ctrl+C：只停止**由看板启动**的服务（Windows Job Object 兜底）；
  外部方式（如 `.local/*.cmd` 脚本）启动的服务不受影响，需要停止时用页面上的
  「一键停止」或原方式停止。

## 管理的服务

| 服务 | 启动方式 | 端口 |
| --- | --- | --- |
| 后端 | `.local/tools/infinite-canvas-backend.exe`（缺失时用 `.local/tools/go` 现场编译） | 8080 |
| Owner 代理 | `node local/dev-owner-proxy/proxy.ts` | 8090 |
| 前端 | `bun run dev`（web/） | 3000 |
| 视频网关 | `bun gateway.ts`（local/comfy-video-gateway，端口读 config.json，默认 8765） | 8765 |
| ComfyUI | `schtasks /Run /TN ComfyUI-Start`（计划任务，模型加载可达数分钟） | 8188 |

后端环境变量与 `scripts/start-local.ps1`、`.local/start-backend-detached.cmd` 一致
（`CANVAS_BACKEND_DATA_DIR`、`CANVAS_OFFICIAL_PLUGIN_DIR`、`CANVAS_BACKEND_ADDR`、
`CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS`、`BEEFTV_ALLOWED_ORIGINS`）；前端注入
`VITE_API_PROXY_TARGET=http://127.0.0.1:8090`。

「一键启动」按 上表顺序拉起五个服务并等待健康检查；已健康的跳过。ComfyUI 由任务计划
程序持有进程，看板只负责触发和等待健康；停止走端口定位 PID 的方式（若 comfy-watchdog
在运行，可能 30 秒内被其重新拉起，日志里会提示）。

## 硬件与 ComfyUI 遥测

- 复用 `backend/internal/systemstats`（与画布硬件监控浮窗同一实现）：CPU/内存来自
  gopsutil，GPU 占用/显存/温度来自 nvidia-smi，磁盘来自 WMI，ACPI 热区需要管理员权限，
  拿不到时对应项显示缺失。
- ComfyUI 卡片来自 `GET /system_stats` 与 `/queue`：版本、进程视角的显存空闲、
  运行/排队任务数；ComfyUI 离线时显示提示。
- 日志面板含「ComfyUI」页签，回放并跟踪 `.local/comfy-console.log`（自动识别
  PowerShell 追加产生的 UTF-16 段与 ANSI 转义）。

## 重新编译

```powershell
cd backend
..\.local\tools\go\bin\go.exe build -trimpath -o ..\.local\tools\beeftv-dashboard.exe ./cmd/dashboard
```

仓库根目录可用 `BEEFTV_DASHBOARD_REPO` 显式指定（默认从当前目录或 exe 所在目录向上查找
`VERSION` + `backend/go.mod`）。
