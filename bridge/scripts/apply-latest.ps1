# Apply LATEST from bridge folder of ailexsi-resonance-studio
$ErrorActionPreference = "Stop"
$Repo = if ($env:AILEXSI_RS) { $env:AILEXSI_RS } else { "C:\Users\marti\ailexsi-resonance-studio" }
$Target = "C:\Users\marti\ResonanceStudio"

Set-Location $Repo
git pull origin main 2>$null

$latest = Get-Content .\bridge\LATEST.json -Raw | ConvertFrom-Json
if ($latest.status -ne "ready") {
  Write-Host "STOP: status=$($latest.status)" -ForegroundColor Yellow
  return
}

$payload = Join-Path $Repo "bridge" $latest.path "payload"
if (-not (Test-Path $payload)) {
  Write-Host "STOP: payload missing $payload — use Downloads zip until full payload is on GitHub" -ForegroundColor Red
  return
}

Write-Host "Applying $($latest.product) $($latest.version)" -ForegroundColor Cyan
Get-NetTCPConnection -LocalPort 1421 -EA SilentlyContinue | % { Stop-Process -Id $_.OwningProcess -Force -EA SilentlyContinue }

Get-ChildItem $payload -Force | Where-Object {
  $_.Name -notin @('.env','.env.local','.git','node_modules')
} | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $Target $_.Name) -Recurse -Force
}

Set-Location $Target
npm install
@{ version = $latest.version; appliedAt = (Get-Date).ToString("o") } | ConvertTo-Json | Set-Content .\bridge-state.json
Write-Host "DROP FERTIG $($latest.version)" -ForegroundColor Green
