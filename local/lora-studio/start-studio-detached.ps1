# LoRA Studio 分离启动（脱离终端存活）
$BUN = "C:\Users\ksa\AppData\Local\Microsoft\WinGet\Packages\Oven-sh.Bun_Microsoft.Winget.Source_8wekyb3d8bbwe\bun-windows-x64\bun.exe"
$cwd = "C:\work\BeefTV\local\lora-studio"
New-Item -ItemType Directory -Force -Path "$cwd\logs" | Out-Null
Start-Process -FilePath $BUN -ArgumentList "server.ts" -WorkingDirectory $cwd -WindowStyle Hidden `
  -RedirectStandardOutput "$cwd\logs\studio.out.log" -RedirectStandardError "$cwd\logs\studio.err.log"
Write-Host "LoRA Studio launching: http://127.0.0.1:8890"
