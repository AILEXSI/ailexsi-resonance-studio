# Apply ResonanceStudio zip into this folder
$ErrorActionPreference = "Stop"
$Target = $PSScriptRoot
$z = Get-ChildItem "$env:USERPROFILE\Downloads\ResonanceStudio-V*.zip" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $z) { Write-Host "No ResonanceStudio-V*.zip in Downloads"; exit 1 }
Write-Host "Applying $($z.Name)"
Get-NetTCPConnection -LocalPort 1421 -EA SilentlyContinue | % { Stop-Process -Id $_.OwningProcess -Force -EA SilentlyContinue }
$temp = Join-Path $env:TEMP ("rs-" + [guid]::NewGuid().ToString("N").Substring(0,8))
Expand-Archive $z.FullName $temp -Force
$root = $temp
if (Test-Path "$temp\ailexsi-resonance-studio") { $root = "$temp\ailexsi-resonance-studio" }
Get-ChildItem $root -Force | Where-Object { $_.Name -notin @('.env','.git','node_modules','src-tauri\target') } | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $Target $_.Name) -Recurse -Force
}
Set-Location $Target
npm install
Write-Host "Browser: npm run dev | Desktop MP4: npm run tauri:dev (needs Rust + ffmpeg)"
