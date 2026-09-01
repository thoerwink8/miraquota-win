# 抓 MiraQuota 主窗口截图（调试用草稿，未跟踪）。用法：.shot.ps1 -Out C:\temp\shot.png
# 用 PrintWindow(PW_RENDERFULLCONTENT)：窗口被别的窗口盖住也能抓到真实内容，
# 不依赖 SetForegroundWindow（跨进程常被系统拒绝，会抓到上层窗口）。
param([string]$Path = "$env:TEMP\miraquota-shot.png")
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  public struct R { public int L, T, Rr, B; }
}
"@
$p = Get-Process MiraQuota,electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { Write-Error 'MiraQuota 没有可见窗口'; exit 1 }
$r = New-Object W+R
[void][W]::GetWindowRect($p.MainWindowHandle, [ref]$r)
$w = $r.Rr - $r.L; $h = $r.B - $r.T
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
[void][W]::PrintWindow($p.MainWindowHandle, $dc, 2)
$g.ReleaseHdc($dc)
$bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output $Path
