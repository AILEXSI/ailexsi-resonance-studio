/**
 * AILEXSI Resonance Studio — Core domain models (V0.1.1)
 * Local-first, data-first. Analysis is always honest (never fake capabilities).
 */

export type TrackKind =
  | "VIDEO"
  | "AUDIO"
  | "VOCAL"
  | "LYRICS"
  | "BEATS"
  | "AI_EVENTS";

export interface TimeRange {
  startMs: number;
  endMs: number;
}

export interface Clip {
  id: string;
  trackId: string;
  mediaAssetId?: string;
  range: TimeRange;
  sourceRange?: TimeRange;
  label?: string;
  metadata?: Record<string, unknown>;
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  clips: Clip[];
  locked?: boolean;
  muted?: boolean;
  height?: number;
}

export interface Marker {
  id: string;
  timeMs: number;
  label: string;
  kind?: "beat" | "cut" | "section" | "ai" | "custom";
}

export interface MediaAsset {
  id: string;
  type: "audio" | "video" | "image";
  name: string;
  localPathOrUrl: string;
  durationMs: number;
  analysis?: {
    bpm?: number;
    beatPositionsMs?: number[];
    waveformPeaks?: number[];
    width?: number;
    height?: number;
  };
}

export type ProposalStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "adjusted"
  | "deferred";

export interface ProjectEditProposal {
  id: string;
  createdAt: string;
  source: "rule" | "llm" | "user";
  naturalLanguage: string;
  rationale: string;
  operations: Array<{
    op:
      | "move_clip"
      | "trim_clip"
      | "add_marker"
      | "sync_to_beat"
      | "add_clip"
      | "set_playhead";
    targetId?: string;
    payload: Record<string, unknown>;
  }>;
  status: ProposalStatus;
  previewDiff?: string;
}

export interface DecisionRecord {
  proposalId: string;
  decision: "accepted" | "rejected" | "adjusted";
  at: string;
  vaultMemoryId?: string;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  mediaAssets: MediaAsset[];
  tracks: Track[];
  markers: Marker[];
  playheadMs: number;
  durationMs: number;
  proposals: ProjectEditProposal[];
  decisions: DecisionRecord[];
  vaultRefs?: string[];
}

/** V0.1.1: two video + two audio lanes for crossover cuts */
export function createEmptyProject(name = "Untitled Resonance"): Project {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name,
    createdAt: now,
    updatedAt: now,
    mediaAssets: [],
    tracks: [
      { id: crypto.randomUUID(), kind: "VIDEO", name: "V1", clips: [] },
      { id: crypto.randomUUID(), kind: "VIDEO", name: "V2", clips: [] },
      { id: crypto.randomUUID(), kind: "AUDIO", name: "A1", clips: [] },
      { id: crypto.randomUUID(), kind: "AUDIO", name: "A2", clips: [] },
      { id: crypto.randomUUID(), kind: "BEATS", name: "Beats", clips: [] },
      { id: crypto.randomUUID(), kind: "AI_EVENTS", name: "AI Events", clips: [] },
    ],
    markers: [],
    playheadMs: 0,
    durationMs: 0,
    proposals: [],
    decisions: [],
    vaultRefs: [],
  };
}

/** Migrate older single-track projects to multi-track layout */
export function ensureMultiTrack(project: Project): Project {
  const videoTracks = project.tracks.filter((t) => t.kind === "VIDEO");
  const audioTracks = project.tracks.filter((t) => t.kind === "AUDIO");
  if (videoTracks.length >= 2 && audioTracks.length >= 2) return project;

  const empty = createEmptyProject(project.name);
  const v1 = empty.tracks.find((t) => t.name === "V1")!;
  const a1 = empty.tracks.find((t) => t.name === "A1")!;

  const migratedVideos =
    videoTracks[0]?.clips.map((c) => ({ ...c, trackId: v1.id })) ?? [];
  const migratedAudios =
    audioTracks[0]?.clips.map((c) => ({ ...c, trackId: a1.id })) ?? [];

  return {
    ...project,
    tracks: empty.tracks.map((t) => {
      if (t.name === "V1") return { ...t, clips: migratedVideos };
      if (t.name === "A1") return { ...t, clips: migratedAudios };
      if (t.kind === "BEATS" || t.kind === "AI_EVENTS") {
        const old = project.tracks.find((x) => x.kind === t.kind);
        return old ? { ...t, clips: old.clips.map((c) => ({ ...c, trackId: t.id })) } : t;
      }
      return t;
    }),
  };
}

/** Blob URLs die after reload; missing: was written on Save */
export function isPlayableMediaUrl(url: string | undefined): boolean {
  if (!url) return false;
  if (url.startsWith("missing:")) return false;
  if (url.startsWith("blob:")) return true; // valid only in current session
  if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("file:")) return true;
  return false;
}

/** Mark dead blob/missing URLs so UI can ask for re-import without crashing playback */
export function sanitizeMediaAssets(project: Project): Project {
  return {
    ...project,
    mediaAssets: project.mediaAssets.map((a) => {
      if (!a.localPathOrUrl || a.localPathOrUrl.startsWith("blob:")) {
        // After reload all blobs are dead — mark for re-import
        return { ...a, localPathOrUrl: `missing:${a.name}` };
      }
      return a;
    }),
  };
}
