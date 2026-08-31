/**
 * Windows 会话令牌自动发现。
 *
 * 现行 Mirasim 的 `/v1/limits` 要求带会话令牌，令牌只存在于 Mirasim 拉起的会话进程
 * 环境变量里。两代约定并存：
 *  - 旧版（≤0.0.25x 早期）：`ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`，令牌在
 *    `ANTHROPIC_AUTH_TOKEN`，请求时放 `x-api-key` 头。
 *  - 新版（0.0.257 起）：令牌并进 URL 路径 `http://127.0.0.1:<port>/<token>`，
 *    `ANTHROPIC_AUTH_TOKEN` 换成了上游凭据、对 /v1/limits 无效（实测 invalid x-api-key）。
 * 这里两种都带回去，由 engine 按「有路径用路径、没路径用头」组装请求。
 * macOS / Linux 用 `ps eww` 读得到；Windows 的 `Get-CimInstance` 不暴露
 * 进程环境，参考实现因此要求手工传令牌。
 *
 * 这里改用 PEB 内存读取还原自动发现：`NtQueryInformationProcess` 取 PEB 基址，
 * 沿 `ProcessParameters → Environment` 读出目标进程的环境块。同用户、同完整性级别的
 * 进程可读，无需管理员。本机实测（Win11 x64）能稳定读出会话端口与令牌配对。
 *
 * 偏移量为 Win10/11 x64 标准布局：PEB+0x20 = ProcessParameters，
 * ProcessParameters+0x80 = Environment，+0x3F0 = EnvironmentSize。
 */
import { execFile } from 'node:child_process';

const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -Namespace Win32 -Name Peb -MemberDefinition @'
[DllImport("ntdll.dll")]
public static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PROCESS_BASIC_INFORMATION pbi, int len, ref int ret);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern IntPtr OpenProcess(int access, bool inherit, int pid);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, ref int read);
[DllImport("kernel32.dll")]
public static extern bool CloseHandle(IntPtr h);
[StructLayout(LayoutKind.Sequential)]
public struct PROCESS_BASIC_INFORMATION { public IntPtr Reserved1; public IntPtr PebBaseAddress; public IntPtr R2a; public IntPtr R2b; public IntPtr UniqueProcessId; public IntPtr R3; }
'@
function Read-Ptr($h,$addr){ $b=New-Object byte[] 8; $r=0; [void][Win32.Peb]::ReadProcessMemory($h,$addr,$b,8,[ref]$r); [IntPtr][BitConverter]::ToInt64($b,0) }
function Get-ProcEnv($procId) {
  $h=[Win32.Peb]::OpenProcess((0x10 -bor 0x400),$false,$procId)
  if($h -eq [IntPtr]::Zero){ return $null }
  try{
    $pbi=New-Object Win32.Peb+PROCESS_BASIC_INFORMATION; $ret=0
    if([Win32.Peb]::NtQueryInformationProcess($h,0,[ref]$pbi,[System.Runtime.InteropServices.Marshal]::SizeOf($pbi),[ref]$ret) -ne 0){return $null}
    $procParams=Read-Ptr $h ([IntPtr]($pbi.PebBaseAddress.ToInt64()+0x20))
    $envPtr=Read-Ptr $h ([IntPtr]($procParams.ToInt64()+0x80))
    $lenB=New-Object byte[] 4; $r=0
    [void][Win32.Peb]::ReadProcessMemory($h,[IntPtr]($procParams.ToInt64()+0x3F0),$lenB,4,[ref]$r)
    $envLen=[BitConverter]::ToInt32($lenB,0)
    if($envLen -le 0 -or $envLen -gt 2000000){$envLen=131072}
    $buf=New-Object byte[] $envLen
    [void][Win32.Peb]::ReadProcessMemory($h,$envPtr,$buf,$envLen,[ref]$r)
    [System.Text.Encoding]::Unicode.GetString($buf,0,$r)
  } finally { [void][Win32.Peb]::CloseHandle($h) }
}
# 只扫可能承载会话的进程，减少无谓的内存读取。
$targets = Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'node|claude|codex|cmd|pwsh|powershell' } | Select-Object -Expand ProcessId
$seen = @{}
foreach($procId in $targets){
  $blk = Get-ProcEnv $procId
  if(-not $blk){ continue }
  if($blk -match 'ANTHROPIC_BASE_URL=http://127\.0\.0\.1:(\d+)(/[^\x00]*)?' ){
    $port=$Matches[1]
    $path=if($Matches[2]){$Matches[2]}else{'-'}
    $tok='-'
    if($blk -match 'ANTHROPIC_AUTH_TOKEN=([^\x00]+)'){ $tok=$Matches[1] }
    $key="$port$path"
    if(-not $seen.ContainsKey($key)){ $seen[$key]=$true; "$port $path $tok" }
  }
}
`;

/**
 * 返回 [{ port, path, token }]，来自本机 Mirasim 会话进程的环境。
 * `path` 是并在 URL 里的令牌路径（新版），`token` 是 header 令牌（旧版）；缺失为 null。
 * 非 Windows 或读取失败时返回空数组，由调用方退回 relay 帧口径。
 */
export function discoverSessionTokens() {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
      { timeout: 12_000, maxBuffer: 4 << 20, windowsHide: true },
      (err, stdout) => {
        if (err && !stdout) return resolve([]);
        const out = [];
        for (const line of String(stdout || '').split(/\r?\n/)) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 3) continue;
          const port = Number(parts[0]);
          const path = parts[1] === '-' ? null : parts[1].replace(/\/+$/, '');
          const token = parts[2] === '-' ? null : parts[2];
          if (port && (path || token)) out.push({ port, path, token });
        }
        resolve(out);
      });
  });
}
