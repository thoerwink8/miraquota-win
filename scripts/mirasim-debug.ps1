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
#
# 必须等进程全部退干净：Mirasim 是单实例应用，旧实例还在退出途中时，新进程会把
# 自己的命令行参数交给旧实例后自退——参数就此丢失，调试端口不会打开，
# 而两次启动在任务管理器里看起来毫无区别（这正是首次实测踩到的坑）。
Get-Process -Name 'Mirasim' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Process -Name 'Mirasim' -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 500
}
if (Get-Process -Name 'Mirasim' -ErrorAction SilentlyContinue) {
  Write-Warning "仍有 Mirasim 进程未退出，参数可能被单实例机制丢弃。请手动全部关闭后重试。"
}
Start-Sleep -Seconds 2   # 单实例锁释放留出余量
Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=$Port"

# 验证端口真的开了：只看「启动命令发出去了」会把丢参数的失败当成功。
$ok = $false
$deadline = (Get-Date).AddSeconds(40)
while (-not $ok -and (Get-Date) -lt $deadline) {
  Start-Sleep -Seconds 2
  try {
    $null = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
    $ok = $true
  } catch { }
}
if ($ok) {
  Write-Host "已带 --remote-debugging-port=$Port 启动 Mirasim，调试端口已就绪。"
  Write-Host "provider 会在 10 秒内自动注入控件（未运行则先跑 scripts\install.ps1）。"
} else {
  Write-Warning "Mirasim 已启动，但 $Port 上没有调试端口——参数很可能被单实例机制丢弃。"
  Write-Warning "请把所有 Mirasim 窗口关干净（任务管理器里确认无 Mirasim.exe），再跑一次本脚本。"
  exit 1
}
