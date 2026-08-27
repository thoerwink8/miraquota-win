# 在桌面创建两个快捷方式：带调试端口启动 Mirasim / 启动额度 provider。
# 用法： powershell -ExecutionPolicy Bypass -File scripts\make-shortcuts.ps1

$ErrorActionPreference='Stop'
$desk = [Environment]::GetFolderPath('Desktop')
$root = 'D:\frank\miraquota-win'
$ws = New-Object -ComObject WScript.Shell

# 1. 带调试端口重启 Mirasim（控件随后出现）
$s1 = $ws.CreateShortcut((Join-Path $desk 'Mirasim 带额度控件启动.lnk'))
$s1.TargetPath = 'powershell.exe'
$s1.Arguments = "-ExecutionPolicy Bypass -File `"$root\scripts\mirasim-debug.ps1`" -Force"
$s1.WorkingDirectory = $root
$s1.IconLocation = "$env:LOCALAPPDATA\Programs\@mirasimdesktop\Mirasim.exe,0"
$s1.Description = '带调试端口重启 Mirasim，额度控件随即出现在标题栏'
$s1.Save()

# 2. 启动/重启额度 provider（供数进程）
$s2 = $ws.CreateShortcut((Join-Path $desk '额度控件 provider.lnk'))
$s2.TargetPath = 'wscript.exe'
$s2.Arguments = "`"$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\MiraQuota.vbs`""
$s2.WorkingDirectory = $root
$s2.IconLocation = 'shell32.dll,167'
$s2.Description = '启动额度控件的后台供数进程（无窗口）'
$s2.Save()

Get-ChildItem $desk -Filter '*.lnk' | Where-Object { $_.Name -like '*额度*' -or $_.Name -like '*Mirasim*' } | Select-Object Name, Length | Format-Table -Auto
