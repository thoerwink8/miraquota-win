# MiraQuota 轻客户端（不装应用的机器用）。
#
# 做什么：把这台机器 Mirasim 写的本地用量记录（~/.mirasim/insights/usage-*.ndjson）里
# 经官方 relay 且成功的行，原样上传到收件口；定价、合并都在读它的那一端做，
# 这里不带价目表，将来价目表变了也不用管这台机器。
#
# 首次运行（双击 lite.bat 或不带参数）：引导输入名字 / 自设口令 / 邀请码，注册后
# 建一个每 10 分钟跑一次的计划任务，然后立刻上传一次。
#   -Upload     计划任务用：静默上传一次
#   -Uninstall  删计划任务与本地配置
#
# 兼容 Windows 自带的 PowerShell 5.1。
param([switch]$Upload, [switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Inbox = 'https://miraquota-inbox.miraquota.workers.dev'
$Dir = Join-Path $env:USERPROFILE '.miraquota'
$Cfg = Join-Path $Dir 'lite.json'
$Insights = Join-Path $env:USERPROFILE '.mirasim\insights'
$TaskName = 'MiraQuotaLite'
$Retention = 8 * 86400

function Say($msg, $color = 'Gray') { Write-Host $msg -ForegroundColor $color }

function Read-Plain($prompt) {
  $s = Read-Host -AsSecureString $prompt
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

function Post($path, $obj) {
  $body = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress))
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$Inbox$path" -ContentType 'application/json' -Body $body
    return @{ status = [int]$r.StatusCode; body = $r.Content }
  } catch {
    $resp = $_.Exception.Response
    if ($resp -eq $null) { throw }
    $reader = New-Object IO.StreamReader($resp.GetResponseStream())
    return @{ status = [int]$resp.StatusCode; body = $reader.ReadToEnd() }
  }
}

function ErrorText($res) {
  try { return (($res.body | ConvertFrom-Json).error) } catch { return $res.body }
}

function Clean-MachineId($name) {
  $id = ($name.ToLower() -replace '[^a-z0-9-]+', '-').Trim('-')
  if ($id.Length -gt 40) { $id = $id.Substring(0, 40) }
  if (-not $id) { $id = 'machine' }
  return $id
}

