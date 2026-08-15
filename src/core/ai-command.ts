/**
 * AILEXSI Resonance Studio — AI Command Service (V0.1)
 * Deterministic / rule-based proposals. No silent mutation.
 * Philosophy matches packages/cultivation: proposal → human decision → optional Vault write.
 */

import type { Project, ProjectEditProposal, Marker } from "./models";

function uid(): string {
  return crypto.randomUUID();
}

function nearestBeat(ms: number, beats: number[]): number | null {
  if (!beats.length) return null;
  let best = beats[0];
  let bestDist = Math.abs(ms - best);
  for (const b of beats) {
    const d = Math.abs(ms - b);
    if (d < bestDist) {
      best = b;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Produce at least one real project-edit proposal from natural language + current project.
 * V0.1: rule-based. Later: LLM adapter behind the same interface.
 */
export function generateProposal(
  project: Project,
  naturalLanguage: string
): ProjectEditProposal {
  const nl = naturalLanguage.trim().toLowerCase();
  const now = new Date().toISOString();

  const beatMs: number[] = project.markers
    .filter((m) => m.kind === "beat")
    .map((m) => m.timeMs);

  // Rule 1: sync / align to beat
  if (
    (nl.includes("sync") || nl.includes("align") || nl.includes("synchronize")) &&
    (nl.includes("beat") || nl.includes("kick"))
  ) {
    const videoTrack = project.tracks.find((t) => t.kind === "VIDEO");
    const clip = videoTrack?.clips[0] ?? project.tracks.flatMap((t) => t.clips)[0];
    if (clip && beatMs.length) {
      const target = nearestBeat(clip.range.startMs, beatMs);
      if (target != null && target !== clip.range.startMs) {
        const delta = target - clip.range.startMs;
        return {
          id: uid(),
          createdAt: now,
          source: "rule",
          naturalLanguage,
          rationale: `Nearest beat is at ${target} ms (delta ${delta > 0 ? "+" : ""}${delta} ms). Moving clip start to that beat keeps visual onset locked to the musical event.`,
          operations: [
            {
              op: "sync_to_beat",
              targetId: clip.id,
              payload: { newStartMs: target, previousStartMs: clip.range.startMs },
            },
          ],
          status: "pending",
          previewDiff: `Move clip "${clip.label || clip.id.slice(0, 8)}" by ${delta} ms`,
        };
      }
    }
  }

  // Rule 2: set playhead
  if (nl.includes("playhead") || nl.includes("go to") || nl.includes("seek")) {
    const match = nl.match(/(\d+)\s*(ms|s|sec|seconds?)?/);
    let targetMs = 0;
    if (match) {
      const n = parseInt(match[1], 10);
      targetMs = match[2]?.startsWith("s") ? n * 1000 : n;
    }
    return {
      id: uid(),
      createdAt: now,
      source: "rule",
      naturalLanguage,
      rationale: `Set playhead to ${targetMs} ms.`,
      operations: [{ op: "set_playhead", payload: { playheadMs: targetMs } }],
      status: "pending",
      previewDiff: `Playhead → ${targetMs} ms`,
    };
  }

  // Rule 3: add marker
  if (nl.includes("marker") || nl.includes("mark")) {
    return {
      id: uid(),
      createdAt: now,
      source: "rule",
      naturalLanguage,
      rationale: `Add marker at current playhead (${project.playheadMs} ms).`,
      operations: [
        {
          op: "add_marker",
          payload: {
            timeMs: project.playheadMs,
            label: "AI marker",
            kind: "ai",
          },
        },
      ],
      status: "pending",
      previewDiff: `+ marker @ ${project.playheadMs} ms`,
    };
  }

  // Fallback
  return {
    id: uid(),
    createdAt: now,
    source: "rule",
    naturalLanguage,
    rationale:
      "No deterministic rule matched. In V0.1 only a few patterns are implemented (sync to beat, set playhead, add marker). Provide a clearer command or accept that this is a proposal stub.",
    operations: [],
    status: "pending",
    previewDiff: "(no change)",
  };
}

/** Apply an accepted proposal. Pure. Never called automatically. */
export function applyProposal(project: Project, proposal: ProjectEditProposal): Project {
  if (proposal.status !== "accepted") {
    throw new Error("Only accepted proposals may be applied");
  }
  let next: Project = {
    ...project,
    updatedAt: new Date().toISOString(),
    proposals: project.proposals.map((p) =>
      p.id === proposal.id ? { ...p, status: "accepted" } : p
    ),
    decisions: [
      ...project.decisions,
      {
        proposalId: proposal.id,
        decision: "accepted",
        at: new Date().toISOString(),
      },
    ],
  };

  for (const op of proposal.operations) {
    switch (op.op) {
      case "set_playhead": {
        const ms = Number(op.payload.playheadMs ?? 0);
        next = { ...next, playheadMs: ms };
        break;
      }
      case "add_marker": {
        const marker: Marker = {
          id: uid(),
          timeMs: Number(op.payload.timeMs ?? next.playheadMs),
          label: String(op.payload.label ?? "Marker"),
          kind: (op.payload.kind as Marker["kind"]) ?? "custom",
        };
        next = { ...next, markers: [...next.markers, marker] };
        break;
      }
      case "sync_to_beat":
      case "move_clip": {
        const targetId = op.targetId;
        const newStart = Number(op.payload.newStartMs ?? op.payload.startMs);
        if (targetId != null && !Number.isNaN(newStart)) {
          next = {
            ...next,
            tracks: next.tracks.map((t) => ({
              ...t,
              clips: t.clips.map((c) => {
                if (c.id !== targetId) return c;
                const dur = c.range.endMs - c.range.startMs;
                return {
                  ...c,
                  range: { startMs: newStart, endMs: newStart + dur },
                };
              }),
            })),
          };
        }
        break;
      }
      default:
        break;
    }
  }
  return next;
}

export function rejectProposal(project: Project, proposalId: string): Project {
  return {
    ...project,
    updatedAt: new Date().toISOString(),
    proposals: project.proposals.map((p) =>
      p.id === proposalId ? { ...p, status: "rejected" } : p
    ),
    decisions: [
      ...project.decisions,
      {
        proposalId,
        decision: "rejected",
        at: new Date().toISOString(),
      },
    ],
  };
}
