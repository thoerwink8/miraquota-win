@echo off
REM MiraQuota 轻客户端引导：双击即用（用户 2026-09-02：不要让人粘命令，给个能双击的）。
REM 只做两件事：把 lite.ps1 下到 %USERPROFILE%\.miraquota，再用 PowerShell 跑它的引导流程。
REM 之后每 10 分钟的上传由它注册的计划任务负责，本文件不再需要。
setlocal
set "INBOX=__INBOX_URL__"
set "DIR=%USERPROFILE%\.miraquota"
if not exist "%DIR%" mkdir "%DIR%"
echo.
echo   MiraQuota 轻客户端
echo   收件口 %INBOX%
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ProgressPreference='SilentlyContinue';" ^
  "try { $t=(Invoke-WebRequest -UseBasicParsing -Uri '%INBOX%/lite.ps1').Content;" ^
  "[IO.File]::WriteAllText('%DIR%\lite.ps1', $t, (New-Object Text.UTF8Encoding $true));" ^
  "exit 0 } catch { Write-Host ('下载脚本失败：' + $_.Exception.Message) -ForegroundColor Red; exit 1 }"
if errorlevel 1 goto :end
powershell -NoProfile -ExecutionPolicy Bypass -File "%DIR%\lite.ps1"
:end
echo.
pause
