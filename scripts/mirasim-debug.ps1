# 让 Mirasim 带 CDP 调试端口重启，控件才有处可注入。
# Mirasim 只从命令行接受 --remote-debugging-port，没有环境变量或配置项。
#
# 警告：这会关掉当前运行的 Mirasim，其下所有会话进程随之结束。
# 有正在跑的会话时先存好工作再执行。
param(
  [int]$Port = 9333,
  [switch]$Force   # 跳过确认直接重启
)

$ErrorActionPreference = 'Stop'

# 定位 Mirasim 可执行文件。
$exe = Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like '*server.cjs*' } |
  ForEach-Object { ($_.CommandLine -split '"')[1] } |
  Where-Object { $_ -like '*Mirasim.exe' } |
  Select-Object -First 1

if (-not $exe) {
  $exe = Join-Path $env:LOCALAPPDATA 'Programs\@mirasimdesktop\Mirasim.exe'
}
if (-not (Test-Path $exe)) {
  Write-Error "找不到 Mirasim.exe，请手动指定路径。探测值：$exe"
  exit 1
}
Write-Host "Mirasim: $exe"

# 已带同一调试端口在跑就无需重启。
$already = Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -like "*--remote-debugging-port=$Port*" }
if ($already) {
  Write-Host "Mirasim 已带调试端口 $Port 运行，无需重启。"
  exit 0
}

if (-not $Force) {
  $running = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*server.cjs*' }
  if ($running) {
    Write-Warning "Mirasim 正在运行。带调试端口重启会结束当前所有会话进程。"
    $ans = Read-Host "继续？输入 y 确认"
    if ($ans -ne 'y') { Write-Host "已取消。"; exit 0 }
  }
}

# 关掉现有 Mirasim（含渲染/会话子进程），再带端口拉起。
Get-Process -Name 'Mirasim' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=$Port"
Write-Host "已带 --remote-debugging-port=$Port 启动 Mirasim。"
Write-Host "现在起 provider： node provider\miraquota-provider.mjs"
