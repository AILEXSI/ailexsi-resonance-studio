import type { ExportHooks, ExportJob, ExportResult } from "../types";

/** Reserved for the future Rust / Tauri sidecar path. */
export async function exportWithNative(
  job: ExportJob,
  _hooks: ExportHooks = {},
): Promise<ExportResult> {
  return {
    outputPath: job.options.outputPath,
    durationMs: job.timeline.durationMs,
    fileSizeBytes: 0,
    success: false,
    error: "Native Rust backend is not wired yet — use webcodecs or ffmpeg",
    backend: "native",
  };
}
