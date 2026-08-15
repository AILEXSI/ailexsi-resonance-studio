# AILEXSI Resonance Studio V0.2.0 — Testplan

## Start
```powershell
cd C:\Users\marti\ResonanceStudio
# after unzip/copy
npm run dev
```
Open http://localhost:1421

## 1. Media & Reload
1. New project → Import 1 video + 1 WAV
2. Place on V1 / A1, play
3. Hard refresh (F5) → media should still play (IndexedDB)
4. If missing: ↻ Re-import All → select same files by name

## 2. Timeline edit
1. Drag clip horizontally
2. Drag clip V1 → V2 (same kind)
3. Cut (C) at playhead
4. Ctrl+C / Ctrl+V paste
5. Ctrl+Z undo, Ctrl+Y redo
6. Snap ON (button or S) — drag near clip edge should stick

## 3. Zoom & frames
1. Set playhead on a cut
2. Zoom slider → zooms around playhead
3. ← → frame step
4. Fit resets view

## 4. IN / OUT / Loop
1. Zoom in
2. **Right-click** ruler → IN (green)
3. **Right-click** further → OUT (orange)
4. Green region shade visible
5. 🔁 Loop ON → Play → should cycle IN↔OUT
6. Left-click ruler only seeks (no new marker)

## 5. Waveform
1. Audio clips on A1/A2 show white peak bars inside the clip
2. Zoom in → waveform still visible

## 6. Export
1. Set IN/OUT range
2. Export → filename → Start
3. Should render only the range duration
4. Cancel works mid-render
5. Without IN/OUT → full timeline

## 7. Master
1. Play → MAIN meter moves
2. Fader changes loudness

## Known limits (honest)
- Export is WebM (browser), not ProRes/MP4
- Undo is best-effort (not every micro-drag frame)
- No Tauri native file paths yet
- AI Propose is rule-based stub
