#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;

#[derive(Debug, Serialize)]
struct ExportResult {
    ok: bool,
    path: String,
    message: String,
}

/// Locate ffmpeg on PATH (Windows `where`, Unix `which`)
fn find_ffmpeg() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        let out = Command::new("where")
            .arg("ffmpeg")
            .output()
            .map_err(|e| format!("where ffmpeg failed: {e}"))?;
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            let line = s.lines().next().unwrap_or("").trim();
            if !line.is_empty() {
                return Ok(PathBuf::from(line));
            }
        }
        return Err(
            "ffmpeg not found on PATH. Install: https://ffmpeg.org/download.html or `winget install FFmpeg`"
                .into(),
        );
    }
    #[cfg(not(target_os = "windows"))]
    {
        let out = Command::new("which")
            .arg("ffmpeg")
            .output()
            .map_err(|e| format!("which ffmpeg failed: {e}"))?;
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout);
            let line = s.lines().next().unwrap_or("").trim();
            if !line.is_empty() {
                return Ok(PathBuf::from(line));
            }
        }
        Err("ffmpeg not found on PATH. Install ffmpeg (apt/brew).".into())
    }
}

/// Convert a recorded WebM (or any media) file to H.264 AAC MP4 via system ffmpeg.
#[tauri::command]
fn export_webm_to_mp4(input_path: String, output_path: String) -> Result<ExportResult, String> {
    let ffmpeg = find_ffmpeg()?;
    let input = PathBuf::from(&input_path);
    let output = PathBuf::from(&output_path);

    if !input.exists() {
        return Err(format!("input not found: {input_path}"));
    }

    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let status = Command::new(&ffmpeg)
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

    if !status.status.success() {
        let err = String::from_utf8_lossy(&status.stderr);
        return Err(format!("ffmpeg failed: {err}"));
    }

    if !output.exists() {
        return Err("ffmpeg finished but output file missing".into());
    }

    Ok(ExportResult {
        ok: true,
        path: output.display().to_string(),
        message: format!("MP4 written: {}", output.display()),
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
