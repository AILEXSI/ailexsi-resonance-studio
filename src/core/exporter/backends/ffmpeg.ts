import { planTimeline } from "../planner";
import type { ExportHooks, ExportJob, ExportResult } from "../types";

/**
 * Node / desktop FFmpeg backend.
 * Uses system ffmpeg when available. Browser callers never hit this path.
 */
export async function exportWithFfmpeg(
  job: ExportJob,
  hooks: ExportHooks = {},
): Promise<ExportResult> {
  const { onProgress } = hooks;
  const plan = planTimeline(job);
  onProgress?.({ percent: 4, stage: "Planning FFmpeg graph" });

  if (typeof process === "undefined" || !process.versions?.node) {
    return {
      outputPath: job.options.outputPath,
      durationMs: plan.durationMs,
      fileSizeBytes: 0,
      success: false,
      error: "FFmpeg backend requires Node or Tauri",
      backend: "ffmpeg",
    };
  }

  const { spawn } = await import("node:child_process");
  const { existsSync, statSync } = await import("node:fs");

  const video = firstPlayable(job, "VIDEO");
  const audio = firstPlayable(job, "AUDIO");
  if (!video) {
    return {
      outputPath: job.options.outputPath,
      durationMs: plan.durationMs,
      fileSizeBytes: 0,
      success: false,
      error: "No local video source for FFmpeg",
      backend: "ffmpeg",
    };
  }

  onProgress?.({ percent: 15, stage: "Encoding with FFmpeg" });

  const args = buildArgs(job, video, audio);
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", reject);
    child.on("close", (c) => resolve(c ?? 1));
  });

  if (code !== 0 || !existsSync(job.options.outputPath)) {
    return {
      outputPath: job.options.outputPath,
      durationMs: plan.durationMs,
      fileSizeBytes: 0,
      success: false,
      error: `ffmpeg exited ${code}`,
      backend: "ffmpeg",
    };
  }

  onProgress?.({ percent: 100, stage: "Done" });
  return {
    outputPath: job.options.outputPath,
    durationMs: plan.durationMs,
    fileSizeBytes: statSync(job.options.outputPath).size,
    success: true,
    backend: "ffmpeg",
  };
}

function firstPlayable(job: ExportJob, kind: "VIDEO" | "AUDIO") {
  for (const t of job.timeline.tracks.filter((x) => x.kind === kind)) {
    for (const c of t.clips) {
      if (c.sourcePath && !c.sourcePath.startsWith("blob:") && !c.sourcePath.startsWith("missing:")) {
        return c;
      }
    }
  }
  return null;
}

function buildArgs(
  job: ExportJob,
  video: { sourcePath: string; startMs: number; endMs: number; sourceInMs?: number },
  audio: { sourcePath: string; startMs: number; sourceInMs?: number } | null,
) {
  const dur = Math.max(0.2, (video.endMs - video.startMs) / 1000);
  const vss = ((video.sourceInMs ?? 0) / 1000).toFixed(3);
  const args = [
    "-y",
    "-ss",
    vss,
    "-t",
    dur.toFixed(3),
    "-i",
    video.sourcePath,
  ];
  if (audio) {
    args.push(
      "-ss",
      ((audio.sourceInMs ?? 0) / 1000).toFixed(3),
      "-t",
      dur.toFixed(3),
      "-i",
      audio.sourcePath,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0?",
    );
  }
  args.push(
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
    job.options.audioBitrate || "192k",
    "-movflags",
    "+faststart",
    "-s",
    `${job.options.width}x${job.options.height}`,
    job.options.outputPath,
  );
  return args;
}
