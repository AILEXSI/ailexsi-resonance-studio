# Resonance Studio V0.4.1 — exporter hard-wired

## What was broken
The WebCodecs MP4 plugin path was present, but **any failure silently fell through to MediaRecorder → WebM**. That is why Downloads still showed `.webm` after "export".

## What V0.4.1 fixes
1. **Plugin path is authoritative** — on success or failure it stops. No silent WebM.
2. **AAC probe** — tries several AAC configs; if none work, still writes a valid H.264 video-only MP4.
3. **ftyp validation** — refuses to claim success without a real MP4 container.
4. **Watchdog** — encode never hangs at 90%.
5. **Cut key = V** — C is free; Ctrl+C/V stay copy/paste.
6. **Vite cache wipe** in update/APPLY scripts so old App.tsx cannot stick.

## Apply
1. Put `ResonanceStudio-V0.4.1-exporter.zip` in Downloads
2. Run `APPLY.ps1` or `update.ps1` (kills only port 1421)
3. `npm run dev` → Demo reel / Import → Export

## Expect
- File: `Downloads\<name>.mp4` (not .webm)
- Flash: `MP4 ready · X.XX MB · webcodecs`
- Cut: press **V** at playhead
