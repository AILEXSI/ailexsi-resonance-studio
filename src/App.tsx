import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createEmptyProject,
  type Project,
  type ProjectEditProposal,
  type MediaAsset,
  type Clip,
} from "./core/models";
import { generateProposal, applyProposal, rejectProposal } from "./core/ai-command";
import { loadProject, saveProject } from "./core/project-store";
import { localOnlyVaultAdapter } from "./vault-adapter";

function formatTime(ms: number): string {
  const totalSec = Math.max(0, ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  const cs = Math.floor((ms % 1000) / 10);
  return `${m}:${s.toString().padStart(2, "0")}.${cs.toString().padStart(2, "0")}`;
}

export function App() {
  const [project, setProject] = useState<Project>(() => loadProject());
  const [command, setCommand] = useState("");
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [pendingProposal, setPendingProposal] = useState<ProjectEditProposal | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);

  // Drag state
  const dragRef = useRef<{
    clipId: string;
    startX: number;
    origStartMs: number;
    durationMs: number;
  } | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const rafRef = useRef<number>(0);
  const lastTick = useRef<number>(0);
  const isSeekingRef = useRef(false);
  const timelineLaneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    saveProject(project);
  }, [project]);

  const duration = Math.max(project.durationMs, 1000);

  const selectedAsset = useMemo(
    () => project.mediaAssets.find((a) => a.id === selectedAssetId) ?? null,
    [project.mediaAssets, selectedAssetId]
  );

  // Active video clip under playhead
  const activeVideoClip = useMemo(() => {
    const videoTrack = project.tracks.find((t) => t.kind === "VIDEO");
    if (!videoTrack) return null;
    return (
      videoTrack.clips.find(
        (c) =>
          project.playheadMs >= c.range.startMs &&
          project.playheadMs < c.range.endMs
      ) ?? null
    );
  }, [project.tracks, project.playheadMs]);

  const activeVideoAsset = useMemo(() => {
    if (!activeVideoClip?.mediaAssetId) {
      // fallback: first video asset
      return project.mediaAssets.find((a) => a.type === "video") ?? null;
    }
    return (
      project.mediaAssets.find((a) => a.id === activeVideoClip.mediaAssetId) ?? null
    );
  }, [activeVideoClip, project.mediaAssets]);

  const audioAsset = project.mediaAssets.find((a) => a.type === "audio") ?? null;
  const muteVideo = !!audioAsset;

  // ---------- SEEK ----------
  const seekTo = useCallback(
    (ms: number) => {
      const clamped = Math.max(0, Math.min(duration, ms));
      isSeekingRef.current = true;
      setProject((p) => ({ ...p, playheadMs: clamped }));
      const t = clamped / 1000;
      if (videoRef.current) {
        try {
          // Map timeline time → source time inside the active clip
          const clip = activeVideoClip;
          if (clip && clip.sourceRange) {
            const offset = clamped - clip.range.startMs;
            const srcT = (clip.sourceRange.startMs + offset) / 1000;
            videoRef.current.currentTime = Math.max(0, srcT);
          } else {
            videoRef.current.currentTime = t;
          }
        } catch {
          /* */
        }
      }
      if (audioRef.current) {
        try {
          audioRef.current.currentTime = t;
        } catch {
          /* */
        }
      }
      requestAnimationFrame(() => {
        isSeekingRef.current = false;
      });
    },
    [duration, activeVideoClip]
  );

  // ---------- PLAYBACK ----------
  const startPlayback = useCallback(async () => {
    setPlayError(null);
    const v = videoRef.current;
    const a = audioRef.current;

    if (v) {
      v.muted = muteVideo;
      // Align source time for active clip
      const clip = activeVideoClip;
      if (clip && clip.sourceRange) {
        const offset = project.playheadMs - clip.range.startMs;
        try {
          v.currentTime = Math.max(0, (clip.sourceRange.startMs + offset) / 1000);
        } catch {
          /* */
        }
      }
    }
    if (a) {
      try {
        a.currentTime = project.playheadMs / 1000;
      } catch {
        /* */
      }
    }

    const promises: Promise<void>[] = [];
    if (v) {
      promises.push(
        v.play().catch((err) => {
          console.warn("[Resonance] video.play() failed:", err);
          setPlayError("Video play blocked: " + (err?.message || String(err)));
          throw err;
        })
      );
    }
    if (a) {
      promises.push(
        a.play().catch((err) => {
          console.warn("[Resonance] audio.play() failed:", err);
          setPlayError("Audio play blocked: " + (err?.message || String(err)));
          throw err;
        })
      );
    }

    try {
      await Promise.all(promises);
      setIsPlaying(true);
    } catch {
      if (v && !v.paused) setIsPlaying(true);
      else if (a && !a.paused) setIsPlaying(true);
      else setIsPlaying(false);
    }
  }, [project.playheadMs, muteVideo, activeVideoClip]);

  const stopPlayback = useCallback(() => {
    videoRef.current?.pause();
    audioRef.current?.pause();
    setIsPlaying(false);
  }, []);

  const togglePlay = useCallback(() => {
    if (isPlaying) stopPlayback();
    else void startPlayback();
  }, [isPlaying, startPlayback, stopPlayback]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muteVideo;
  }, [muteVideo, activeVideoAsset?.id]);

  // When active clip changes during playback, switch video source time
  useEffect(() => {
    if (!isPlaying || !videoRef.current || !activeVideoClip) return;
    const clip = activeVideoClip;
    if (!clip.sourceRange) return;
    const offset = project.playheadMs - clip.range.startMs;
    const srcT = (clip.sourceRange.startMs + Math.max(0, offset)) / 1000;
    try {
      if (Math.abs(videoRef.current.currentTime - srcT) > 0.25) {
        videoRef.current.currentTime = srcT;
        if (isPlaying) videoRef.current.play().catch(() => {});
      }
    } catch {
      /* */
    }
  }, [activeVideoClip?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // rAF clock
  useEffect(() => {
    if (!isPlaying) {
      cancelAnimationFrame(rafRef.current);
      return;
    }
    lastTick.current = performance.now();
    const tick = (now: number) => {
      const dt = now - lastTick.current;
      lastTick.current = now;
      setProject((p) => {
        const max = p.durationMs || duration;
        const next = Math.min(p.playheadMs + dt, max);

        if (!isSeekingRef.current) {
          // Keep audio in sync with timeline
          const a = audioRef.current;
          if (a && Math.abs(a.currentTime - next / 1000) > 0.2) {
            try {
              a.currentTime = next / 1000;
            } catch {
              /* */
            }
          }
          // Video sync handled via active clip mapping
          const v = videoRef.current;
          if (v) {
            const vTrack = p.tracks.find((t) => t.kind === "VIDEO");
            const clip = vTrack?.clips.find(
              (c) => next >= c.range.startMs && next < c.range.endMs
            );
            if (clip?.sourceRange) {
              const offset = next - clip.range.startMs;
              const srcT = (clip.sourceRange.startMs + offset) / 1000;
              if (Math.abs(v.currentTime - srcT) > 0.25) {
                try {
                  v.currentTime = srcT;
                } catch {
                  /* */
                }
              }
            }
          }
        }

        if (next >= max) {
          videoRef.current?.pause();
          audioRef.current?.pause();
          setIsPlaying(false);
          return { ...p, playheadMs: max };
        }
        return { ...p, playheadMs: next };
      });
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isPlaying, duration]);

  // ---------- IMPORT (always APPENDS a new clip) ----------
  const handleImport = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    const file = files[0];
    const url = URL.createObjectURL(file);
    const isVideo = file.type.startsWith("video/");
    const isAudio = file.type.startsWith("audio/");
    if (!isVideo && !isAudio) return;

    let durationMs = 5000;
    if (isVideo) {
      const v = document.createElement("video");
      v.preload = "metadata";
      v.src = url;
      await new Promise<void>((res) => {
        v.onloadedmetadata = () => {
          durationMs = Math.max(200, (v.duration || 5) * 1000);
          res();
        };
        v.onerror = () => res();
      });
    } else {
      const a = document.createElement("audio");
      a.preload = "metadata";
      a.src = url;
      await new Promise<void>((res) => {
        a.onloadedmetadata = () => {
          durationMs = Math.max(200, (a.duration || 5) * 1000);
          res();
        };
        a.onerror = () => res();
      });
    }

    const asset: MediaAsset = {
      id: crypto.randomUUID(),
      type: isVideo ? "video" : "audio",
      name: file.name,
      localPathOrUrl: url,
      durationMs,
      analysis: isAudio
        ? { waveformPeaks: Array.from({ length: 64 }, () => 0.25 + Math.random() * 0.7) }
        : { width: 0, height: 0 },
    };

    const beatMarkers = Array.from({ length: Math.floor(durationMs / 500) + 1 }, (_, i) => ({
      id: crypto.randomUUID(),
      timeMs: i * 500,
      label: `beat ${i + 1}`,
      kind: "beat" as const,
    }));

    const trackKind = isVideo ? "VIDEO" : "AUDIO";

    setProject((p) => {
      const track = p.tracks.find((t) => t.kind === trackKind)!;
      // Place new clip after the last clip on this track (or at 0)
      const lastEnd = track.clips.reduce((m, c) => Math.max(m, c.range.endMs), 0);
      const startMs = lastEnd;

      const clip: Clip = {
        id: crypto.randomUUID(),
        trackId: track.id,
        mediaAssetId: asset.id,
        range: { startMs, endMs: startMs + durationMs },
        sourceRange: { startMs: 0, endMs: durationMs },
        label: file.name,
      };

      return {
        ...p,
        mediaAssets: [...p.mediaAssets, asset],
        durationMs: Math.max(p.durationMs, startMs + durationMs),
        tracks: p.tracks.map((t) =>
          t.id === track.id ? { ...t, clips: [...t.clips, clip] } : t
        ),
        markers:
          isAudio
            ? [...p.markers.filter((m) => m.kind !== "beat"), ...beatMarkers]
            : p.markers,
      };
    });

    setSelectedAssetId(asset.id);
    setIsPlaying(false);
    setPlayError(null);
  }, []);

  // Place existing media asset onto timeline at playhead
  const addAssetToTimeline = useCallback(
    (assetId: string) => {
      const asset = project.mediaAssets.find((a) => a.id === assetId);
      if (!asset) return;
      const trackKind = asset.type === "video" ? "VIDEO" : "AUDIO";
      setProject((p) => {
        const track = p.tracks.find((t) => t.kind === trackKind)!;
        const startMs = p.playheadMs;
        const clip: Clip = {
          id: crypto.randomUUID(),
          trackId: track.id,
          mediaAssetId: asset.id,
          range: { startMs, endMs: startMs + asset.durationMs },
          sourceRange: { startMs: 0, endMs: asset.durationMs },
          label: asset.name,
        };
        return {
          ...p,
          durationMs: Math.max(p.durationMs, startMs + asset.durationMs),
          tracks: p.tracks.map((t) =>
            t.id === track.id ? { ...t, clips: [...t.clips, clip] } : t
          ),
        };
      });
    },
    [project.mediaAssets]
  );

  // ---------- CLIP DRAG ----------
  const onClipPointerDown = useCallback(
    (e: React.PointerEvent, clip: Clip) => {
      e.stopPropagation();
      e.preventDefault();
      setSelectedClipId(clip.id);
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      dragRef.current = {
        clipId: clip.id,
        startX: e.clientX,
        origStartMs: clip.range.startMs,
        durationMs: clip.range.endMs - clip.range.startMs,
      };
    },
    []
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragRef.current || !timelineLaneRef.current) return;
      const laneWidth = timelineLaneRef.current.getBoundingClientRect().width;
      const dx = e.clientX - dragRef.current.startX;
      const dMs = (dx / laneWidth) * duration;
      const newStart = Math.max(0, dragRef.current.origStartMs + dMs);
      const dur = dragRef.current.durationMs;
      const clipId = dragRef.current.clipId;

      setProject((p) => ({
        ...p,
        durationMs: Math.max(p.durationMs, newStart + dur),
        tracks: p.tracks.map((t) => ({
          ...t,
          clips: t.clips.map((c) =>
            c.id === clipId
              ? { ...c, range: { startMs: newStart, endMs: newStart + dur } }
              : c
          ),
        })),
      }));
    };

    const onUp = () => {
      dragRef.current = null;
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [duration]);

  // ---------- SPLIT AT PLAYHEAD ----------
  const splitAtPlayhead = useCallback(() => {
    const ph = project.playheadMs;
    setProject((p) => {
      let changed = false;
      const tracks = p.tracks.map((t) => {
        const newClips: Clip[] = [];
        for (const c of t.clips) {
          if (ph > c.range.startMs + 50 && ph < c.range.endMs - 50) {
            changed = true;
            const leftDur = ph - c.range.startMs;
            const rightDur = c.range.endMs - ph;
            const srcStart = c.sourceRange?.startMs ?? 0;
            newClips.push({
              ...c,
              id: crypto.randomUUID(),
              range: { startMs: c.range.startMs, endMs: ph },
              sourceRange: {
                startMs: srcStart,
                endMs: srcStart + leftDur,
              },
              label: (c.label || "") + " (A)",
            });
            newClips.push({
              ...c,
              id: crypto.randomUUID(),
              range: { startMs: ph, endMs: c.range.endMs },
              sourceRange: {
                startMs: srcStart + leftDur,
                endMs: srcStart + leftDur + rightDur,
              },
              label: (c.label || "") + " (B)",
            });
          } else {
            newClips.push(c);
          }
        }
        return { ...t, clips: newClips };
      });
      return changed ? { ...p, tracks } : p;
    });
  }, [project.playheadMs]);

  // ---------- DELETE SELECTED CLIP ----------
  const deleteSelectedClip = useCallback(() => {
    if (!selectedClipId) return;
    setProject((p) => ({
      ...p,
      tracks: p.tracks.map((t) => ({
        ...t,
        clips: t.clips.filter((c) => c.id !== selectedClipId),
      })),
    }));
    setSelectedClipId(null);
  }, [selectedClipId]);

  // ---------- Timeline click (seek) ----------
  const onTimelineClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (dragRef.current) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      seekTo(pct * duration);
    },
    [duration, seekTo]
  );

  // ---------- AI ----------
  const onCommandSubmit = () => {
    if (!command.trim()) return;
    const proposal = generateProposal(project, command);
    setProject((p) => ({ ...p, proposals: [...p.proposals, proposal] }));
    setPendingProposal(proposal);
    setCommand("");
  };

  const onAccept = async () => {
    if (!pendingProposal) return;
    const accepted = { ...pendingProposal, status: "accepted" as const };
    const next = applyProposal(project, accepted);
    await localOnlyVaultAdapter.persistAcceptedCreativeDecision({
      projectId: next.id,
      proposalId: accepted.id,
      rationale: accepted.rationale,
      naturalLanguage: accepted.naturalLanguage,
    });
    setProject(next);
    setPendingProposal(null);
  };

  const onReject = () => {
    if (!pendingProposal) return;
    setProject(rejectProposal(project, pendingProposal.id));
    setPendingProposal(null);
  };

  const playheadPct = Math.min(100, (project.playheadMs / duration) * 100);
  const vaultStatus = localOnlyVaultAdapter.getStatus();

  // Keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      }
      if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        splitAtPlayhead();
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelectedClip();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, splitAtPlayhead, deleteSelectedClip]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="logo">AILEXSI Resonance</div>
        <nav>
          <button type="button" title="Next slice">Project</button>
          <button type="button" title="Next slice">File</button>
          <button type="button" onClick={splitAtPlayhead} title="Split at playhead (C)">
            Cut
          </button>
          <button type="button" onClick={deleteSelectedClip} title="Delete selected clip">
            Delete
          </button>
          <button type="button" title="Next slice">AI</button>
          <button type="button" title="Next slice">View</button>
          <button type="button" title="Next slice">Export</button>
        </nav>
        <div className="project-name">{project.name}</div>
        <div className="ai-status ready">AI ready · Vault: {vaultStatus.mode}</div>
      </header>

      <aside className="media-panel">
        <h3>Media / Project</h3>
        <div className="media-list">
          {project.mediaAssets.length === 0 && (
            <p className="muted" style={{ padding: 12, lineHeight: 1.55 }}>
              No media yet.<br />Click <strong>New</strong> then <strong>Import</strong>.
            </p>
          )}
          {project.mediaAssets.map((a) => (
            <div
              key={a.id}
              className={`media-item ${selectedAssetId === a.id ? "selected" : ""}`}
              onClick={() => setSelectedAssetId(a.id)}
              onDoubleClick={() => addAssetToTimeline(a.id)}
              title="Double-click to place on timeline at playhead"
            >
              <div className="name">{a.name}</div>
              <div className="meta">
                {a.type} · {formatTime(a.durationMs)}
              </div>
            </div>
          ))}
        </div>
        <div className="media-actions">
          <label>
            <button type="button" onClick={() => document.getElementById("file-input")?.click()}>
              Import
            </button>
            <input
              id="file-input"
              type="file"
              accept="audio/*,video/*"
              hidden
              onChange={(e) => handleImport(e.target.files)}
            />
          </label>
          <button
            type="button"
            onClick={() => {
              stopPlayback();
              project.mediaAssets.forEach((a) => {
                if (a.localPathOrUrl.startsWith("blob:")) {
                  try {
                    URL.revokeObjectURL(a.localPathOrUrl);
                  } catch {
                    /* */
                  }
                }
              });
              setProject(createEmptyProject("New Resonance"));
              setSelectedAssetId(null);
              setSelectedClipId(null);
              setPendingProposal(null);
              setPlayError(null);
            }}
          >
            New
          </button>
        </div>
        {selectedAssetId && (
          <div style={{ padding: "8px 12px" }}>
            <button
              type="button"
              style={{
                width: "100%",
                padding: "6px",
                borderRadius: 6,
                border: "1px solid var(--border, #333)",
                background: "var(--bg-elevated, #1a1f27)",
                color: "inherit",
                cursor: "pointer",
                fontSize: 12,
              }}
              onClick={() => addAssetToTimeline(selectedAssetId)}
            >
              Place at playhead
            </button>
          </div>
        )}
      </aside>

      <main className="viewer">
        <div className="viewer-screen">
          {activeVideoAsset ? (
            <video
              key={activeVideoAsset.id}
              ref={videoRef}
              src={activeVideoAsset.localPathOrUrl}
              muted={muteVideo}
              playsInline
              preload="auto"
              style={{
                maxWidth: "100%",
                maxHeight: "100%",
                objectFit: "contain",
                background: "#000",
              }}
            />
          ) : audioAsset ? (
            <div className="placeholder">
              <div style={{ fontSize: 20, marginBottom: 10 }}>♪</div>
              <div style={{ fontSize: 15 }}>{audioAsset.name}</div>
              <div className="muted" style={{ marginTop: 8 }}>
                {formatTime(audioAsset.durationMs)}
              </div>
            </div>
          ) : (
            <div className="placeholder">
              <div style={{ fontSize: 16, marginBottom: 8 }}>Main Output Screen</div>
              <span className="muted">Import media to preview</span>
            </div>
          )}
          {audioAsset && (
            <audio
              key={audioAsset.id}
              ref={audioRef}
              src={audioAsset.localPathOrUrl}
              preload="auto"
              style={{ display: "none" }}
            />
          )}
        </div>

        <div className="viewer-controls">
          <button type="button" onClick={togglePlay} title="Space">
            {isPlaying ? "❚❚" : "▶"}
          </button>
          <button
            type="button"
            onClick={() => {
              stopPlayback();
              seekTo(0);
            }}
            title="Stop"
          >
            ⏹
          </button>
          <button type="button" onClick={splitAtPlayhead} title="Split at playhead (C)">
            ✂
          </button>
          <span className="time">{formatTime(project.playheadMs)}</span>
          <div className="scrub" onClick={onTimelineClick}>
            <div className="fill" style={{ width: `${playheadPct}%` }} />
          </div>
          <span className="time">{formatTime(duration)}</span>
        </div>

        {playError && (
          <div
            style={{
              position: "absolute",
              bottom: 48,
              left: 12,
              right: 12,
              background: "#3a1515",
              color: "#ffb4b4",
              padding: "8px 12px",
              borderRadius: 6,
              fontSize: 12,
              zIndex: 5,
            }}
          >
            {playError}
          </div>
        )}
      </main>

      <aside className="inspector">
        <h3>Inspector</h3>
        {pendingProposal ? (
          <div className="proposal-card">
            <div>
              <strong>AI Proposal</strong>
              <span className="badge pending">{pendingProposal.status}</span>
            </div>
            <div className="rationale">{pendingProposal.rationale}</div>
            <div className="muted" style={{ fontSize: 11 }}>
              {pendingProposal.previewDiff}
            </div>
            <div className="proposal-actions">
              <button type="button" className="btn-apply" onClick={onAccept}>
                Apply
              </button>
              <button type="button" className="btn-reject" onClick={onReject}>
                Reject
              </button>
            </div>
          </div>
        ) : (
          <p className="muted" style={{ marginBottom: 16, lineHeight: 1.5 }}>
            <strong>Shortcuts</strong>
            <br />
            Space = Play/Pause
            <br />
            C = Cut at playhead
            <br />
            Del = Delete selected clip
            <br />
            Drag clips to move
          </p>
        )}

        {selectedClipId && (
          <div className="field">
            <label>Selected clip</label>
            <div className="muted" style={{ fontSize: 11, wordBreak: "break-all" }}>
              {selectedClipId.slice(0, 8)}…
            </div>
            <button
              type="button"
              style={{
                marginTop: 8,
                padding: "4px 10px",
                borderRadius: 4,
                border: "1px solid #553",
                background: "#2a1515",
                color: "#faa",
                cursor: "pointer",
                fontSize: 12,
              }}
              onClick={deleteSelectedClip}
            >
              Delete clip
            </button>
          </div>
        )}

        <div className="field" style={{ marginTop: 16 }}>
          <label>Project name</label>
          <input
            value={project.name}
            onChange={(e) => setProject((p) => ({ ...p, name: e.target.value }))}
          />
        </div>
        <div className="field">
          <label>Decisions</label>
          <div className="muted">{project.decisions.length} (local only)</div>
        </div>
      </aside>

      <section className="timeline">
        <div className="timeline-ruler" onClick={onTimelineClick} style={{ cursor: "pointer" }}>
          {[0, 0.25, 0.5, 0.75, 1].map((p) => (
            <span
              key={p}
              style={{
                position: "absolute",
                left: `${p * 100}%`,
                transform: "translateX(-50%)",
                top: 4,
                pointerEvents: "none",
              }}
            >
              {formatTime(p * duration)}
            </span>
          ))}
        </div>
        <div className="timeline-tracks">
          {project.tracks.map((track) => (
            <div key={track.id} className="track-row">
              <div className={`track-label ${track.kind}`}>{track.name}</div>
              <div
                className="track-lane"
                ref={track.kind === "VIDEO" ? timelineLaneRef : undefined}
                onClick={onTimelineClick}
                style={{ cursor: "pointer" }}
              >
                {track.clips.map((clip) => {
                  const left = (clip.range.startMs / duration) * 100;
                  const width = ((clip.range.endMs - clip.range.startMs) / duration) * 100;
                  const selected = selectedClipId === clip.id;
                  return (
                    <div
                      key={clip.id}
                      className={`clip ${track.kind}`}
                      style={{
                        left: `${left}%`,
                        width: `${Math.max(width, 0.5)}%`,
                        outline: selected ? "2px solid #fff" : undefined,
                        cursor: "grab",
                        zIndex: selected ? 3 : 1,
                      }}
                      title={`${clip.label || track.kind} — drag to move`}
                      onPointerDown={(e) => onClipPointerDown(e, clip)}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedClipId(clip.id);
                      }}
                    >
                      {clip.label || track.kind}
                    </div>
                  );
                })}
                <div className="playhead" style={{ left: `${playheadPct}%` }} />
              </div>
            </div>
          ))}
        </div>
      </section>

      <footer className="command-bar">
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onCommandSubmit()}
          placeholder='AI command — e.g. "Synchronize the cut with the next beat"'
        />
        <button type="button" onClick={onCommandSubmit} disabled={!command.trim()}>
          Propose
        </button>
      </footer>
    </div>
  );
}
