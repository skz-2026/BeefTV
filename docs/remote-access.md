# 手机与远程访问

BeefTV 是本地优先的工作区：项目、画布、任务、素材和模型配置都在宿主机（SQLite 与资源目录）里，浏览器只做展示和编辑。所以「在手机上继续操作家里的画布」不需要手机 App，也不需要同步一套账号，只需要让手机的浏览器安全地访问到同一个前端和同一个后端。

本文覆盖源码运行的形态（`go run ./cmd/server` + `bun run dev`）。Compose 部署把 `web` 的 `3000` 暴露出来即可，隧道部分同理。

## 一键启动与扫码入口

Windows 上双击仓库里的 `scripts/start-beeftv-remote.cmd`（或在桌面放一个指向它的快捷方式）会依次完成：

1. 后端（优先用 `.local/tools/infinite-canvas-backend.exe`，缺失时 `go run ./cmd/server`）；
2. owner 代理（`local/dev-owner-proxy`，监听 8090，浏览器写操作需要本机 owner 凭据）；
3. 前端（默认用 `web/dist` 构建产物 + `scripts/serve-web.mjs`；没有构建产物时会先自动 `bun run build`，加 `-Dev` 才起 Vite 开发服务器）；
4. 检查 `tailscale serve` 是否已把 3000 发布到 tailnet，没有就执行 `tailscale serve --bg --https=8443 http://127.0.0.1:3000`；
5. 打开 `http://127.0.0.1:3000/remote`。

外网访问默认走生产构建，因为开发服务器在手机链路上很慢：一个首页就要几百个模块请求、约 5MB 未压缩脚本，还要额外跑 HMR。`scripts/serve-web.mjs` 补了三件事：文本资源 gzip（1.8MB 的 chunk 变成约 720KB）、`/static/*` 一年不可变缓存、`/api` JSON 也 gzip（项目文档 186KB → 29KB）。实测首页首屏从约 2.4MB 降到约 1.4MB，重复打开直接命中缓存。

构建还会把首页依赖图（index.html、bootstrap-workspace、user-layout、home 的静态 import 闭包，约 89 个 chunk）写成 `modulepreload` 注入 `index.html`。手机走 Tailscale Serve 的 HTTP/2，这些 chunk 会一次并发拉取，不再逐层发现；在 400ms 延迟、10Mbps 的模拟下，首开从 6.5s 降到 5.3s。

改了前端代码后，想让远程端生效需要重建：`cd web && bun run build`。开发调试用 `scripts/start-beeftv-remote.ps1 -Dev`（热更新，但外网慢）。

`/remote` 是应用内的扫码页：显示本机 tailnet 地址、二维码和三项状态（Tailscale 已登录 / MagicDNS / Serve 已发布），手机上可以直接相机扫码，或把同一地址加到主屏幕。侧边栏底部的「手机访问」也是同一个入口。页面数据来自后端 `GET /api/remote/access`，它只读取本机 Tailscale 状态，不参与任何流量转发。

### 和 T3 Code 共用 tailnet 时

T3 Code 的 Network access 会把 tailnet 的 **443** 指向它自己的 3773。Tailscale Serve 每个端口只有一张路由表，两个服务都抢 `/` 就会互相覆盖，所以 BeefTV 固定发布在 **8443**：

```powershell
tailscale serve --bg --https=8443 http://127.0.0.1:3000   # BeefTV
tailscale serve status                                     # 443 -> 3773, 8443 -> 3000
tailscale serve --https=8443 off                           # 撤销 BeefTV 的发布
```

`/remote` 从 `tailscale serve status --json` 里读实际端口，二维码会带上 `:8443`，不会误指到 T3 Code。两个服务的本地端口（3000 / 3773）本身也不冲突。

日志在 `.local/logs/`（backend / owner-proxy / web，开发模式是 vite）。已经在监听的进程不会被重复启动。

## 三种接法

| 接法 | 适用场景 | 额外安装 | 安全边界 |
| --- | --- | --- | --- |
| 局域网直连 | 手机和电脑在同一个 Wi-Fi | 无 | 同一局域网内任何人可访问；当前 server 形态没有登录 |
| Tailscale Serve | 外网、4G，只给自己的设备用 | 主机和手机都装 Tailscale | 只有你 tailnet 里的设备能访问；WireGuard 设备鉴权 + 自动 HTTPS |
| Tailscale Funnel | 需要给没装 Tailscale 的浏览器看 | 主机装 Tailscale | **公网可达**，必须先加鉴权，当前版本不要直接开 |

## 前置：把前后端跑起来

后端（默认只监听 `127.0.0.1:8080`，不要为了手机访问改成 `:8080`）：

```powershell
cd backend
$env:CANVAS_BACKEND_DATA_DIR = "C:\work\BeefTV\.local\project-workbench-debug"
go run ./cmd/server
```

前端（`bun run dev` 已经是 `--host 0.0.0.0 --port 3000`，并通过 `/api` 代理到后端）：

```powershell
cd web
bun run dev
```

手机访问时请求路径是「手机 → 3000（Vite）→ 8090（owner 代理）→ 127.0.0.1:8080（后端）」，后端只暴露给本机，这是有意的。owner 代理负责给浏览器的写操作补上本机 owner 凭据（直接用上面的“一键启动”会带上它）。

## 方式一：局域网直连

同一 Wi-Fi 下，手机浏览器打开 `http://<电脑局域网 IP>:3000/`。

- 查询地址：`ipconfig`（Windows）或 `tailscale ip -4`（Tailscale 的 `100.x` 地址在同一 tailnet 内也可用）。
- Windows 首次访问需要在防火墙放行 Node.js（专用网络）。
- 手机和电脑不在同一网段时，这个地址不可用，直接看方式二。

