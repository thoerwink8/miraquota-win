param([string]$Path, [int]$StepY = 8, [int]$StepX = 4)
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($Path)
$bmp = New-Object System.Drawing.Bitmap $img
$chars = @('#', 'X', 'x', 'o', '.', ' ')
$out = ''
for ($y = 0; $y -lt $bmp.Height; $y += $StepY) {
  $line = ''
  for ($x = 0; $x -lt $bmp.Width; $x += $StepX) {
    $c = $bmp.GetPixel($x, $y)
    $lum = (0.3 * $c.R + 0.6 * $c.G + 0.1 * $c.B)
    $idx = [Math]::Min(5, [int]($lum / 51))
    $line += $chars[$idx]
  }
  $out += $line + "`n"
}
Write-Output $out
$bmp.Dispose(); $img.Dispose()
