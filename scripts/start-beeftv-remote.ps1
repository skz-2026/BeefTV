# 启动 BeefTV（后端 + owner 代理 + 前端），确保 Tailscale Serve 指向 3000，
# 然后打开手机扫码页。重复执行不会重复启动已经在监听的进程。
# 默认用构建产物（scripts/serve-web.mjs，带 gzip 和长缓存，外网加载快）；
# 需要热更新时加 -Dev 走 Vite 开发服务器。
param([switch]$NoBrowser, [switch]$Dev)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $root ".local\logs"
New-Item -ItemType Directory -Force -Path $logs | Out-Null

function Test-Listening([int]$Port) {
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Wait-Http([string]$Url, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) { return $true }
        } catch {
            # 进程已经拉起来但还没开始监听，继续等。
        }
        Start-Sleep -Milliseconds 800
    } until ((Get-Date) -gt $deadline)
    return $false
}

function Start-Logged([string]$File, [string[]]$Arguments, [string]$WorkDir, [string]$Name) {
    $options = @{
        FilePath               = $File
        WorkingDirectory       = $WorkDir
        WindowStyle            = "Hidden"
        RedirectStandardOutput = (Join-Path $logs "$Name.out.log")
        RedirectStandardError  = (Join-Path $logs "$Name.err.log")
    }
    if ($Arguments -and $Arguments.Count -gt 0) { $options.ArgumentList = $Arguments }
    Start-Process @options
}

function Show-Failure([string]$Message) {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($Message, "BeefTV 远程启动失败", "OK", "Error") | Out-Null
    } catch {
        Write-Error $Message
    }
}

# 1. 后端（默认走 .local 里编好的可执行文件，缺失时才用 go run）
if (-not (Test-Listening 8080)) {
    $env:CANVAS_BACKEND_DATA_DIR = Join-Path $root ".local\project-workbench-debug"
    $env:CANVAS_OFFICIAL_PLUGIN_DIR = Join-Path $root "plugin-packages"
    $env:CANVAS_BACKEND_ADDR = ":8080"
    $env:CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS = "127.0.0.1"
    $env:CANVAS_IMAGE_TIMEOUT_MINUTES = "30"
    $backendExe = Join-Path $root ".local\tools\infinite-canvas-backend.exe"
    if (Test-Path $backendExe) {
        Start-Logged $backendExe @() $root "backend"
    } else {
        Start-Logged "go" @("run", "./cmd/server") (Join-Path $root "backend") "backend"
    }
}

# 2. owner 代理：浏览器写操作需要本机 owner 凭据，Vite 通过 8090 转发到 8080
if (-not (Test-Listening 8090)) {
    $env:OWNER_PROXY_TOKEN_FILE = Join-Path $root ".local\project-workbench-debug\agent_owner_token"
    $env:OWNER_PROXY_UPSTREAM_PORT = "8080"
    Start-Logged "node" @("local\dev-owner-proxy\proxy.ts") $root "owner-proxy"
}

# 3. 前端：默认构建产物（gzip + 长缓存），-Dev 才起 Vite 开发服务器
if (-not (Test-Listening 3000)) {
    $distIndex = Join-Path $root "web\dist\index.html"
    if (-not $Dev -and -not (Test-Path $distIndex)) {
        # 没有构建产物时先构建，避免悄悄退回开发服务器（外网会慢几十倍）。
        Push-Location (Join-Path $root "web")
        try {
            & bun run build *> (Join-Path $logs "web-build.log")
        } finally {
            Pop-Location
        }
    }
    if (-not $Dev -and (Test-Path $distIndex)) {
        $env:WEB_DIST = Join-Path $root "web\dist"
        $env:API_TARGET = "http://127.0.0.1:8090"
        $env:PORT = "3000"
        Start-Logged "node" @("scripts\serve-web.mjs") $root "web"
    } else {
        $env:VITE_API_PROXY_TARGET = "http://127.0.0.1:8090"
        Start-Logged "bun" @("run", "dev") (Join-Path $root "web") "vite"
    }
}

if (-not (Wait-Http "http://127.0.0.1:8080/api/health" 120)) {
    Show-Failure "后端 120 秒内没有就绪。日志：$logs\backend.err.log"
    exit 1
}
if (-not (Wait-Http "http://127.0.0.1:3000/" 180)) {
    Show-Failure "前端 180 秒内没有就绪。日志：$logs\web.err.log（开发模式是 $logs\vite.err.log）"
    exit 1
}

# 4. Tailscale Serve：已指向 3000 就不重复配置
$tailscale = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $tailscale) { $tailscale = Join-Path $env:ProgramFiles "Tailscale\tailscale.exe" }
if (Test-Path $tailscale) {
    # T3 Code 的 Network access 会把 tailnet 的 443 指向它自己的 3773；
    # BeefTV 固定用 8443，避免两个服务抢同一个 HTTPS 端点。
    $published = $false
    try {
        $serveJson = & $tailscale serve status --json 2>$null | ConvertFrom-Json
        foreach ($web in $serveJson.Web.PSObject.Properties) {
            foreach ($handler in $web.Value.Handlers.PSObject.Properties) {
                if ($handler.Value.Proxy -match '^http://(127\.0\.0\.1|localhost):3000/?$') { $published = $true }
            }
        }
    } catch {
        # 没有 serve 配置或输出为空时走下面的发布命令。
    }
    if (-not $published) {
        & $tailscale serve --bg --https=8443 http://127.0.0.1:3000 | Out-Null
    }
}

# 5. 打开扫码页
if (-not $NoBrowser) {
    Start-Process "http://127.0.0.1:3000/remote"
}
Write-Output "BeefTV 已启动：http://127.0.0.1:3000/remote"
