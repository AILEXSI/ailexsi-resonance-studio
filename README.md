# AILEXSI Resonance Studio

**Local-first creative product** for Music + Video + Voice + Lyrics + Motion + Timing + AI + Memory.

`ailexsi-core-vault-v2` remains the **immutable foundation**. This product **consumes** it via `vault-adapter/` — never modifies Core/Vault packages.

## V0.1.1 Vertical Slice

- Import audio + video
- **Multi-track timeline**: V1, V2, A1, A2 (crossover cuts)
- Playback with top-video priority (V2 over V1)
- Dual audio tracks
- Drag clips · Cut at playhead (C) · Delete
- **Save / Open / Export** project as `.resonance.json`
- AI command bar (rule-based proposals · Accept/Reject)
- Local vault stub (honest — no fake cloud)

### Run

```bash
npm install
npm run dev
```

Open http://localhost:1421

### Shortcuts

| Key | Action |
|-----|--------|
| Space | Play / Pause |
| C | Cut at playhead |
| Del | Delete selected clip |
| Ctrl+S | Save project JSON |

### Workflow

1. **New** project
2. **Import** media (targets V1/A1 by default; set target track in left panel)
3. Place second video on **V2** for crossover
4. Drag · Cut · Play
5. **Save** / **Export** `.resonance.json`

### Philosophy

> Your memory belongs to you.  
> Your creative history belongs to you.  
> Your style belongs to you.

AI proposes. Human decides.
