# 安装登录自启：在用户「启动」文件夹放一个隐藏窗口启动器（免管理员权限）。
#   install.ps1              安装并立即启动
#   install.ps1 -Uninstall   卸载（删启动器并停掉在跑的 provider）
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$startup = [Environment]::GetFolderPath('Startup')
$launcher = Join-Path $startup 'MiraQuota.vbs'

if ($Uninstall) {
  Remove-Item $launcher -ErrorAction SilentlyContinue
  # 停掉在跑的 provider（按命令行识别，不误杀别的 node）。
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*miraquota-provider.mjs*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host "已卸载：删除启动器并停止 provider。状态目录 ~/.miraquota 保留，需要可手动删。"
  exit 0
}

$provider = Join-Path (Split-Path $PSScriptRoot -Parent) 'provider\miraquota-provider.mjs'
if (-not (Test-Path $provider)) { Write-Error "找不到 $provider"; exit 1 }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Error "PATH 里找不到 node，请先装 Node 22+。"; exit 1 }

# VBS 以隐藏窗口起 node，登录后无黑框常驻。
$vbs = "CreateObject(""WScript.Shell"").Run """"""$node"""" """"$provider"""""", 0, False"
Set-Content -Path $launcher -Value $vbs -Encoding ASCII
Write-Host "已安装启动器：$launcher"

# 立即启动一份（已在跑则跳过）。
$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*miraquota-provider.mjs*' }
if ($running) {
  Write-Host "provider 已在运行（PID $($running.ProcessId -join ', ')），跳过启动。"
} else {
  Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$launcher`""
  Write-Host "provider 已在后台启动。"
}
Write-Host "验证： curl http://127.0.0.1:4988/quota.json"
Write-Host "注意：控件出现还需 Mirasim 带调试端口启动，见 scripts\mirasim-debug.ps1"
