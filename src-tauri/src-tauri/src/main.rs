#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Serialize)]
struct ExportResult {
    ok: bool,
    path: String,
    message: String,
}

fn find_ffmpeg() -> Result<PathBuf, String> {
    // 1) PATH
    #[cfg(target_os = "windows")]
    let which_cmd = ("where", "ffmpeg");
    #[cfg(not(target_os = "windows"))]
    let which_cmd = ("which", "ffmpeg");

    if let Ok(out) = Command::new(which_cmd.0).arg(which_cmd.1).output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            if let Some(line) = s.lines().next() {
                let line = line.trim();
                if !line.is_empty() && Path::new(line).exists() {
                    return Ok(PathBuf::from(line));
                }
            }
        }
    }

    // 2) Common Windows install locations
    #[cfg(target_os = "windows")]
    {
        let candidates = [
            r"C:\ffmpeg\bin\ffmpeg.exe",
            r"C:\ProgramData\chocolatey\bin\ffmpeg.exe",
            r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
            r"C:\Program Files (x86)\ffmpeg\bin\ffmpeg.exe",
        ];
        for c in candidates {
            let p = PathBuf::from(c);
            if p.exists() {
                return Ok(p);
            }
        }
        // winget links often under local app data
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let winget = PathBuf::from(&local).join(r"Microsoft\WinGet\Packages");
            if winget.exists() {
                if let Ok(walk) = std::fs::read_dir(&winget) {
                    for entry in walk.flatten() {
                        let bin = entry.path().join(r"ffmpeg-*-full_build\bin\ffmpeg.exe");
                        // glob manually
                        if let Ok(sub) = std::fs::read_dir(entry.path()) {
                            for s in sub.flatten() {
                                let ff = s.path().join("bin").join("ffmpeg.exe");
                                if ff.exists() {
                                    return Ok(ff);
                                }
                            }
                        }
                        let _ = bin;
                    }
                }
            }
        }
    }

    Err(
        "ffmpeg not found. Install with: winget install Gyan.FFmpeg — then restart Resonance Studio"
            .into(),
    )
}

#[tauri::command]
fn export_webm_to_mp4(input_path: String, output_path: String) -> Result<ExportResult, String> {
    let ffmpeg = find_ffmpeg()?;
    let input = PathBuf::from(&input_path);
    let output = PathBuf::from(&output_path);

    if !input.exists() {
        return Err(format!("input not found: {input_path}"));
    }
    if let Some(parent) = output.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let output_run = Command::new(&ffmpeg)
        .args([
            "-y",
            "-i",
            input.to_str().unwrap_or(&input_path),
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            output.to_str().unwrap_or(&output_path),
        ])
        .output()
        .map_err(|e| format!("ffmpeg spawn failed: {e}"))?;

    if !output_run.status.success() {
        let err = String::from_utf8_lossy(&output_run.stderr);
        let short: String = err.chars().rev().take(500).collect::<String>().chars().rev().collect();
        return Err(format!("ffmpeg error: {short}"));
    }
    if !output.exists() {
        return Err("ffmpeg finished but output missing".into());
    }

    Ok(ExportResult {
        ok: true,
        path: output.display().to_string(),
        message: format!("MP4 saved: {}", output.display()),
    })
}

#[tauri::command]
fn check_ffmpeg() -> Result<String, String> {
    let p = find_ffmpeg()?;
    Ok(p.display().to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![export_webm_to_mp4, check_ffmpeg])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