## 方式二：Tailscale Serve（推荐）

1. 主机和手机安装 Tailscale，登录同一账号（同一 tailnet）。
2. 在管理后台开启 MagicDNS 与 HTTPS Certificates（Serve 需要签发证书）。
3. 主机按上面的前置步骤启动后端和前端。
4. 发布本机 3000：

```powershell
tailscale serve --bg 3000
tailscale serve status
```

`status` 会给出形如 `https://<machine>.<tailnet>.ts.net/` 的地址，手机浏览器直接打开即可。命令语法以本机 `tailscale serve --help` 为准，显式写法是 `tailscale serve --bg http://127.0.0.1:3000`。

5. 撤销：`tailscale serve reset`。

注意事项：

- **Vite 的 Host 白名单**：Vite 默认只接受 `localhost` 和字面 IP，Tailscale 的域名会被 403 `Blocked request. This host is not allowed.` 拦掉。`web/vite.config.ts` 已默认放行 `.ts.net`；用别的域名时设置 `BEEFTV_ALLOWED_HOSTS=beef.example.com`（逗号分隔，`*` 表示全部放行）。
- **HMR**：Serve 之后页面是 443 的 HTTPS，而 Vite 在 3000，开发时的热更新会连到错误端口。需要时用 `BEEFTV_DEV_HMR_CLIENT_PORT=443 bun run dev`。
- **日常远程建议用构建产物**：`bun run build` 之后 `bun run start`（`vite preview`，同样带 `/api` 代理和 Host 白名单）。dev server 的模块请求数量在移动网络下明显更慢。
- 后端访问日志里来源都是 `127.0.0.1`，因为请求经过本机 Vite 代理，这是正常的。

## 方式三：Tailscale Funnel（公网）

```powershell
tailscale funnel --bg 3000
```

当前版本**不要直接开**：server 形态没有任何登录或令牌校验，公网可达意味着任何人可以调用全部接口，包括 `GET /api/workspace/model-config/export`（返回渠道 `apiKey` 明文）、发起生成任务消耗额度、删除素材。要用 Funnel，先在前面加一层鉴权（反向代理 Basic Auth、OAuth 网关或 Cloudflare Access），或者等内置的远程访问闸门落地。

## 手机上的现状与已知限制

- 首页在 390px 宽度下没有横向溢出，侧栏会收起，浏览器控制台无报错。
- 画布在窄屏自动进入专注模式（顶部一条工具栏），首次打开会自动适配全部节点，不再只露出左上角。
- 双指缩放、单指平移、点选节点都可用。
- 数字人生产页在 ≤767px 时把左侧段导航改成顶部横向条，预览和镜头画布吃满宽度；顶栏隐藏撤销/重做/保存状态，步骤条单行横向滚动。桌面宽度不受影响。
- **长按 = 右键**：节点、连线、画布空白处长按会打开对应菜单（添加节点、删除、复制、生成等）；长按后抬手不会误触节点编辑。
- 触摸设备按低媒体预算渲染：只挂载视口附近的图片/视频，减少解码和带宽。
- 已提供 PWA manifest 与主屏图标，iOS/Android 可「添加到主屏幕」。

## 排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `403 Blocked request. This host is not allowed.` | Vite Host 白名单 | 设置 `BEEFTV_ALLOWED_HOSTS`（默认已含 `.ts.net`） |
| 页面能打开，接口 403 | 后端 CORS | Vite 同源代理会带 `X-Forwarded-Host`，通常无需配置；如果前面还有 nginx 且改写了 Host，设置 `CANVAS_CORS_ORIGINS=https://<域名>` |
| 页面一直转圈 | 后端没启动或端口不对 | 检查 8080，以及 `VITE_API_PROXY_TARGET` |
| 任务事件不更新 | 代理缓冲了 SSE | Vite 和 Tailscale Serve 不需要额外配置；nginx 按仓库 `nginx.conf` 的 SSE 段 |
| HMR 连不上 | 页面 443 / Vite 3000 端口不一致 | `BEEFTV_DEV_HMR_CLIENT_PORT=443` |
| 手机打不开局域网地址 | 防火墙或不同网段 | 放行 Node.js，或改用 Tailscale |
| 局域网快、外网很慢 | 还在用 Vite 开发服务器，或资源没压缩 | 用一键启动（默认生产构建 + gzip）；`tailscale ping <手机名>` 确认是 direct，不是 `via DERP` |
| 改了代码但手机没变化 | 手机走的是构建产物 | `cd web && bun run build`，或临时用 `-Dev` 启动 |

### 外网只能走 DERP 时

`tailscale ping <手机名>` 出现 `via DERP(hkg)` 说明两台设备都在 NAT 后面、互相进不来，Tailscale 只能中转。此时页面能打开也会非常慢，和前端体积无关。

```
tailscale netcheck        # 看 IPv6: 是 no 还是 yes
ipconfig                  # 看有没有 2409:/2408:/240e: 开头的全局 IPv6
```

主机拿到全局 IPv6 后，`tailscale ping` 会变成 `via [2409:...]:41641` 直连。家用路由器一般这样开：IPv6 开启、WAN 自动获取/DHCPv6、前缀 DHCPv6-PD、LAN 侧开启。拿不到 IPv6（运营商或光猫没下发）时，只能改用 VPS 中转或 Cloudflare Tunnel。

## 后续（尚未实现）

- 远程访问闸门：一次性配对码 + 会话 cookie + 设备吊销，供 Funnel 或公网反代使用。
- 手机端助手侧栏与部分参数面板仍按桌面宽度排版，窄屏会挤占画布。
- 触摸端的手势提示（长按/双指）与画布性能设置页。
