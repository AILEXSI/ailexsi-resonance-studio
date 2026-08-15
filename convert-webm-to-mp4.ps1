# Convert latest Resonance WebM in Downloads → MP4 via ffmpeg
$ErrorActionPreference = "Stop"

$ff = Get-Command ffmpeg -ErrorAction SilentlyContinue
if (-not $ff) {
  Write-Host "ffmpeg fehlt. Install: winget install Gyan.FFmpeg" -ForegroundColor Red
  exit 1
}

$dl = Join-Path $env:USERPROFILE "Downloads"
$webm = Get-ChildItem "$dl\*.webm" -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (-not $webm) {
  Write-Host "Keine .webm in Downloads gefunden" -ForegroundColor Yellow
  exit 1
}

$out = Join-Path $webm.DirectoryName ($webm.BaseName + ".mp4")
Write-Host "Convert: $($webm.Name) → $($webm.BaseName).mp4" -ForegroundColor Cyan

& ffmpeg -y -i $webm.FullName `
  -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p `
  -c:a aac -b:a 192k -movflags +faststart `
  $out

if (Test-Path $out) {
  Write-Host "OK: $out" -ForegroundColor Green
  explorer.exe /select,$out
} else {
  Write-Host "ffmpeg fehlgeschlagen" -ForegroundColor Red
  exit 1
}
