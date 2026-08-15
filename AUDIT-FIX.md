# npm audit — safe fix (do NOT use --force → Vite 8)

Audit wants `vite@8` = **breaking**. We stay on **Vite 5.4.x** + **esbuild override**.

```powershell
cd C:\Users\marti\ResonanceStudio
# after applying this package.json:
Remove-Item package-lock.json -ErrorAction SilentlyContinue
npm install
npm audit
npm run dev
```

Remaining warnings that only touch **dev server / vitest** on localhost are acceptable until a Vite 5/6 patch exists without major 8.
