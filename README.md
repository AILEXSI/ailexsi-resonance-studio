# AILEXSI Resonance Studio

**Local-first creative product** for Music + Video + Voice + Lyrics + Motion + Timing + AI + Memory.

This is the **product**.  
`ailexsi-core-vault-v2` is the **immutable infrastructure / foundation**.

```
AILEXSI
├── ailexsi-core                  ← normative contracts
├── ailexsi-core-vault-v2         ← canonical Vault (GREEN freeze, immutable)
└── ailexsi-resonance-studio     ← THIS PRODUCT
       ├── consumes Vault via vault-adapter/
       ├── Media Engine
       ├── Timeline
       ├── Analysis
       ├── AI Proposal (co-creator, never owner)
       └── Human Interaction
```

## Hard Rules

1. **Never nest this product inside the Vault repository.**
2. **Never modify** `ailexsi-core-vault-v2` or Core from this repo.
3. Vault is only accessed through `src/vault-adapter/`.
4. AI suggestions are proposals. They require explicit human Accept / Reject / Adjust.
5. No silent mutation of project state.
6. User data stays local and user-owned.

## Quick Start (local)

```bash
cd ResonanceStudio   # or whatever you named the folder
npm install
npm run dev
```

Open http://localhost:1421

## V0.1 Vertical Slice

- Project create / load / save (localStorage)
- Import audio or video
- Timeline with tracks: VIDEO · AUDIO · BEATS · AI_EVENTS
- Playhead + basic playback
- AI Command Bar with deterministic proposals
  - “Synchronize … with the next beat”
  - “Add marker”
  - “Set playhead to …”
- Accept / Reject proposal (no silent apply)
- Vault boundary present (stub in V0.1)

## Next slices

- Real BPM / onset analysis adapter
- wavesurfer.js waveform
- Deeper Vault integration (accepted creative decisions → Memory via command-adapter)
- Tauri packaging for native file system

## Architecture note for future agents

If you are an AI coding agent working on this product:

- This repository is the **only** place you write product code.
- Treat `ailexsi-core-vault-v2` as a pinned, read-only dependency.
- Do not create `apps/resonance-studio` inside the Vault monorepo.
- Keep the human as final creative authority.
