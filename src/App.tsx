import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createEmptyProject,
  ensureMultiTrack,
  type Project,
  type ProjectEditProposal,
  type MediaAsset,
  type Clip,
  type Track,
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

function clipAt(track: Track, timeMs: number): Clip | null {
  return (
    track.clips.find((c) => timeMs >= c.range.startMs && timeMs < c.range.endMs) ?? null
  );
}

export function App() {
  const [project, setProject] = useState<Project>(() => ensureMultiTrack(loadProject()));
  const [command, setCommand] = useState("");
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [targetTrackId, setTargetTrackId] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [pendingProposal, setPendingProposal] = useState<ProjectEditProposal | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const dragRef = useRef<{
    clipId: string;
    startX: number;
    origStartMs: number;
    durationMs: number;
  } | null>(null);

  const videoRef = useRef<HTMLVideoElement>(null);
  const audio1Ref = useRef<HTMLAudioElement>(null);
  const audio2Ref = useRef<HTMLAudioElement>(null);
  const rafRef = useRef<number>(0);
  const lastTick = useRef<number>(0);
  const isSeekingRef = useRef(false);
  const timelineLaneRef = useRef<HTMLDivElement>(null);
  const openInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    saveProject(project);
  }, [project]);

  const flash = (msg: string) => {
    setStatusMsg(msg);
    setTimeout(() => setStatusMsg(null), 2200);
  };

  const duration = Math.max(project.durationMs, 1000);

  const videoTracks = useMemo(
    () => project.tracks.filter((t) => t.kind === "VIDEO"),
    [project.tracks]
  );
  const audioTracks = useMemo(
    () => project.tracks.filter((t) => t.kind === "AUDIO"),
    [project.tracks]
  );

  // Topmost video track with a clip under playhead (V2 over V1 — later tracks win)
  const activeVideoClip = useMemo(() => {
    for (let i = videoTracks.length - 1; i >= 0; i--) {
      const c = clipAt(videoTracks[i], project.playheadMs);
      if (c) return c;
    }
    return null;
  }, [videoTracks, project.playheadMs]);

  const activeVideoAsset = useMemo(() => {
    if (!activeVideoClip?.mediaAssetId) return null;
    return project.mediaAssets.find((a) => a.id === activeVideoClip.mediaAssetId) ?? null;
  }, [activeVideoClip, project.mediaAssets]);

  // Active audio clip per audio track
  const activeAudioClips = useMemo(() => {
    return audioTracks.map((t) => ({
      track: t,
      clip: clipAt(t, project.playheadMs),
    }));
  }, [audioTracks, project.playheadMs]);

  const audioAssetsForTracks = useMemo(() => {
    return activeAudioClips.map(({ clip }) => {
      if (!clip?.mediaAssetId) return null;
      return project.mediaAssets.find((a) => a.id === clip.mediaAssetId) ?? null;
    });
  }, [activeAudioClips, project.mediaAssets]);

  const hasAnyAudio = audioAssetsForTracks.some(Boolean);
  const muteVideo = hasAnyAudio;

  const defaultTargetTrack = targetTrackId
    ?? videoTracks[0]?.id
    ?? audioTracks[0]?.id
    ?? project.tracks[0]?.id
    ?? null;

  // ---------- SEEK ----------
  const seekTo = useCallback(
    (ms: number) => {
      const clamped = Math.max(0, Math.min(duration, ms));
      isSeekingRef.current = true;
      setProject((p) => ({ ...p, playheadMs: clamped }));

      const applyVideo = () => {
        const v = videoRef.current;
        if (!v) return;
        // find active clip at clamped time
        const vTracks = project.tracks.filter((t) => t.kind === "VIDEO");
        let clip: Clip | null = null;
        for (let i = vTracks.length - 1; i >= 0; i--) {
          const c = clipAt(vTracks[i], clamped);
          if (c) {
            clip = c;
            break;
          }
        }
        if (clip?.sourceRange) {
          const offset = clamped - clip.range.startMs;
          try {
            v.currentTime = Math.max(0, (clip.sourceRange.startMs + offset) / 1000);
          } catch { /* */ }
        }
      };
      applyVideo();

      // audio elements: set to timeline time mapped through clip
      const syncAudio = (el: HTMLAudioElement | null, track: Track | undefined) => {
        if (!el || !track) return;
        const c = clipAt(track, clamped);
        if (c?.sourceRange) {
          const offset = clamped - c.range.startMs;
          try {
            el.currentTime = Math.max(0, (c.sourceRange.startMs + offset) / 1000);
          } catch { /* */ }
        } else {
          try {
            el.currentTime = clamped / 1000;
          } catch { /* */ }
        }
      };
      syncAudio(audio1Ref.current, audioTracks[0]);
      syncAudio(audio2Ref.current, audioTracks[1]);

      requestAnimationFrame(() => {
        isSeekingRef.current = false;
      });
    },
    [duration, project.tracks, audioTracks]
  );

  // ---------- PLAYBACK ----------
  const startPlayback = useCallback(async () => {
    setPlayError(null);
    const v = videoRef.current;
    if (v) v.muted = muteVideo;

    const promises: Promise<void>[] = [];
    if (v && activeVideoAsset) {
      promises.push(
        v.play().catch((err) => {
          console.warn("[Resonance] video.play()", err);
          setPlayError("Video: " + (err?.message || String(err)));
          throw err;
        })
      );
    }
    const a1 = audio1Ref.current;
    const a2 = audio2Ref.current;
    if (a1 && audioAssetsForTracks[0]) {
      promises.push(a1.play().catch((err) => console.warn("audio1", err)));
    }
    if (a2 && audioAssetsForTracks[1]) {
      promises.push(a2.play().catch((err) => console.warn("audio2", err)));
    }

    try {
      await Promise.allSettled(promises);
      setIsPlaying(true);
    } catch {
      setIsPlaying(true);
    }
  }, [muteVideo, activeVideoAsset, audioAssetsForTracks]);

  const stopPlayback = useCallback(() => {
    videoRef.current?.pause();
    audio1Ref.current?.pause();
    audio2Ref.current?.pause();
    setIsPlaying(false);
  }, []);

  const togglePlay = useCallback(() => {
    if (isPlaying) stopPlayback();
    else void startPlayback();
  }, [isPlaying, startPlayback, stopPlayback]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muteVideo;
  }, [muteVideo, activeVideoAsset?.id]);

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
          const vTracks = p.tracks.filter((t) => t.kind === "VIDEO");
          const aTracks = p.tracks.filter((t) => t.kind === "AUDIO");

          const v = videoRef.current;
          if (v) {
            let clip: Clip | null = null;
            for (let i = vTracks.length - 1; i >= 0; i--) {
              const c = clipAt(vTracks[i], next);
              if (c) {
                clip = c;
                break;
              }
            }
            if (clip?.sourceRange) {
              const offset = next - clip.range.startMs;
              const srcT = (clip.sourceRange.startMs + offset) / 1000;
              if (Math.abs(v.currentTime - srcT) > 0.25) {
                try {
                  v.currentTime = srcT;
                } catch { /* */ }
              }
            }
          }

          const syncA = (el: HTMLAudioElement | null, track: Track | undefined) => {
            if (!el || !track) return;
            const c = clipAt(track, next);
            if (c?.sourceRange) {
              const offset = next - c.range.startMs;
              const srcT = (c.sourceRange.startMs + offset) / 1000;
              if (Math.abs(el.currentTime - srcT) > 0.25) {
                try {
                  el.currentTime = srcT;
                } catch { /* */ }
              }
            }
          };
          syncA(audio1Ref.current, aTracks[0]);
          syncA(audio2Ref.current, aTracks[1]);
        }

        if (next >= max) {
          videoRef.current?.pause();
          audio1Ref.current?.pause();
          audio2Ref.current?.pause();
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

  // ---------- IMPORT ----------
  const handleImport = useCallback(
    async (files: FileList | null) => {
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

      setProject((p) => {
        const kind = isVideo ? "VIDEO" : "AUDIO";
        // Prefer selected target track if matching kind, else first free / first of kind
        let track =
          p.tracks.find((t) => t.id === targetTrackId && t.kind === kind) ??
          p.tracks.find((t) => t.kind === kind && t.clips.length === 0) ??
          p.tracks.find((t) => t.kind === kind)!;

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
        };
      });

      setSelectedAssetId(asset.id);
      setIsPlaying(false);
      setPlayError(null);
      flash(`Imported ${file.name}`);
    },
    [targetTrackId]
  );

  const addAssetToTimeline = useCallback(
    (assetId: string, trackId?: string) => {
      const asset = project.mediaAssets.find((a) => a.id === assetId);
      if (!asset) return;
      const kind = asset.type === "video" ? "VIDEO" : "AUDIO";
      setProject((p) => {
        const track =
          p.tracks.find((t) => t.id === (trackId || targetTrackId) && t.kind === kind) ??
          p.tracks.find((t) => t.kind === kind)!;
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
      flash("Clip placed at playhead");
    },
    [project.mediaAssets, targetTrackId]
  );

  // ---------- SAVE / OPEN / EXPORT ----------
  const downloadProject = useCallback(
    (filename?: string) => {
      // Strip blob URLs — they won't work after reload; keep metadata
      const portable: Project = {
        ...project,
        mediaAssets: project.mediaAssets.map((a) => ({
          ...a,
          localPathOrUrl: a.localPathOrUrl.startsWith("blob:")
            ? `missing:${a.name}`
            : a.localPathOrUrl,
        })),
        updatedAt: new Date().toISOString(),
      };
      const blob = new Blob([JSON.stringify(portable, null, 2)], {
        type: "application/json",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download =
        filename ||
        `${(project.name || "resonance").replace(/\s+/g, "_")}.resonance.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      flash("Project saved (.resonance.json)");
    },
    [project]
  );

  const openProjectFile = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    const text = await files[0].text();
    try {
      const parsed = JSON.parse(text) as Project;
      if (!parsed.id || !Array.isArray(parsed.tracks)) throw new Error("Invalid project");
      stopPlayback();
      setProject(ensureMultiTrack(parsed));
      setSelectedClipId(null);
      setPendingProposal(null);
      flash("Project opened — re-import media if blobs were local");
    } catch (e) {
      flash("Open failed: invalid project file");
      console.warn(e);
    }
  }, [stopPlayback]);

  // ---------- CLIP DRAG ----------
  const onClipPointerDown = useCallback((e: React.PointerEvent, clip: Clip) => {
    e.stopPropagation();
    e.preventDefault();
    setSelectedClipId(clip.id);
    setTargetTrackId(clip.trackId);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = {
      clipId: clip.id,
      startX: e.clientX,
      origStartMs: clip.range.startMs,
      durationMs: clip.range.endMs - clip.range.startMs,
    };
  }, []);

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

  // ---------- SPLIT / DELETE ----------
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
              sourceRange: { startMs: srcStart, endMs: srcStart + leftDur },
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
    flash("Cut at playhead");
  }, [project.playheadMs]);

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
    flash("Clip deleted");
  }, [selectedClipId]);

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
    flash("Proposal applied");
  };

  const onReject = () => {
    if (!pendingProposal) return;
    setProject(rejectProposal(project, pendingProposal.id));
    setPendingProposal(null);
  };

  const playheadPct = Math.min(100, (project.playheadMs / duration) * 100);
  const vaultStatus = localOnlyVaultAdapter.getStatus();

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
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        downloadProject();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, splitAtPlayhead, deleteSelectedClip, downloadProject]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="logo">AILEXSI Resonance</div>
        <nav>
          <button type="button" onClick={() => {
            stopPlayback();
            project.mediaAssets.forEach((a) => {
              if (a.localPathOrUrl.startsWith("blob:")) {
                try { URL.revokeObjectURL(a.localPathOrUrl); } catch { /* */ }
              }
            });
            setProject(createEmptyProject("New Resonance"));
            setSelectedAssetId(null);
            setSelectedClipId(null);
            setPendingProposal(null);
            flash("New project");
          }}>New</button>
          <button type="button" onClick={() => openInputRef.current?.click()}>Open</button>
          <button type="button" onClick={() => downloadProject()}>Save</button>
          <button type="button" onClick={() => downloadProject(
            `${(project.name || "export").replace(/\s+/g, "_")}_export.resonance.json`
          )}>Export</button>
          <button type="button" onClick={splitAtPlayhead} title="C">Cut</button>
          <button type="button" onClick={deleteSelectedClip}>Delete</button>
        </nav>
        <input
          ref={openInputRef}
          type="file"
          accept=".json,.resonance.json,application/json"
          hidden
          onChange={(e) => openProjectFile(e.target.files)}
        />
        <div className="project-name">{project.name}</div>
        <div className="ai-status ready">
          {statusMsg ?? `AI ready · Vault: ${vaultStatus.mode}`}
        </div>
      </header>

      <aside className="media-panel">
        <h3>Media / Project</h3>
        <div className="media-list">
          {project.mediaAssets.length === 0 && (
            <p className="muted" style={{ padding: 12, lineHeight: 1.55 }}>
              Import video/audio, then place on V1/V2 or A1/A2.
            </p>
          )}
          {project.mediaAssets.map((a) => (
            <div
              key={a.id}
              className={`media-item ${selectedAssetId === a.id ? "selected" : ""}`}
              onClick={() => setSelectedAssetId(a.id)}
              onDoubleClick={() => addAssetToTimeline(a.id)}
              title="Double-click → place at playhead on target track"
            >
              <div className="name">{a.name}</div>
              <div className="meta">{a.type} · {formatTime(a.durationMs)}</div>
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
          <button type="button" onClick={() => downloadProject()}>Save</button>
        </div>
        <div style={{ padding: "8px 12px", fontSize: 11 }}>
          <label className="muted">Target track</label>
          <select
            value={defaultTargetTrack ?? ""}
            onChange={(e) => setTargetTrackId(e.target.value)}
            style={{
              width: "100%",
              marginTop: 4,
              background: "#151a22",
              color: "inherit",
              border: "1px solid #333",
              borderRadius: 4,
              padding: 4,
            }}
          >
            {project.tracks
              .filter((t) => t.kind === "VIDEO" || t.kind === "AUDIO")
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({t.kind})
                </option>
              ))}
          </select>
        </div>
        {selectedAssetId && (
          <div style={{ padding: "0 12px 12px" }}>
            <button
              type="button"
              style={{
                width: "100%",
                padding: "6px",
                borderRadius: 6,
                border: "1px solid #333",
                background: "#1a1f27",
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
          ) : (
            <div className="placeholder">
              <div style={{ fontSize: 16, marginBottom: 8 }}>Main Output</div>
              <span className="muted">
                {hasAnyAudio ? "Audio only at playhead" : "Import & place media on V1/V2"}
              </span>
            </div>
          )}
          {/* Dual audio elements for A1 / A2 */}
          <audio
            ref={audio1Ref}
            src={audioAssetsForTracks[0]?.localPathOrUrl}
            preload="auto"
            style={{ display: "none" }}
          />
          <audio
            ref={audio2Ref}
            src={audioAssetsForTracks[1]?.localPathOrUrl}
            preload="auto"
            style={{ display: "none" }}
          />
        </div>

        <div className="viewer-controls">
          <button type="button" onClick={togglePlay} title="Space">
            {isPlaying ? "❚❚" : "▶"}
          </button>
          <button type="button" onClick={() => { stopPlayback(); seekTo(0); }}>⏹</button>
          <button type="button" onClick={splitAtPlayhead} title="C">✂</button>
          <span className="time">{formatTime(project.playheadMs)}</span>
          <div className="scrub" onClick={onTimelineClick}>
            <div className="fill" style={{ width: `${playheadPct}%` }} />
          </div>
          <span className="time">{formatTime(duration)}</span>
        </div>
        {playError && (
          <div style={{
            position: "absolute", bottom: 48, left: 12, right: 12,
            background: "#3a1515", color: "#ffb4b4", padding: "8px 12px",
            borderRadius: 6, fontSize: 12, zIndex: 5,
          }}>{playError}</div>
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
            <div className="muted" style={{ fontSize: 11 }}>{pendingProposal.previewDiff}</div>
            <div className="proposal-actions">
              <button type="button" className="btn-apply" onClick={onAccept}>Apply</button>
              <button type="button" className="btn-reject" onClick={onReject}>Reject</button>
            </div>
          </div>
        ) : (
          <p className="muted" style={{ marginBottom: 16, lineHeight: 1.55, fontSize: 12 }}>
            <strong>Shortcuts</strong><br />
            Space Play/Pause · C Cut · Del Delete<br />
            Ctrl+S Save · Drag clips to move<br />
            V2 overlays V1 at playhead (crossover)
          </p>
        )}
        {selectedClipId && (
          <div className="field">
            <label>Selected clip</label>
            <button type="button" className="btn-reject" onClick={deleteSelectedClip}
              style={{ marginTop: 6 }}>Delete clip</button>
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
          <label>Tracks</label>
          <div className="muted">V1 V2 · A1 A2 · crossover ready</div>
        </div>
      </aside>

      <section className="timeline">
        <div className="timeline-ruler" onClick={onTimelineClick} style={{ cursor: "pointer" }}>
          {[0, 0.25, 0.5, 0.75, 1].map((p) => (
            <span key={p} style={{
              position: "absolute", left: `${p * 100}%`, transform: "translateX(-50%)",
              top: 4, pointerEvents: "none",
            }}>{formatTime(p * duration)}</span>
          ))}
        </div>
        <div className="timeline-tracks">
          {project.tracks.map((track, idx) => (
            <div key={track.id} className="track-row">
              <div
                className={`track-label ${track.kind}`}
                onClick={() => setTargetTrackId(track.id)}
                style={{
                  cursor: "pointer",
                  outline: targetTrackId === track.id ? "1px solid #6af" : undefined,
                }}
                title="Click to set as target track for Place/Import"
              >
                {track.name}
              </div>
              <div
                className="track-lane"
                ref={idx === 0 ? timelineLaneRef : undefined}
                onClick={(e) => {
                  setTargetTrackId(track.id);
                  onTimelineClick(e);
                }}
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
                      title={`${clip.label} — drag to move`}
                      onPointerDown={(e) => onClipPointerDown(e, clip)}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedClipId(clip.id);
                        setTargetTrackId(track.id);
                      }}
                    >
                      {clip.label || track.name}
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
