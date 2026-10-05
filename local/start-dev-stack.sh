#!/usr/bin/env bash
# BeefTV 本地开发全家桶一键启动（Windows Git Bash）
# 组成：BeefTV 后端(8080) + owner信任代理(8090) + Vite前端(3000) + ComfyUI网关(8765)
# 首次运行前请阅读 local/README.md。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUN="/c/Users/ksa/AppData/Local/Microsoft/WinGet/Packages/Oven-sh.Bun_Microsoft.Winget.Source_8wekyb3d8bbwe/bun-windows-x64/bun.exe"
NODE="/c/Program Files/nodejs/node"

echo "[1/4] 后端 :8080（含私网上游白名单 + 前端 Origin 白名单）"
cd "$ROOT" && \
CANVAS_BACKEND_DATA_DIR="$ROOT/.local/project-workbench-debug" \
CANVAS_OFFICIAL_PLUGIN_DIR="$ROOT/plugin-packages" \
CANVAS_BACKEND_ADDR=":8080" \
CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS="127.0.0.1" \
BEEFTV_ALLOWED_ORIGINS="http://localhost:3000,http://127.0.0.1:3000" \
./.local/tools/infinite-canvas-backend.exe &
BACKEND_PID=$!

echo "[2/4] owner 信任代理 :8090"
"$NODE" "$ROOT/local/dev-owner-proxy/proxy.ts" &
PROXY_PID=$!

echo "[3/4] ComfyUI 视频网关 :8765"
cd "$ROOT/local/comfy-video-gateway" && "$BUN" gateway.ts &
GATEWAY_PID=$!

echo "[4/4] Vite 前端 :3000"
cd "$ROOT/web" && VITE_API_PROXY_TARGET="http://127.0.0.1:8090" "$BUN" run dev &
VITE_PID=$!

trap 'kill $BACKEND_PID $PROXY_PID $GATEWAY_PID $VITE_PID 2>/dev/null' EXIT INT TERM
echo ""
echo "全部就绪：前端 http://localhost:3000 （ComfyUI 需另行启动）"
wait
