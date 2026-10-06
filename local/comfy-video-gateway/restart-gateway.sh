#!/usr/bin/env bash
# 重启 ComfyUI 视频网关：改完 gateway.ts / config.json / workflows 模板后运行。
# 先杀掉占用 8765 的旧进程，再以独立进程拉起（不依赖启动它的终端）。
# 日志写入 logs/gateway.out.log 与 logs/gateway.err.log。
# 注意：之后运行 start-dev-stack.sh 整栈重启时，若网关端口被本脚本拉起的进程
# 占用，栈里的网关实例会启动失败（其余服务不受影响）——先跑本脚本接管即可。
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUN="/c/Users/ksa/AppData/Local/Microsoft/WinGet/Packages/Oven-sh.Bun_Microsoft.Winget.Source_8wekyb3d8bbwe/bun-windows-x64/bun.exe"
PORT="${GATEWAY_PORT:-8765}"

PID=$(netstat -ano | grep "LISTENING" | grep ":${PORT} " | awk '{print $5}' | head -1)
if [ -n "${PID:-}" ]; then
    echo "杀掉旧网关 PID=$PID"
    taskkill //F //PID "$PID" >/dev/null 2>&1
    sleep 1
fi

mkdir -p "$DIR/logs"
OUT_LOG="$(cygpath -w "$DIR/logs/gateway.out.log")"
ERR_LOG="$(cygpath -w "$DIR/logs/gateway.err.log")"
powershell -NoProfile -Command "Start-Process -FilePath '$(cygpath -w "$BUN")' -ArgumentList 'gateway.ts' -WorkingDirectory '$(cygpath -w "$DIR")' -WindowStyle Hidden -RedirectStandardOutput '$OUT_LOG' -RedirectStandardError '$ERR_LOG'"
sleep 2
if curl -s -m 3 "http://127.0.0.1:${PORT}/healthz"; then
    echo ""
    echo "网关已重启：http://127.0.0.1:${PORT}（日志 logs/gateway.out.log）"
else
    echo "网关未响应，查看 logs/gateway.err.log" >&2
    exit 1
fi
