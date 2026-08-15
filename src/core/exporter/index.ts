/**
 * AILEXSI Exporter — public API
 * Local-first timeline → H.264/AAC MP4. Never hangs at 90%.
 */
import { canUseWebCodecs, exportWithWebCodecs, probeH264 } from "./backends/webcodecs";
import { planTimeline } from "./planner";
import type { ExportHooks, ExportJob, ExportResult } from "./types";

export type { ProgressCallback } from "./types";
export * from "./types";
export { planTimeline } from "./planner";
export { canUseWebCodecs, probeH264 } from "./backends/webcodecs";
export { jobFromProject } from "./from-project";

export function detectBackend(): "webcodecs" | "ffmpeg" {
  if (typeof window !== "undefined" && canUseWebCodecs()) return "webcodecs";
  if (typeof process !== "undefined" && process.versions?.node) return "ffmpeg";
  return "webcodecs";
}

export async function exportTimeline(
  job: ExportJob,
  opts?: ExportHooks,
): Promise<ExportResult> {
  const onProgress = opts?.onProgress;
  onProgress?.({ percent: 0, stage: "Validating job" });
  if (!job?.timeline) return emptyFail(job, "Invalid export job");
  if (!job.timeline.tracks.length) return emptyFail(job, "No tracks to export");
  if (job.timeline.durationMs < 80) return emptyFail(job, "Nothing to render");
  const plan = planTimeline(job);
  if (!plan.segments.length) return emptyFail(job, "Empty timeline plan");
  const backend = detectBackend();
  const hardMs = Math.max(30_000, plan.durationMs * 6 + 20_000);
  const run = async (): Promise<ExportResult> => {
    if (backend === "ffmpeg" && typeof window === "undefined") {
      const { exportWithFfmpeg } = await import("./backends/ffmpeg");
      return await exportWithFfmpeg(job, opts);
    }
    return await exportWithWebCodecs(job, opts);
  };
  try {
    return await Promise.race([
      run(),
      new Promise<ExportResult>((_, reject) =>
        setTimeout(() => reject(new Error("Export watchdog timeout")), hardMs),
      ),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      outputPath: job.options.outputPath || "",
      durationMs: job.timeline.durationMs,
      fileSizeBytes: 0,
      success: false,
      error: msg,
      backend,
    };
  }
}

function emptyFail(job: ExportJob | undefined, error: string): ExportResult {
  return {
    outputPath: job?.options.outputPath || "",
    durationMs: job?.timeline.durationMs ?? 0,
    fileSizeBytes: 0,
    success: false,
    error,
  };
}
