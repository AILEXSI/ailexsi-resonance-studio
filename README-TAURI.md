# AILEXSI Resonance Studio — Desktop (Tauri) V0.3.0

Local-first creative NLE with **native H.264 MP4 export** via system **ffmpeg**.

## Prerequisites (Windows)

1. **Node.js 20+**
2. **Rust** — https://rustup.rs/  
   ```powershell
   winget install Rustlang.Rustup
   ```
3. **Microsoft C++ Build Tools** (Visual Studio Build Tools) — required by Tauri on Windows
4. **WebView2** — usually already on Windows 10/11
5. **ffmpeg** on PATH:
   ```powershell
   winget install Gyan.FFmpeg
   # or: winget install FFmpeg
   ffmpeg -version
   ```

## Install & run (dev)

```powershell
cd C:\Users\marti\ResonanceStudio
npm install
npm run tauri:dev
```

Opens the **desktop window** (not only the browser). Export uses **ffmpeg → MP4**.

## Production build

```powershell
npm run tauri:build
```

Installer / binary under:
`src-tauri/target/release/bundle/`

## Export behavior

| Runtime | Output |
|---------|--------|
| **Tauri desktop** + ffmpeg | **`.mp4`** (H.264 + AAC) |
| **Browser** (`npm run dev`) | `.webm` (stable) or native MP4 if browser supports it |

## Commands (Rust)

- `check_ffmpeg` — path to ffmpeg
- `export_webm_to_mp4` — convert recorded blob file → MP4

## Notes

- First `tauri:dev` / `tauri:build` compiles Rust (can take several minutes).
- Without ffmpeg on PATH, desktop export falls back to WebM download with an error toast.
