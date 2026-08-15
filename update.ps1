# AILEXSI Resonance Studio — update & clean start
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

Write-Host "==> git pull" -ForegroundColor Cyan
git pull origin main

Write-Host "==> free port 1421" -ForegroundColor Cyan
try {
  $conns = Get-NetTCPConnection -LocalPort 1421 -ErrorAction SilentlyContinue
  if ($conns) {
    $conns | ForEach-Object {
      Write-Host "    killing PID $($_.OwningProcess)"
      Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
    }
  } else {
    Write-Host "    port 1421 is free"
  }
} catch {
  # fallback
  npx --yes kill-port 1421 2>$null
}

Write-Host "==> npm install" -ForegroundColor Cyan
npm install

Write-Host "==> npm audit fix (safe, no --force)" -ForegroundColor Cyan
npm audit fix 2>$null

Write-Host ""
Write-Host "Fertig. Starte mit:  npm run dev" -ForegroundColor Green
Write-Host "Browser: http://localhost:1421 (oder anderer Port laut Terminal)" -ForegroundColor Green
