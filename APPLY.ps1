# Standalone apply from Downloads (same as update.ps1, for paste into GrokBot)
$ErrorActionPreference = 'Stop'
$zip = Get-ChildItem "$env:USERPROFILE\Downloads\ResonanceStudio-V0.4*.zip" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $zip) { $zip = Get-Item "$env:USERPROFILE\Downloads\ResonanceStudio-V0.4.1-exporter.zip" -EA SilentlyContinue }
if (-not $zip) { throw "Zip not found in Downloads (ResonanceStudio-V0.4*.zip)" }
$root = Join-Path $env:USERPROFILE 'ResonanceStudio'
New-Item -ItemType Directory -Force -Path $root | Out-Null

Get-NetTCPConnection -LocalPort 1421 -State Listen -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 400

$tmp = Join-Path $env:TEMP ("rs-v041-" + [guid]::NewGuid().ToString('N'))
Expand-Archive -Path $zip.FullName -DestinationPath $tmp -Force
$inner = $tmp
if (Test-Path "$tmp\ailexsi-resonance-studio") { $inner = "$tmp\ailexsi-resonance-studio" }
if (Test-Path "$tmp\ResonanceStudio-V0.4.1-exporter") { $inner = "$tmp\ResonanceStudio-V0.4.1-exporter" }

Get-ChildItem $inner -Force | Where-Object { $_.Name -notin @('.env','.git','node_modules','src-tauri\target') } | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $root $_.Name) -Recurse -Force
}

$viteCache = Join-Path $root 'node_modules\.vite'
if (Test-Path $viteCache) { Remove-Item $viteCache -Recurse -Force -EA SilentlyContinue }

Set-Location $root
npm install
npm install mediabunny@^1.54.0 --save
Write-Host "V0.4.1 applied. Cut=V. Export=WebCodecs MP4."
npm run dev
