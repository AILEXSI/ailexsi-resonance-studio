/**
 * AILEXSI Exporter — Types
 * Version: 1.0.0
 */

export interface RenderOptions {
  width: number;
  height: number;
  fps: number;
  videoBitrate?: string;
  audioBitrate?: string;
  format: "mp4";
  outputPath: string;
  includeAudio: boolean;
}

export interface ExportClip {
  id: string;
  startMs: number;
  endMs: number;
  sourcePath: string;
  sourceInMs?: number;
  sourceOutMs?: number;
  label?: string;
}

export interface ExportTrack {
  id: string;
  kind: "VIDEO" | "AUDIO";
  clips: ExportClip[];
}

export interface ExportJob {
  id: string;
  projectId: string;
  timeline: {
    durationMs: number;
    tracks: ExportTrack[];
  };
  options: RenderOptions;
}

export interface ExportProgress {
  percent: number;
  stage: string;
  currentTimeMs?: number;
}

export interface ExportResult {
  outputPath: string;
  durationMs: number;
  fileSizeBytes: number;
  success: boolean;
  error?: string;
  blob?: Blob;
  backend?: "webcodecs" | "ffmpeg" | "native";
}

export type ProgressCallback = (progress: ExportProgress) => void;

export interface ExportHooks {
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
}
