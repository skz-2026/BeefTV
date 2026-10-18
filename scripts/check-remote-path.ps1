# 检查手机远程访问的链路：NAT 层数、全局 IPv6、Tailscale 直连还是 DERP。
# 改完路由器设置后重新运行，看最后几行是否从 DERP 变成直连。
param([string]$Peer = "iphone183")

$ErrorActionPreference = "Continue"

Write-Output "== 1. 到公网的路径（出现多个私网跳 = 多层 NAT）=="
tracert -d -h 4 223.5.5.5 2>$null | Select-Object -First 9

Write-Output "`n== 2. 全局 IPv6（要看到 240e:/2408:/2409: 开头才算有）=="
$v6 = Get-NetIPAddress -AddressFamily IPv6 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -match '^2[0-9a-f]{3}:' }
if ($v6) {
    $v6 | Select-Object IPAddress, InterfaceAlias | Format-Table -AutoSize
} else {
    Write-Output "没有全局 IPv6：只有 link-local 和 Tailscale ULA。路由器没下发 IPv6。"
}

Write-Output "`n== 3. Tailscale 网络检查 =="
$ts = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $ts) { $ts = Join-Path $env:ProgramFiles "Tailscale\tailscale.exe" }
if (Test-Path $ts) {
    & $ts netcheck 2>$null | Select-String -Pattern 'UDP:|IPv4:|IPv6:|PortMapping:|Nearest DERP:'
    Write-Output "`n== 4. 到手机的路径（direct 才算打通）=="
    & $ts ping -c 4 $Peer 2>&1 | Select-Object -First 6
} else {
    Write-Output "找不到 tailscale.exe"
}

Write-Output "`n== 结论 =="
Write-Output "IPv6 有全局地址 + ping 显示 direct -> 远程已经走直连，可以正常用。"
Write-Output "只有 IPv4 且 ping 是 via DERP -> 主机不可达，需要开 IPv6 或改用 VPS 中转。"