function New-InstallId {
  $bytes = New-Object byte[] 8
  (New-Object Security.Cryptography.RNGCryptoServiceProvider).GetBytes($bytes)
  return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Load-Config {
  if (-not (Test-Path $Cfg)) { return $null }
  try { return (Get-Content $Cfg -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

# 读用量记录 → v2 分片（原始行）。只收经 relay 且 200 的行——那才是会扣点的全集。
function Build-Shard($cfg) {
  $now = [int][double]::Parse((Get-Date -UFormat %s))
  $cutoff = $now - $Retention
  $rows = New-Object Collections.Generic.List[object]
  if (Test-Path $Insights) {
    foreach ($f in Get-ChildItem $Insights -Filter 'usage-*.ndjson') {
      foreach ($line in [IO.File]::ReadLines($f.FullName)) {
        if (-not $line) { continue }
        try { $r = $line | ConvertFrom-Json } catch { continue }
        if ($r.upstreamHost -ne 'relay.mirasim.ai' -or $r.status -ne 200 -or -not $r.model) { continue }
        try { $t = [int][double]::Parse((Get-Date ([DateTime]$r.ts).ToUniversalTime() -UFormat %s)) } catch { continue }
        if ($t -lt $cutoff) { continue }
        $row = @{ t = $t; m = [string]$r.model; i = [double]($r.input + 0); o = [double]($r.output + 0); cr = [double]($r.cacheRead + 0); cw = [double]($r.cacheWrite + 0) }
        if ($r.modelSource -eq 'dispatch') { $row.src = 'dispatch' }
        $rows.Add($row)
      }
    }
  }
  return @{
    schemaVersion = 2
    machineId = $cfg.machineId
    installId = $cfg.installId
    account = $cfg.account
    generatedAt = $now
    coverage = @{ fromSec = $cutoff; toSec = $now }
    rows = $rows
  }
}

function Upload-Once($cfg, $quiet) {
  $shard = Build-Shard $cfg
  $body = [Text.Encoding]::UTF8.GetBytes(($shard | ConvertTo-Json -Compress -Depth 5))
  try {
    Invoke-WebRequest -UseBasicParsing -Method Put -Uri "$Inbox/shard" -ContentType 'application/json' -Body $body `
      -Headers @{ 'x-account' = $cfg.account; 'x-passphrase' = $cfg.passphrase } | Out-Null
    if (-not $quiet) { Say ("已上传 " + $shard.rows.Count + " 行用量（机器 " + $cfg.machineId + "，账号 " + $cfg.account + "）") 'Green' }
    return $true
  } catch {
    $resp = $_.Exception.Response
    $status = if ($resp) { [int]$resp.StatusCode } else { 0 }
    if ($status -eq 429) { if (-not $quiet) { Say '刚上传过，收件口让稍等——计划任务会接着传' 'Yellow' }; return $true }
    if (-not $quiet) { Say ("上传失败（HTTP " + $status + "）：" + $_.Exception.Message) 'Red' }
    return $false
  }
}

if ($Uninstall) {
  schtasks /Delete /TN $TaskName /F 2>$null | Out-Null
  if (Test-Path $Cfg) { Remove-Item $Cfg -Force }
  Say '已删除计划任务与本地配置。' 'Green'
  exit 0
}

if ($Upload) {
  $cfg = Load-Config
  if (-not $cfg) { exit 1 }
  if (Upload-Once $cfg $true) { exit 0 } else { exit 1 }
}

# ---- 首次引导 ----
Say ''
Say '这个小工具会把本机 Mirasim 的用量记录每 10 分钟上传到收件口，' 'White'
Say '让共用这个额度的人在 MiraQuota 里看到「谁花了多少」。' 'White'
Say '只上传每次调用的时间、模型、token 数；不上传对话内容。' 'DarkGray'
Say '收件口在 workers.dev，国内网络要先开代理，否则会连不上。' 'Yellow'
Say ''

$existing = Load-Config
if ($existing) {
  Say ("这台机器已经以「" + $existing.account + "」登录过。") 'Yellow'
  $ans = Read-Host '重新登录请输 y，直接上传一次请回车'
  if ($ans -ne 'y') {
    schtasks /Create /SC MINUTE /MO 10 /TN $TaskName /F /TR ("powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Dir\lite.ps1`" -Upload") | Out-Null
    Upload-Once $existing $false | Out-Null
    exit 0
  }
}

$account = ''
while (-not ($account -match '^[a-z0-9][a-z0-9-]{0,23}$')) {
  $account = (Read-Host '你的名字（小写字母/数字/连字符，1–24 位，例如 fxc）').Trim().ToLower()
  if (-not ($account -match '^[a-z0-9][a-z0-9-]{0,23}$')) { Say '格式不对，再来一次。' 'Red' }
}
$pass = ''
while ($pass.Length -lt 4) {
  $pass = Read-Plain '自己定一个口令（至少 4 位；以后你的其他机器也用它）'
  if ($pass.Length -lt 4) { Say '太短了。' 'Red' }
}

$res = $null
$reg = Post '/login' @{ account = $account; passphrase = $pass }
if ($reg.status -eq 204) {
  Say ("名字「" + $account + "」已存在且口令正确，这台机器加进去。") 'Green'
} else {
  $invite = Read-Host '邀请码（找额度的主人要）'
  $res = Post '/register' @{ account = $account; passphrase = $pass; invite = $invite }
  if ($res.status -eq 201) { Say ("已注册「" + $account + "」。") 'Green' }
  elseif ($res.status -eq 409) { Say '这个名字已经有人用了，而你输的口令不是它的——换个名字重跑。' 'Red'; exit 1 }
  else { Say ("注册失败：" + (ErrorText $res)) 'Red'; exit 1 }
}

$cfg = @{
  inbox = $Inbox
  account = $account
  passphrase = $pass
  installId = if ($existing -and $existing.installId) { $existing.installId } else { New-InstallId }
  machineId = Clean-MachineId $env:COMPUTERNAME
}
if (-not (Test-Path $Dir)) { New-Item -ItemType Directory $Dir | Out-Null }
[IO.File]::WriteAllText($Cfg, ($cfg | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))

schtasks /Create /SC MINUTE /MO 10 /TN $TaskName /F /TR ("powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Dir\lite.ps1`" -Upload") | Out-Null
Say ("已建计划任务 " + $TaskName + "：每 10 分钟上传一次。") 'Green'
Upload-Once $cfg $false | Out-Null
Say ''
Say ("要停掉：powershell -File `"$Dir\lite.ps1`" -Uninstall") 'DarkGray'
