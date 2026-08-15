import type { ExportJob } from "./types";

export interface StudioClip {
  id: string;
  range: { startMs: number; endMs: number };
  sourceRange?: { startMs: number; endMs: number };
  mediaAssetId?: string;
  label?: string;
}

export interface StudioTrack {
  id: string;
  kind: string;
  clips: StudioClip[];
}

export interface StudioAsset {
  id: string;
  name: string;
  localPathOrUrl: string;
  type: string;
}

export interface StudioProject {
  id: string;
  name: string;
  durationMs: number;
  tracks: StudioTrack[];
  mediaAssets: StudioAsset[];
}

export function jobFromProject(
  project: StudioProject,
  opts?: {
    width?: number;
    height?: number;
    fps?: number;
    rangeStartMs?: number;
    rangeEndMs?: number;
    fileName?: string;
  },
): ExportJob {
  const start = opts?.rangeStartMs ?? 0;
  const end = opts?.rangeEndMs ?? project.durationMs;
  const assets = new Map(project.mediaAssets.map((a) => [a.id, a]));

  return {
    id: crypto.randomUUID(),
    projectId: project.id,
    timeline: {
      durationMs: Math.max(0, end - start),
      tracks: project.tracks
        .filter((t) => t.kind === "VIDEO" || t.kind === "AUDIO")
        .map((t) => ({
          id: t.id,
          kind: t.kind as "VIDEO" | "AUDIO",
          clips: t.clips
            .filter((c) => c.range.endMs > start && c.range.startMs < end)
            .map((c) => {
              const asset = c.mediaAssetId ? assets.get(c.mediaAssetId) : undefined;
              const shift = start;
              return {
                id: c.id,
                startMs: Math.max(0, c.range.startMs - shift),
                endMs: Math.max(0, c.range.endMs - shift),
                sourcePath: asset?.localPathOrUrl || "",
                sourceInMs: c.sourceRange?.startMs ?? 0,
                sourceOutMs: c.sourceRange?.endMs,
                label: c.label || asset?.name,
              };
            }),
        })),
    },
    options: {
      width: opts?.width ?? 1280,
      height: opts?.height ?? 720,
      fps: opts?.fps ?? 30,
      format: "mp4",
      outputPath: `${(opts?.fileName || project.name || "resonance").replace(/[^\w\-]+/g, "_")}.mp4`,
      includeAudio: true,
      videoBitrate: "8M",
      audioBitrate: "192k",
    },
  };
}
