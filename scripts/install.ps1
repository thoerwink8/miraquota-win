# 注册登录触发的计划任务，让 provider 随登录常驻。
#   install.ps1              注册
#   install.ps1 -Uninstall   注销
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$TaskName = 'MiraQuota'

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "已注销计划任务 $TaskName。"
  exit 0
}

# provider 绝对路径（本脚本在 scripts\ 下，provider 在 ..\provider\）。
$provider = Join-Path (Split-Path $PSScriptRoot -Parent) 'provider\miraquota-provider.mjs'
if (-not (Test-Path $provider)) { Write-Error "找不到 $provider"; exit 1 }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Error "PATH 里找不到 node，请先装 Node 22+。"; exit 1 }

# 无窗口后台运行。计划任务会在崩溃时不自动拉起——provider 自身足够稳，
# 需要看门狗时另配；这里保持最小。
$action = New-ScheduledTaskAction -Execute $node `
  -Argument "`"$provider`"" -WorkingDirectory (Split-Path $provider -Parent)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force | Out-Null

Write-Host "已注册计划任务 $TaskName（登录自启）。"
Write-Host "立即启动一次： Start-ScheduledTask -TaskName $TaskName"
Write-Host "注意：控件出现还需 Mirasim 带调试端口启动，见 scripts\mirasim-debug.ps1"
