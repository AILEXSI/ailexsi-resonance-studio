# AILEXSI Resonance Studio Suite V4.01

Local-first multi-track video/audio editor (NLE).

**Logo:** `AILEXSI Resonance Studio Suite V4.01`  
**Repo:** https://github.com/AILEXSI/ailexsi-resonance-studio  
**Dev server:** `http://localhost:1421`

## Quick start (Windows)

```powershell
git clone https://github.com/AILEXSI/ailexsi-resonance-studio.git
cd ailexsi-resonance-studio
npm install
npm run dev
```

Open **http://localhost:1421**

### Required packages

| Package | Why |
|---------|-----|
| `mediabunny@1.54.0` | H.264/AAC MP4 via WebCodecs |
| `@tauri-apps/api@1.5.6` | Optional desktop path (Vite must resolve imports) |
| `vite@5.4.21` | Do **not** force-upgrade |

**Never run** `npm audit fix --force` — it breaks Vite 5.

## Shortcuts

| Key | Action |
|-----|--------|
| **V** | Cut / razor at playhead |
| **C** | unbound (Ctrl+C = copy) |
| Space | Play / pause |
| M | Marker |
| Delete | Delete selected clip |

## Export architecture (important)

```
Timeline (V1/V2 + A1/A2)
        │
        ▼
  jobFromProject()     src/core/exporter/from-project.ts
        │
        ▼
  exportTimeline()     src/core/exporter/index.ts  (watchdog)
        │
        ▼
  WebCodecs + Mediabunny   → real H.264 (+ AAC if available) MP4
        │
   success → download .mp4
   failure → STOP (no silent WebM fallback)
```

- Browser: WebCodecs path only for “success”
- MediaRecorder WebM is **not** a success path when WebCodecs exists
- Desktop (optional): `npm run tauri:dev` + system `ffmpeg`

## Project layout

```
src/
  App.tsx                 UI + timeline + export dialog + shortcuts
  styles.css
  main.tsx
  core/
    models.ts             Project / Track / Clip types
    media-store.ts        IndexedDB blobs
    project-store.ts      localStorage project JSON
    tauri-export.ts       optional desktop save
    exporter/
      index.ts            public API + watchdog
      from-project.ts     Studio project → ExportJob
      planner.ts          timeline segments
      media.ts            video/audio load + seek cache
      types.ts
      backends/
        webcodecs.ts      H.264/AAC MP4 (browser)
        ffmpeg.ts         system ffmpeg (Node/desktop)
        native.ts         future Rust stub
```

## Safe further development

1. **One export path** — do not reintroduce silent MediaRecorder success after plugin failure.
2. **Cut stays on V** — never bind bare C to cut.
3. **Version in UI** — `APP_VERSION` in `App.tsx` + `package.json` version stay in sync.
4. **Port 1421 only** when killing processes.
5. **Vite 5.4.x** — pin it; no major bumps without a dedicated branch.
6. **Blob media** — after reload, re-import if sources show `missing:`.

## Next: V4.2

Planned in a **new** repo (or branch) after this baseline is tagged:

- Still-image frame painter
- Stronger pre-export media hydration
- Optional full removal of MediaRecorder code path
- Architecture notes: see `ARCHITECTURE.md`

## License

UNLICENSED / AILEXSI private.
