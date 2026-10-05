# local/ — 不耦合官方代码的本地扩展

这个目录是对 BeefTV 仓库的**本地增量**，不改官方任何文件，`git pull` 官方更新永不冲突。

| 组件 | 作用 |
| --- | --- |
| `comfy-video-gateway/` | 本地视频/生图网关：BeefTV → ComfyUI（MiniMax-H3 视频 + Qwen-Image-2.1 生图），详见其 README |
| `dev-owner-proxy/` | 本机 owner 信任代理（8090→8080，注入 `X-Beeftv-Owner`）。cmd/server 形态没有桌面启动令牌，浏览器画布文档提交（`/api/ops/canvas.document.commit`）会 403，生成结果无法回填节点；此代理让 server 形态获得官方 wails dev 等价的受信任本机前端身份 |
| `start-dev-stack.sh` | 一键启动后端+代理+网关+前端（Git Bash） |

## 完整启动链路

```text
浏览器 http://localhost:3000
  │ Vite 代理 /api（VITE_API_PROXY_TARGET=http://127.0.0.1:8090）
  ▼
dev-owner-proxy :8090（注入 X-Beeftv-Owner = 数据目录 agent_owner_token）
  ▼
BeefTV 后端 :8080（BEEFTV_ALLOWED_ORIGINS=http://localhost:3000,...）
  │ 自定义渠道中转 → 网关 :8765 → ComfyUI :8188
```

后端必须带 `BEEFTV_ALLOWED_ORIGINS`（否则代理转发的 Origin 会被「操作层只接受本机请求」拒绝）；Vite 必须带 `VITE_API_PROXY_TARGET` 指向 owner 代理。`start-dev-stack.sh` 已包含全部环境变量。

## 一键启动

```bash
bash local/start-dev-stack.sh
```

ComfyUI（`C:\AI\ComfyUI-Portable`）需单独启动。视频与生图不要并发（显存各约 15.5G / 10G）。
