# Architecture — Resonance Studio Suite V4.01

## Intent

Efficient **local** multi-track timeline → **real MP4** (H.264 + AAC when possible).

Not a cloud renderer. Not ffmpeg.wasm as primary path. Not “WebM counts as done”.

## Layers

1. **UI / Timeline (`App.tsx`)**  
   Tracks V1/V2 (video), A1/A2 (audio), playhead, range (loop in/out), import, shortcuts.

2. **Persistence**  
   - Project JSON: `localStorage` via `project-store`  
   - Media binaries: IndexedDB via `media-store` (blob URLs at runtime)

3. **Export pipeline (`src/core/exporter`)**  
   - `jobFromProject` maps clips + asset URLs into an `ExportJob`  
   - `planTimeline` builds segments / frame count  
   - `exportWithWebCodecs` paints frames to canvas, encodes H.264, mixes audio → AAC, muxes MP4  
   - Watchdog in `exportTimeline` prevents hang-at-90%

4. **Desktop optional (`tauri-export`, `src-tauri`)**  
   Native dialog + ffmpeg when running under Tauri. Browser builds still need `@tauri-apps/api` installed so Vite can resolve dynamic imports.

## Hard rules (do not break)

| Rule | Reason |
|------|--------|
| No silent WebM after plugin fail | User thought MP4 worked; got VP8 WebM |
| Cut = V only | C must stay free for Ctrl+C copy |
| Show `APP_VERSION` in logo | Detect partial applies |
| Pin Vite 5 + mediabunny | Major bumps broke installs |
| Kill only port 1421 | Other apps on machine |

## Data flow (export)

```
mediaAssets[].localPathOrUrl  (blob: / file: / http:)
        │
clips on VIDEO/AUDIO tracks (range + sourceRange)
        │
jobFromProject → ExportJob.timeline + options (1280x720@30, mp4)
        │
planTimeline → frameCount, segments
        │
per-frame: top VIDEO clip → seek → drawImage on canvas → CanvasSource.add
audio: OfflineAudioContext mix (AUDIO tracks, else VIDEO sources) → AAC
        │
Mp4OutputFormat finalize → Blob → download as .mp4
```

## Known limits (V4.01)

- Still images (`type: image`) not fully painted in exporter (video-element path)
- Long timelines: encode time ≈ duration × factor; watchdog scales with duration
- After full page reload, blob URLs may need **Re-import**
- GitHub history before this commit is 0.1.x baseline only

## Resume checklist for next session

1. Clone / pull this repo @ V4.01  
2. `npm install` (mediabunny + @tauri-apps/api must appear under node_modules)  
3. `npm run dev` → logo **Suite V4.01**, shortcuts **V Cut · C free**  
4. New work on **V4.2** → new branch or new repo; do not destabilize this baseline without a tag
