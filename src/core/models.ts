/**
 * AILEXSI Resonance Studio — Core domain models (V0.1)
 * Local-first, data-first. Analysis is always honest (never fake capabilities).
 */

export type TrackKind =
  | "VIDEO"
  | "AUDIO"
  | "VOCAL"
  | "LYRICS"
  | "BEATS"
  | "AI_EVENTS";
// future: FACE | LIP | CAMERA | MOTION | SFX | SEMANTIC | ENERGY

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

export function createEmptyProject(name = "Untitled Resonance"): Project {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name,
    createdAt: now,
    updatedAt: now,
    mediaAssets: [],
    tracks: [
      { id: crypto.randomUUID(), kind: "VIDEO", name: "Video", clips: [] },
      { id: crypto.randomUUID(), kind: "AUDIO", name: "Audio", clips: [] },
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
