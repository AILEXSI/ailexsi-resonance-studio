# AILEXSI Resonance Studio — Component Blueprints

Standalone modules that will later be integrated into this host application (and the future Tauri build).

All modules follow the same principles:

- Local-first
- AI proposes, Human decides
- Original media/timeline stays untouched
- Clean typed contracts between modules
- No AGPL / copyleft contamination

---

## Module Map

```
User imports videos + audio
        │
        ▼
┌─────────────────────┐
│  ailexsi-analyser   │  ← scans lanes + sound → AnalysisSnapshot
└─────────┬───────────┘
          │ Snapshot (JSON)
          ▼
┌─────────────────────┐
│  ailexsi-regisseur  │  ← builds Proposal for a *new* video track
└─────────┬───────────┘
          │ Proposal (pending)
          ▼
   Human Accept / Reject
          │
          ▼ (if accepted)
   New track appears in Studio
          │
          ▼
┌─────────────────────┐
│  ailexsi-exporter   │  ← renders timeline → MP4
└─────────────────────┘

Live visual layer (parallel):
┌─────────────────────┐
│  ailexsi-visualz    │  ← audio-reactive visuals (Canvas/WebGL from scratch)
└─────────────────────┘

Supporting native layer:
┌─────────────────────┐
│  ailexsi-decoder    │  ← Tauri/Rust media access (waveforms, frames, thumbs)
└─────────────────────┘
```

---

## Repositories

| Module | Repo | Role |
|--------|------|------|
| Analyser | https://github.com/AILEXSI/ailexsi-analyser | Feature extraction (beats, energy, scenes, motion, inventory) |
| Regisseur | https://github.com/AILEXSI/ailexsi-regisseur | Creative proposals (new video track + cut points) |
| Visualz | https://github.com/AILEXSI/ailexsi-visualz | Audio-reactive visualizer engine (from scratch) |
| Decoder | https://github.com/AILEXSI/ailexsi-decoder | Native media layer for Tauri |
| Exporter | https://github.com/AILEXSI/ailexsi-exporter | Timeline → MP4 |

---

## Current Blueprint Status (2026-08-15)

- Analyser, Regisseur, Decoder, Exporter, **Visualz** all have complete READMEs + type contracts + SPEC docs
- Analyser & Regisseur have runnable TypeScript skeletons
- Visualz has `createVisualEngine` skeleton + scene registry
- Exporter has `exportTimeline` skeleton
- Decoder has TypeScript binding stubs ready for Tauri commands

Next implementation work (home / Grok Build App):

1. Real audio feature extraction (Web Audio first, then Decoder)
2. Real scene/motion analysis
3. First 4 Visualz scenes (pulse-orb, spectrum-bars, particle-field, resonance-wave)
4. Better heuristic + optional LLM path in Regisseur
5. FFmpeg wiring in Exporter
6. Tauri + Decoder integration

---

## Integration Rule

Never let any module silently mutate the project.
Always go through Proposal → Human Decision → Apply.
