import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createEmptyProject,
  ensureMultiTrack,
  isPlayableMediaUrl,
  type Project,
  type ProjectEditProposal,
  type MediaAsset,
  type Clip,
  type Track,
} from "./core/models";
import { generateProposal, applyProposal, rejectProposal } from "./core/ai-command";
import { loadProject, saveProject } from "./core/project-store";
import {
  putMediaBlob,
  hydrateMediaAssets,
  clearAllMediaBlobs,
} from "./core/media-store";
import { extractWaveformPeaks } from "./core/waveform";
import { isTauri, exportBlobToMp4 } from "./core/tauri-export";
import { exportTimeline } from "./core/exporter";
import { jobFromProject } from "./core/exporter/from-project";
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

const APP_VERSION = "4.01";

export function App() {
  const [project, setProject] = useState<Project>(() => {
    try {
      return ensureMultiTrack(loadProject());
    } catch (e) {
      console.warn("[boot] loadProject failed", e);
      return createEmptyProject("New Resonance");
    }
  });
  const [mediaReady, setMediaReady] = useState(false);
  const [showWelcome, setShowWelcome] = useState(false);
  const [command, setCommand] = useState("");
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [targetTrackId, setTargetTrackId] = useState<string | null>(null);
  type EditorTool = "select" | "copy" | "paste";
  const [tool, setTool] = useState<EditorTool>("select");
  const [clipClipboard, setClipClipboard] = useState<Clip | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [masterVolume, setMasterVolume] = useState(1);
  const [timelineZoom, setTimelineZoom] = useState(1);
  const [viewStartMs, setViewStartMs] = useState(0);
  const [loopInMs, setLoopInMs] = useState<number | null>(null);
  const [loopOutMs, setLoopOutMs] = useState<number | null>(null);
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [rangeClickStep, setRangeClickStep] = useState<"in" | "out">("in");
  const [undoStack, setUndoStack] = useState<Project[]>([]);
  const [redoStack, setRedoStack] = useState<Project[]>([]);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [meterLevel, setMeterLevel] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [pendingProposal, setPendingProposal] = useState<ProjectEditProposal | null>(null);
  const [playError, setPlayError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const [exportPhase, setExportPhase] = useState<"idle" | "recording" | "converting" | "saving">("idle");
  const [desktopMp4Ready, setDesktopMp4Ready] = useState(false);
  const exportLockRef = useRef(false);
  const [exportName, setExportName] = useState("");
  const [showExportDlg, setShowExportDlg] = useState(false);
  const cancelRenderRef = useRef(false);

  const flash = (msg: string) => {
    setStatusMsg(msg);
    setTimeout(() => setStatusMsg(null), 2200);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isTauri()) {
        setDesktopMp4Ready(false);
        return;
      }
      try {
        const { checkFfmpeg } = await import("./core/tauri-export");
        const path = await checkFfmpeg();
        if (!cancelled) setDesktopMp4Ready(!!path);
      } catch {
        if (!cancelled) setDesktopMp4Ready(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dragRef = useRef<{
    clipId: string;
    startX: number;
    startY: number;
    origStartMs: number;
    durationMs: number;
    fromTrackId: string;
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

  // Restore media blobs from IndexedDB after reload
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const hydrated = await hydrateMediaAssets(project.mediaAssets);
        if (cancelled) return;
        const anyMissing = hydrated.some((a) => !a.localPathOrUrl.startsWith("blob:"));
        const anyMedia = hydrated.length > 0;
        setProject((p) => ({ ...p, mediaAssets: hydrated }));
        setMediaReady(true);
        // Welcome only if empty project
        if (!anyMedia && !pHasClips(project)) {
          setShowWelcome(true);
        }
        if (anyMedia && anyMissing) {
          flash("Some media need Re-import All (↻)");
        }
      } catch (e) {
        console.warn("[media hydrate]", e);
        setMediaReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pHasClips(p: Project): boolean {
    return p.tracks.some((t) => t.clips.length > 0);
  }


  const duration = Math.max(project.durationMs, 1000);
  const viewDurationMs = Math.max(500, duration / timelineZoom);
  const viewEndMs = Math.min(duration, viewStartMs + viewDurationMs);
  // clamp view window
  const clampedViewStart = Math.max(0, Math.min(viewStartMs, Math.max(0, duration - viewDurationMs)));
  const msToPct = (ms: number) => ((ms - clampedViewStart) / viewDurationMs) * 100;
  const pctToMs = (pct: number) => clampedViewStart + (pct / 100) * viewDurationMs;
  const FRAME_MS = 1000 / 30;

  const undo = useCallback(() => {
    setUndoStack((stack) => {
      if (!stack.length) {
        flash("Nothing to undo");
        return stack;
      }
      const prev = stack[stack.length - 1];
      setProject((cur) => {
        setRedoStack((r) => [...r, cur]);
        return prev;
      });
      flash("Undo");
      return stack.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setRedoStack((stack) => {
      if (!stack.length) {
        flash("Nothing to redo");
        return stack;
      }
      const next = stack[stack.length - 1];
      setProject((cur) => {
        setUndoStack((u) => [...u, cur]);
        return next;
      });
      flash("Redo");
      return stack.slice(0, -1);
    });
  }, []);


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
    const a = project.mediaAssets.find((x) => x.id === activeVideoClip.mediaAssetId) ?? null;
    if (!a || !isPlayableMediaUrl(a.localPathOrUrl)) return null;
    return a;
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
      const a = project.mediaAssets.find((x) => x.id === clip.mediaAssetId) ?? null;
      if (!a || !isPlayableMediaUrl(a.localPathOrUrl)) return null;
      return a;
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
    try { ensureAudioGraph(); } catch { /* */ }
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

  useEffect(() => {
    const v = Math.max(0, Math.min(1, masterVolume));
    if (audio1Ref.current) audio1Ref.current.volume = v;
    if (audio2Ref.current) audio2Ref.current.volume = v;
    if (videoRef.current && !muteVideo) videoRef.current.volume = v;
  }, [masterVolume, muteVideo]);

  // Real peak meter via Web Audio AnalyserNode
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourcesWired = useRef(false);

  const ensureAudioGraph = useCallback(() => {
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new AudioContext();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") void ctx.resume();
      if (!analyserRef.current) {
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.7;
        analyser.connect(ctx.destination);
        analyserRef.current = analyser;
      }
      if (!sourcesWired.current) {
        const analyser = analyserRef.current!;
        const els = [audio1Ref.current, audio2Ref.current].filter(Boolean) as HTMLAudioElement[];
        for (const el of els) {
          try {
            const src = ctx.createMediaElementSource(el);
            src.connect(analyser);
          } catch {
            // already wired
          }
        }
        // video element audio path when not muted by dual-audio rule
        if (videoRef.current && !muteVideo) {
          try {
            const src = ctx.createMediaElementSource(videoRef.current);
            src.connect(analyser);
          } catch {
            /* already */
          }
        }
        sourcesWired.current = true;
      }
    } catch (e) {
      console.warn("[meter]", e);
    }
  }, [muteVideo]);

  useEffect(() => {
    if (!isPlaying) {
      setMeterLevel(0);
      return;
    }
    ensureAudioGraph();
    const analyser = analyserRef.current;
    if (!analyser) {
      // fallback visual if graph failed
      const id = window.setInterval(() => {
        setMeterLevel(0.1 + Math.random() * 0.4 * masterVolume);
      }, 80);
      return () => window.clearInterval(id);
    }
    const data = new Uint8Array(analyser.frequencyBinCount);
    let raf = 0;
    const tick = () => {
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / data.length / 255;
      setMeterLevel(Math.min(1, avg * 1.8 * masterVolume));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying, masterVolume, ensureAudioGraph]);

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

        if (loopEnabled && loopInMs != null && loopOutMs != null && next >= loopOutMs) {
          const back = loopInMs;
          // resync media to loop in
          requestAnimationFrame(() => {
            const v = videoRef.current;
            const vTracks = p.tracks.filter((t) => t.kind === "VIDEO");
            let clip: Clip | null = null;
            for (let i = vTracks.length - 1; i >= 0; i--) {
              const c = clipAt(vTracks[i], back);
              if (c) { clip = c; break; }
            }
            if (v && clip?.sourceRange) {
              const offset = back - clip.range.startMs;
              try { v.currentTime = Math.max(0, (clip.sourceRange.startMs + offset) / 1000); } catch { /* */ }
            }
            const aTracks = p.tracks.filter((t) => t.kind === "AUDIO");
            const syncA = (el: HTMLAudioElement | null, track: Track | undefined) => {
              if (!el || !track) return;
              const c = clipAt(track, back);
              if (c?.sourceRange) {
                const offset = back - c.range.startMs;
                try { el.currentTime = Math.max(0, (c.sourceRange.startMs + offset) / 1000); } catch { /* */ }
              }
            };
            syncA(audio1Ref.current, aTracks[0]);
            syncA(audio2Ref.current, aTracks[1]);
          });
          return { ...p, playheadMs: back };
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
  }, [isPlaying, duration, loopEnabled, loopInMs, loopOutMs]);

  // ---------- IMPORT ----------
  const handleImport = useCallback(
    async (files: FileList | null) => {
      if (!files?.length) return;
      for (let fi = 0; fi < files.length; fi++) {
      const file = files[fi];
      const url = URL.createObjectURL(file);
      const isVideo = file.type.startsWith("video/");
      const isAudio = file.type.startsWith("audio/");
      if (!isVideo && !isAudio) continue;

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

      const assetId = crypto.randomUUID();
      try {
        await putMediaBlob(assetId, file, file.name, file.type || (isVideo ? "video/mp4" : "audio/wav"));
      } catch (e) {
        console.warn("[media-store] put failed", e);
      }
      const asset: MediaAsset = {
        id: assetId,
        type: isVideo ? "video" : "audio",
        name: file.name,
        localPathOrUrl: url,
        durationMs,
        analysis: isAudio
          ? { waveformPeaks: await extractWaveformPeaks(file, 128) }
          : { width: 0, height: 0 },
      };

      setProject((p) => {
        const kind = isVideo ? "VIDEO" : "AUDIO";
        // Re-link: same filename was orphaned after reload
        const orphan = p.mediaAssets.find(
          (a) =>
            a.name === file.name &&
            (a.localPathOrUrl.startsWith("missing:") || !isPlayableMediaUrl(a.localPathOrUrl))
        );
        if (orphan) {
          flash(`Re-linked ${file.name}`);
          return {
            ...p,
            mediaAssets: p.mediaAssets.map((a) =>
              a.id === orphan.id
                ? { ...a, localPathOrUrl: url, durationMs, type: asset.type }
                : a
            ),
          };
        }

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
      } // end multi-file loop
      flash(`Imported ${files.length} file(s)`);
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

  /** Real media export: record mixed video (top track) + audio tracks → WebM */
  const cancelExport = useCallback(() => {
    cancelRenderRef.current = true;
    stopPlayback();
    setIsRendering(false);
    setRenderProgress(0);
    setShowExportDlg(false);
    flash("Export cancelled");
  }, [stopPlayback]);

  const startExportWithName = useCallback(async (filename: string) => {
    if (isRendering || exportLockRef.current) return;
    if (project.durationMs < 200) {
      flash("Nothing to render — add clips first");
      return;
    }
    exportLockRef.current = true;
    const safeName = (filename || project.name || "resonance").replace(/[^\w\-]+/g, "_");
    cancelRenderRef.current = false;
    setShowExportDlg(false);
    setIsRendering(true);
    setExportPhase("recording");
    setRenderProgress(0);
    setPlayError(null);
    stopPlayback();

    const rangeStart = loopInMs != null && loopOutMs != null ? loopInMs : 0;
    const rangeEnd =
      loopInMs != null && loopOutMs != null ? loopOutMs : project.durationMs;

    // Plugin path: local H.264/AAC MP4 via @ailexsi/exporter (WebCodecs)
    try {
      setExportPhase("converting");
      const job = jobFromProject(
        {
          id: project.id,
          name: project.name,
          durationMs: project.durationMs,
          tracks: project.tracks,
          mediaAssets: project.mediaAssets,
        },
        {
          fileName: safeName,
          rangeStartMs: rangeStart,
          rangeEndMs: rangeEnd,
        },
      );
      const result = await exportTimeline(job, {
        onProgress: (p) => {
          setRenderProgress(p.percent);
          if (p.percent >= 90) setExportPhase("saving");
        },
      });
      if (result.success && result.blob) {
        const url = URL.createObjectURL(result.blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = result.outputPath.endsWith(".mp4")
          ? result.outputPath
          : `${safeName}.mp4`;
        a.rel = "noopener";
        a.style.display = "none";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 15000);
        setRenderProgress(100);
        flash(
          `MP4 ready · ${(result.fileSizeBytes / 1024 / 1024).toFixed(2)} MB · ${result.backend || "webcodecs"} · Downloads`,
        );
        setIsRendering(false);
        setExportPhase("idle");
        exportLockRef.current = false;
        setTimeout(() => setRenderProgress(0), 1200);
        return;
      }
      // Plugin ran but failed — do NOT fall through to MediaRecorder WebM.
      const errMsg = result.error || "MP4 export failed";
      if (errMsg !== "Export cancelled") {
        flash(errMsg);
        console.warn("[exporter plugin]", errMsg);
      }
      setIsRendering(false);
      setExportPhase("idle");
      exportLockRef.current = false;
      setTimeout(() => setRenderProgress(0), 800);
      return;
    } catch (pluginErr) {
      const msg = pluginErr instanceof Error ? pluginErr.message : String(pluginErr);
      console.warn("[exporter plugin]", pluginErr);
      const noWebCodecs =
        typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined";
      if (!noWebCodecs) {
        flash(`MP4 export failed: ${msg}`);
        setIsRendering(false);
        setExportPhase("idle");
        exportLockRef.current = false;
        setTimeout(() => setRenderProgress(0), 800);
        return;
      }
      flash("WebCodecs unavailable — MediaRecorder fallback…");
    }

    const rangeLen = Math.max(500, rangeEnd - rangeStart);
    seekTo(rangeStart);
    await new Promise((r) => setTimeout(r, 200));

    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    // must be in DOM for some browsers to emit captureStream frames
    canvas.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.appendChild(canvas);
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) {
      canvas.remove();
      setIsRendering(false);
      setExportPhase("idle");
      exportLockRef.current = false;
      flash("Canvas not available");
      return;
    }

    // Prefer MP4 when browser supports recording it; else VP8 WebM → ffmpeg MP4.
    const mimeCandidates = [
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      "video/mp4",
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=vp8",
      "video/webm",
    ];
    const mime = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || "video/webm";

    const canvasStream = canvas.captureStream(30);
    const outTracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks()];

    const captureAudio = (el: HTMLMediaElement | null) => {
      if (!el) return;
      try {
        const anyEl = el as HTMLMediaElement & {
          captureStream?: () => MediaStream;
          mozCaptureStream?: () => MediaStream;
        };
        const s = anyEl.captureStream?.() || anyEl.mozCaptureStream?.();
        if (s) {
          for (const t of s.getAudioTracks()) {
            t.enabled = true;
            outTracks.push(t);
          }
        }
      } catch (e) {
        console.warn("[render] audio capture failed", e);
      }
    };

    // start media first so captureStream has signal
    await startPlayback();
    await new Promise((r) => setTimeout(r, 100));
    captureAudio(audio1Ref.current);
    captureAudio(audio2Ref.current);
    // video element audio only if not muted by dual-audio path
    if (videoRef.current && !videoRef.current.muted) {
      captureAudio(videoRef.current);
    }

    const combined = new MediaStream(outTracks);
    const chunks: Blob[] = [];
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(combined, {
        mimeType: mime,
        videoBitsPerSecond: 5_000_000,
        audioBitsPerSecond: 192_000,
      });
    } catch {
      recorder = new MediaRecorder(combined);
    }

    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunks.push(ev.data);
    };

    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.onerror = () => resolve();
    });

    // paint a few frames before record so first keyframe isn't empty
    const paint = () => {
      const v = videoRef.current;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (v && v.readyState >= 2 && v.videoWidth > 0) {
        const scale = Math.min(canvas.width / v.videoWidth, canvas.height / v.videoHeight);
        const w = v.videoWidth * scale;
        const h = v.videoHeight * scale;
        ctx.drawImage(v, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      }
    };
    for (let i = 0; i < 5; i++) {
      paint();
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }

    recorder.start(250);

    let drawing = true;
    const drawLoop = () => {
      if (!drawing) return;
      paint();
      requestAnimationFrame(drawLoop);
    };
    drawLoop();

    const progressTimer = window.setInterval(() => {
      setProject((p) => {
        const pct = Math.min(90, Math.round(((p.playheadMs - rangeStart) / rangeLen) * 90));
        setRenderProgress(Math.max(0, pct));
        // auto-stop when playhead passes range end
        if (p.playheadMs >= rangeEnd - 30) {
          cancelRenderRef.current = false;
        }
        return p;
      });
    }, 100);

    // Wait until range length elapsed OR playhead past end OR cancel
    await new Promise<void>((resolve) => {
      const t0 = performance.now();
      const tick = () => {
        if (cancelRenderRef.current) {
          resolve();
          return;
        }
        const elapsed = performance.now() - t0;
        // hard stop after range + buffer
        if (elapsed >= rangeLen + 800) {
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      };
      tick();
    });

    drawing = false;
    window.clearInterval(progressTimer);
    stopPlayback();

    const wasCancelled = cancelRenderRef.current;

    try {
      if (recorder.state === "recording") {
        try {
          recorder.requestData();
        } catch { /* */ }
        recorder.stop();
      }
    } catch { /* */ }

    // recorder.onstop can hang forever in Chrome — hard cap
    await Promise.race([
      stopped,
      new Promise<void>((r) => setTimeout(r, 2500)),
    ]);
    await new Promise((r) => setTimeout(r, 80));

    // cleanup stream tracks + canvas
    for (const t of outTracks) {
      try {
        t.stop();
      } catch {
        /* */
      }
    }
    try {
      canvas.remove();
    } catch {
      /* */
    }

    const finishUi = () => {
      setIsRendering(false);
      setExportPhase("idle");
      exportLockRef.current = false;
      setTimeout(() => setRenderProgress(0), 1200);
    };

    if (wasCancelled || cancelRenderRef.current) {
      setRenderProgress(0);
      finishUi();
      flash("Export cancelled — no file written");
      return;
    }

    const rawBlob = new Blob(chunks, {
      type: mime.includes("webm") ? "video/webm" : mime.includes("mp4") ? "video/mp4" : "video/webm",
    });
    if (rawBlob.size < 8_000) {
      setRenderProgress(0);
      finishUi();
      flash(`Export too small (${rawBlob.size} B) — try again with media visible`);
      return;
    }

    setExportPhase("saving");
    setRenderProgress(95);

    try {
      // Desktop (Tauri): native ffmpeg → real H.264 MP4
      if (isTauri()) {
        try {
          const { path, message } = await exportBlobToMp4(rawBlob, safeName);
          setRenderProgress(100);
          flash(message || `MP4 saved: ${path}`);
        } catch (te) {
          console.warn("[export] Tauri MP4 failed, falling back to WebM", te);
          flash(`MP4 fehlgeschlagen: ${String((te as Error)?.message || te).slice(0, 100)}`);
          const url = URL.createObjectURL(rawBlob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${safeName}.webm`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 8000);
          setRenderProgress(100);
        }
      } else {
        // Browser: WebM (or native MP4 if MediaRecorder produced it)
        const isMp4 = mime.includes("mp4") || rawBlob.type.includes("mp4");
        const outName = `${safeName}.${isMp4 ? "mp4" : "webm"}`;
        const accept = isMp4
          ? ({ "video/mp4": [".mp4"] } as Record<string, string[]>)
          : ({ "video/webm": [".webm"] } as Record<string, string[]>);
        const desc = isMp4 ? "MP4 video" : "WebM video";
        const w = window as Window & {
          showSaveFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle>;
        };
        if (typeof w.showSaveFilePicker === "function") {
          try {
            const handle = await w.showSaveFilePicker({
              suggestedName: outName,
              types: [{ description: desc, accept }],
            });
            const writable = await handle.createWritable();
            await writable.write(rawBlob);
            await writable.close();
          } catch (pickErr) {
            if ((pickErr as Error)?.name === "AbortError") {
              setRenderProgress(0);
              finishUi();
              flash("Save cancelled");
              return;
            }
            const url = URL.createObjectURL(rawBlob);
            const a = document.createElement("a");
            a.href = url;
            a.download = outName;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 8000);
          }
        } else {
          const url = URL.createObjectURL(rawBlob);
          const a = document.createElement("a");
          a.href = url;
          a.download = outName;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 8000);
        }
        setRenderProgress(100);
        flash(
          `Exported ${outName} (${(rawBlob.size / 1024 / 1024).toFixed(1)} MB)` +
            (isMp4 ? "" : " — WebM (Browser). MP4: npm run tauri:dev + ffmpeg, oder convert-webm-to-mp4.ps1")
        );
      }
    } catch (e) {
      console.warn("[export] save error", e);
      flash("Export failed to save file");
    } finally {
      finishUi();
    }
  }, [
    isRendering,
    project.durationMs,
    project.name,
    stopPlayback,
    seekTo,
    startPlayback,
    loopInMs,
    loopOutMs,
  ]);

  const openExportDialog = useCallback(() => {
    setExportName((project.name || "resonance").replace(/\s+/g, "_") + "_render");
    setShowExportDlg(true);
  }, [project.name]);

  const renderComposition = useCallback(() => {
    openExportDialog();
  }, [openExportDialog]);

  const openProjectFile = useCallback(async (files: FileList | null) => {
    if (!files?.length) return;
    const text = await files[0].text();
    try {
      const parsed = JSON.parse(text) as Project;
      if (!parsed.id || !Array.isArray(parsed.tracks)) throw new Error("Invalid project");
      stopPlayback();
      const ensured = ensureMultiTrack(parsed);
      const hydrated = await hydrateMediaAssets(ensured.mediaAssets);
      setProject({ ...ensured, mediaAssets: hydrated });
      setSelectedClipId(null);
      setPendingProposal(null);
      const miss = hydrated.filter((a) => !a.localPathOrUrl.startsWith("blob:")).length;
      flash(miss ? `Opened — ${miss} media need ↻ Re-import All` : "Project opened with media");
      setShowWelcome(false);
    } catch (e) {
      flash("Open failed: invalid project file");
      console.warn(e);
    }
  }, [stopPlayback]);

  // ---------- CLIP DRAG ----------

  const zoomIn = useCallback(() => {
    setTimelineZoom((z) => Math.min(64, z * 1.5));
  }, []);
  const zoomOut = useCallback(() => {
    setTimelineZoom((z) => {
      const next = Math.max(1, z / 1.5);
      if (next <= 1.05) {
        setViewStartMs(0);
        return 1;
      }
      return next;
    });
  }, []);
  const zoomFit = useCallback(() => {
    setTimelineZoom(1);
    setViewStartMs(0);
  }, []);
  const zoomAroundPlayhead = useCallback((factor: number) => {
    setTimelineZoom((z) => {
      const next = Math.min(64, Math.max(1, z * factor));
      const vd = Math.max(500, duration / next);
      const center = project.playheadMs;
      setViewStartMs(Math.max(0, Math.min(duration - vd, center - vd / 2)));
      return next;
    });
  }, [duration, project.playheadMs]);

  const stepFrame = useCallback((dir: -1 | 1) => {
    stopPlayback();
    const next = Math.max(0, Math.min(duration, project.playheadMs + dir * FRAME_MS));
    seekTo(next);
  }, [duration, project.playheadMs, seekTo, stopPlayback]);

  const durationRef = useRef(duration);
  durationRef.current = duration;
  const zoomRef = useRef(timelineZoom);
  zoomRef.current = timelineZoom;
  const snapRef = useRef(snapEnabled);
  snapRef.current = snapEnabled;
  const tracksRef = useRef(project.tracks);
  tracksRef.current = project.tracks;

  const onClipPointerDown = useCallback((e: React.PointerEvent, clip: Clip) => {
    e.stopPropagation();
    e.preventDefault();
    setSelectedClipId(clip.id);
    setTargetTrackId(clip.trackId);
    setCtxMenu(null);

    if (tool === "copy") {
      setClipClipboard({ ...clip });
      flash("Copied");
      setTool("select");
      return;
    }

    const tracksEl = timelineLaneRef.current?.querySelector(".timeline-tracks") as HTMLElement | null;
    const widthEl = tracksEl ?? timelineLaneRef.current;
    if (!widthEl) return;

    const laneWidth = widthEl.getBoundingClientRect().width || 1;
    const startX = e.clientX;
    const origStartMs = clip.range.startMs;
    const dur = clip.range.endMs - clip.range.startMs;
    const clipId = clip.id;
    let fromTrackId = clip.trackId;
    const kind = tracksRef.current.find((t) => t.id === fromTrackId)?.kind;

    setUndoStack((s) => [...s.slice(-29), project]);
    setRedoStack([]);
    dragRef.current = {
      clipId,
      startX,
      startY: e.clientY,
      origStartMs,
      durationMs: dur,
      fromTrackId,
    };

    const findTrackAtY = (clientY: number): Track | null => {
      const root = timelineLaneRef.current;
      if (!root) return null;
      const lanes = root.querySelectorAll<HTMLElement>(".track-lane");
      for (const lane of lanes) {
        const r = lane.getBoundingClientRect();
        if (clientY >= r.top && clientY <= r.bottom) {
          const id = lane.dataset.trackId;
          return tracksRef.current.find((t) => t.id === id) ?? null;
        }
      }
      return null;
    };

    const onMove = (ev: PointerEvent) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - startX;
      const dMs = (dx / laneWidth) * (durationRef.current / Math.max(1, zoomRef.current));
      const newStart = Math.max(0, origStartMs + dMs);

      const over = findTrackAtY(ev.clientY);
      const switchTo =
        over && over.id !== fromTrackId && over.kind === kind ? over : null;

      if (switchTo) {
        const targetId = switchTo.id;
        setProject((p) => {
          let moving: Clip | null = null;
          for (const t of p.tracks) {
            const c = t.clips.find((x) => x.id === clipId);
            if (c) {
              moving = c;
              break;
            }
          }
          if (!moving) return p;
          fromTrackId = targetId;
          if (dragRef.current) dragRef.current.fromTrackId = targetId;
          return {
            ...p,
            durationMs: Math.max(p.durationMs, newStart + dur),
            tracks: p.tracks.map((t) => {
              if (t.clips.some((c) => c.id === clipId)) {
                return { ...t, clips: t.clips.filter((c) => c.id !== clipId) };
              }
              if (t.id === targetId) {
                return {
                  ...t,
                  clips: [
                    ...t.clips.filter((c) => c.id !== clipId),
                    {
                      ...moving!,
                      trackId: targetId,
                      range: { startMs: newStart, endMs: newStart + dur },
                    },
                  ],
                };
              }
              return t;
            }),
          };
        });
        setTargetTrackId(targetId);
        return;
      }

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
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [tool]);


  const reimportAll = useCallback(() => {
    const missing = project.mediaAssets.filter((a) => !isPlayableMediaUrl(a.localPathOrUrl));
    if (!missing.length) {
      flash("Nothing to re-import");
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = "audio/*,video/*";
    input.onchange = async () => {
      const files = input.files;
      if (!files?.length) return;
      const byName = new Map<string, File>();
      for (let i = 0; i < files.length; i++) byName.set(files[i].name, files[i]);
      let linked = 0;
      const updates: { id: string; url: string; name: string }[] = [];
      for (const a of project.mediaAssets) {
        if (isPlayableMediaUrl(a.localPathOrUrl)) continue;
        const f = byName.get(a.name);
        if (!f) continue;
        const url = URL.createObjectURL(f);
        try {
          await putMediaBlob(a.id, f, f.name, f.type || "application/octet-stream");
        } catch (err) {
          console.warn(err);
        }
        updates.push({ id: a.id, url, name: f.name });
        linked++;
      }
      if (updates.length) {
        setProject((p) => ({
          ...p,
          mediaAssets: p.mediaAssets.map((a) => {
            const u = updates.find((x) => x.id === a.id);
            return u ? { ...a, localPathOrUrl: u.url, name: u.name } : a;
          }),
        }));
      }
      flash(linked ? `Re-linked ${linked} file(s) — saved for next reload` : "No filename matches — select original files");
    };
    input.click();
  }, [project.mediaAssets]);

  const copySelectedClip = useCallback(() => {
    if (!selectedClipId) return;
    for (const t of project.tracks) {
      const c = t.clips.find((x) => x.id === selectedClipId);
      if (c) {
        setClipClipboard({ ...c });
        flash("Copied");
        return;
      }
    }
  }, [selectedClipId, project.tracks]);

  const pasteClipAtPlayhead = useCallback(() => {
    if (!clipClipboard) {
      flash("Clipboard empty");
      return;
    }
    setUndoStack((s) => [...s.slice(-29), project]);
    setRedoStack([]);
    const kind = project.tracks.find((t) => t.id === clipClipboard.trackId)?.kind
      ?? project.tracks.find((t) => t.id === (targetTrackId ?? ""))?.kind
      ?? "VIDEO";
    const track =
      project.tracks.find((t) => t.id === targetTrackId && t.kind === kind) ??
      project.tracks.find((t) => t.kind === kind)!;
    const dur = clipClipboard.range.endMs - clipClipboard.range.startMs;
    // prefer nearest non-beat marker within 1s, else playhead
    const markers = project.markers.filter((m) => m.kind !== "beat");
    let startMs = project.playheadMs;
    if (markers.length) {
      let best = markers[0];
      let bestD = Math.abs(best.timeMs - project.playheadMs);
      for (const m of markers) {
        const d = Math.abs(m.timeMs - project.playheadMs);
        if (d < bestD) {
          best = m;
          bestD = d;
        }
      }
      if (bestD <= 1000) {
        startMs = best.timeMs;
        flash(`Paste @ marker ${best.label}`);
      }
    }
    const newClip: Clip = {
      ...clipClipboard,
      id: crypto.randomUUID(),
      trackId: track.id,
      range: { startMs, endMs: startMs + dur },
      label: (clipClipboard.label || "clip") + " copy",
    };
    setProject((p) => ({
      ...p,
      durationMs: Math.max(p.durationMs, startMs + dur),
      tracks: p.tracks.map((t) =>
        t.id === track.id ? { ...t, clips: [...t.clips, newClip] } : t
      ),
    }));
    setSelectedClipId(newClip.id);
    flash(`Pasted on ${track.name}`);
    setTool("select");
  }, [clipClipboard, project.playheadMs, project.tracks, targetTrackId]);


  const addMarkerAtPlayhead = useCallback(() => {
    const ph = project.playheadMs;
    const id = crypto.randomUUID();
    setProject((p) => ({
      ...p,
      markers: [
        ...p.markers,
        { id, timeMs: ph, label: `M${p.markers.filter(m=>m.kind!=="beat").length + 1}`, kind: "cut" as const },
      ],
    }));
    flash(`Marker at ${formatTime(ph)}`);
  }, [project.playheadMs]);

  const clearMarkers = useCallback(() => {
    setProject((p) => ({
      ...p,
      markers: p.markers.filter((m) => m.kind === "beat"),
    }));
    flash("Markers cleared");
  }, []);

  // ---------- SPLIT / DELETE ----------
  const splitAtPlayhead = useCallback(() => {
    const ph = project.playheadMs;
    setUndoStack((s) => [...s.slice(-29), project]);
    setRedoStack([]);
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
    setUndoStack((s) => [...s.slice(-29), project]);
    setRedoStack([]);
    setProject((p) => ({
      ...p,
      tracks: p.tracks.map((t) => ({
        ...t,
        clips: t.clips.filter((c) => c.id !== selectedClipId),
      })),
    }));
    setSelectedClipId(null);
    flash("Clip deleted");
  }, [selectedClipId, project]);

  const onTimelineClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (dragRef.current) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * 100;
      seekTo(pctToMs(pct));
    },
    [seekTo, clampedViewStart, viewDurationMs]
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


  // Close context menu on outside click (not on mouseleave — that blocked tool selection)
  useEffect(() => {
    if (!ctxMenu) return;
    const onDown = (e: MouseEvent) => {
      const el = document.getElementById("rs-ctx-menu");
      if (el && el.contains(e.target as Node)) return;
      setCtxMenu(null);
    };
    // delay so the opening contextmenu event doesn't immediately close
    const t = window.setTimeout(() => {
      window.addEventListener("mousedown", onDown);
    }, 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("mousedown", onDown);
    };
  }, [ctxMenu]);

  const playheadPct = msToPct(project.playheadMs);
  const playheadInView = project.playheadMs >= clampedViewStart && project.playheadMs <= clampedViewStart + viewDurationMs;
  const vaultStatus = localOnlyVaultAdapter.getStatus();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return;
      if (e.code === "Space") {
        e.preventDefault();
        togglePlay();
      }
      // V = razor/cut. C unbound (Ctrl+C = copy).
      if (!e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "v" || e.key === "V")) {
        e.preventDefault();
        splitAtPlayhead();
      }
      if (e.key === "m" || e.key === "M") {
        e.preventDefault();
        addMarkerAtPlayhead();
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelectedClip();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        downloadProject();
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "c" || e.key === "C")) {
        e.preventDefault();
        copySelectedClip();
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "v" || e.key === "V")) {
        e.preventDefault();
        pasteClipAtPlayhead();
      }
      if (e.key === "Escape") {
        setTool("select");
        setCtxMenu(null);
      }
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        zoomAroundPlayhead(1.5);
      }
      if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomAroundPlayhead(1 / 1.5);
      }
      if (e.key === "ArrowLeft" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        stepFrame(-1);
      }
      if (e.key === "ArrowRight" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        stepFrame(1);
      }
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        zoomFit();
      }
      if (e.key === "l" || e.key === "L") {
        e.preventDefault();
        if (loopInMs != null && loopOutMs != null) {
          setLoopEnabled((v) => !v);
        }
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z") && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
      if ((e.metaKey || e.ctrlKey) && ((e.key === "y" || e.key === "Y") || ((e.key === "z" || e.key === "Z") && e.shiftKey))) {
        e.preventDefault();
        redo();
      }
      if ((e.key === "s" || e.key === "S") && !(e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setSnapEnabled((v) => {
          flash(!v ? "Snap ON" : "Snap OFF");
          return !v;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, splitAtPlayhead, deleteSelectedClip, downloadProject, addMarkerAtPlayhead, copySelectedClip, pasteClipAtPlayhead, zoomAroundPlayhead, stepFrame, zoomFit, undo, redo, loopInMs, loopOutMs]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="logo">AILEXSI Resonance Studio Suite <span className="version">V{APP_VERSION}</span></div>
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
            void clearAllMediaBlobs();
            setShowWelcome(true);
            flash("New project");
          }}>New</button>
          <button type="button" onClick={() => openInputRef.current?.click()}>Open</button>
          <button type="button" onClick={() => downloadProject()}>Save</button>
          <button type="button" onClick={() => void renderComposition()} disabled={isRendering}>
            {isRendering ? `Render ${renderProgress}%` : desktopMp4Ready ? "Export MP4" : "Export"}
          </button>
          {isRendering && (
            <button type="button" onClick={cancelExport} style={{ color: "#f88", borderColor: "#a44" }}>
              Cancel
            </button>
          )}
          <button type="button" onClick={splitAtPlayhead} title="V — cut at playhead">Cut</button>
          <button type="button" onClick={addMarkerAtPlayhead} title="M — marker at playhead">Marker</button>
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
          {statusMsg ?? `Tool: ${tool} · Vault: ${vaultStatus.mode}`}
        </div>
      </header>

      <aside className="media-panel">
        <h3 style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <span>Media / Project</span>
          <button
            type="button"
            title="Re-import all missing media (match by filename)"
            onClick={reimportAll}
            style={{
              border: "1px solid #444",
              background: "#1a1f27",
              color: "#cde",
              borderRadius: 6,
              padding: "2px 8px",
              cursor: "pointer",
              fontSize: 14,
              lineHeight: 1.2,
            }}
          >
            ↻
          </button>
        </h3>
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
              onDoubleClick={() => {
                if (isPlayableMediaUrl(a.localPathOrUrl)) addAssetToTimeline(a.id);
              }}
              title="Double-click → place at playhead"
            >
              <div className="name">{a.name}</div>
              <div className="meta">
                {a.type} · {formatTime(a.durationMs)}
                {!isPlayableMediaUrl(a.localPathOrUrl) && (
                  <span style={{ color: "#f86", marginLeft: 6 }}>· missing</span>
                )}
              </div>
              {!isPlayableMediaUrl(a.localPathOrUrl) && (
                <button
                  type="button"
                  style={{
                    marginTop: 6, width: "100%", fontSize: 11, padding: "4px 6px",
                    borderRadius: 4, border: "1px solid #a53", background: "#2a1810",
                    color: "#fca", cursor: "pointer",
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    const input = document.createElement("input");
                    input.type = "file";
                    input.accept = a.type === "video" ? "video/*" : "audio/*";
                    input.onchange = async () => {
                      if (input.files?.length) {
                        const f = input.files[0];
                        const url = URL.createObjectURL(f);
                        try {
                          await putMediaBlob(a.id, f, f.name, f.type || "application/octet-stream");
                        } catch (err) {
                          console.warn(err);
                        }
                        setProject((p) => ({
                          ...p,
                          mediaAssets: p.mediaAssets.map((x) =>
                            x.id === a.id
                              ? {
                                  ...x,
                                  name: f.name,
                                  localPathOrUrl: url,
                                  durationMs: x.durationMs,
                                }
                              : x
                          ),
                        }));
                        flash(`Re-linked → ${f.name}`);
                      }
                    };
                    input.click();
                  }}
                >
                  Re-import…
                </button>
              )}
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
              multiple
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
            <div
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                overflow: "hidden",
              }}
            >
              <video
                key={activeVideoAsset.id}
                ref={videoRef}
                src={activeVideoAsset.localPathOrUrl}
                muted={muteVideo}
                playsInline
                preload="auto"
                disablePictureInPicture
                controlsList="nodownload noplaybackrate noremoteplayback"
                style={{
                  maxWidth: "100%",
                  maxHeight: "100%",
                  width: "auto",
                  height: "auto",
                  objectFit: "contain",
                  background: "#000",
                }}
              />
            </div>
          ) : (
            <div className="placeholder">
              <div style={{ fontSize: 16, marginBottom: 8 }}>Main Output</div>
              <span className="muted">
                {activeVideoClip && !activeVideoAsset
                  ? "Media missing — re-import the file (same name relinks clips)"
                  : hasAnyAudio
                    ? "Audio only at playhead"
                    : "Import & place media on V1/V2"}
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
          <button
            type="button"
            onClick={() => {
              if (loopInMs == null || loopOutMs == null) {
                flash("Set IN/OUT on ruler first (two clicks)");
                return;
              }
              setLoopEnabled((v) => {
                flash(!v ? "Loop ON" : "Loop OFF");
                return !v;
              });
            }}
            title="Loop IN↔OUT"
            style={{
              color: loopEnabled ? "#3ecf8e" : undefined,
              borderColor: loopEnabled ? "#3ecf8e" : undefined,
              background: loopEnabled ? "rgba(62,207,142,0.12)" : undefined,
            }}
          >
            🔁
          </button>
          <button
            type="button"
            onClick={() => {
              setLoopInMs(null);
              setLoopOutMs(null);
              setLoopEnabled(false);
              setRangeClickStep("in");
              flash("Range cleared");
            }}
            title="Clear IN/OUT range"
          >
            ⌫
          </button>
          <button type="button" onClick={splitAtPlayhead} title="V — cut at playhead">✂</button>
          <button type="button" onClick={() => stepFrame(-1)} title="Frame − (←)">‹</button>
          <button type="button" onClick={() => stepFrame(1)} title="Frame + (→)">›</button>
          <span className="time">{formatTime(project.playheadMs)}</span>
          <label
            className="muted"
            style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, marginLeft: 8 }}
            title="Zoom at playhead / marker"
          >
            Zoom
            <input
              type="range"
              min={1}
              max={64}
              step={0.1}
              value={timelineZoom}
              onChange={(e) => {
                const next = Number(e.target.value);
                const vd = Math.max(500, duration / next);
                // keep playhead centered in the view
                const center = project.playheadMs;
                setViewStartMs(Math.max(0, Math.min(Math.max(0, duration - vd), center - vd / 2)));
                setTimelineZoom(next);
              }}
              style={{ width: 110, accentColor: "#5b8def", cursor: "pointer" }}
            />
            <span style={{ minWidth: 36, fontVariantNumeric: "tabular-nums" }}>
              {timelineZoom < 1.05 ? "Fit" : `${timelineZoom.toFixed(1)}×`}
            </span>
          </label>
          <button type="button" onClick={zoomFit} title="Fit whole project (F)">Fit</button>
          <button
            type="button"
            onClick={() => setSnapEnabled((v) => !v)}
            title="Snap (S)"
            style={{
              color: snapEnabled ? "#5b8def" : undefined,
              borderColor: snapEnabled ? "#5b8def" : undefined,
            }}
          >
            Snap
          </button>
          <button type="button" onClick={undo} title="Undo (Ctrl+Z)">↶</button>
          <button type="button" onClick={redo} title="Redo (Ctrl+Y)">↷</button>
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
        {isRendering && (
          <div style={{
            position: "absolute", inset: 0, background: "rgba(0,0,0,0.72)",
            display: "flex", flexDirection: "column", alignItems: "center",
            justifyContent: "center", zIndex: 20, gap: 12,
          }}>
            <div style={{ fontSize: 16 }}>Rendering composition…</div>
            <div style={{ width: 240, height: 6, background: "#333", borderRadius: 3 }}>
              <div style={{
                width: `${renderProgress}%`, height: "100%",
                background: "#4af", borderRadius: 3, transition: "width 0.2s",
              }} />
            </div>
            <div className="muted" style={{ fontSize: 12 }}>{renderProgress}% — {exportPhase === "saving" ? "Saving file…" : "Recording"}</div>
            <button
              type="button"
              onClick={cancelExport}
              style={{
                marginTop: 8, padding: "8px 18px", borderRadius: 6,
                border: "1px solid #a44", background: "#2a1515", color: "#faa",
                cursor: "pointer", fontSize: 13,
              }}
            >
              Cancel export
            </button>
          </div>
        )}
      </main>

      <aside className="inspector" style={{ display: "flex", flexDirection: "column" }}>
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
            Space Play · ← → Frame · + − Zoom · F Fit<br />
            Ctrl+Wheel zoom · Wheel pan<br />
            V Cut · M Marker · Drag tracks · C free
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
        <div className="timeline-body">
          <div className="timeline-labels">
            <div className="timeline-label-spacer" />
            {project.tracks.map((track) => (
              <div
                key={track.id}
                className={`timeline-label ${track.kind}${targetTrackId === track.id ? " active" : ""}`}
                onClick={() => setTargetTrackId(track.id)}
                title="Target track for Import / Place"
              >
                {track.name}
              </div>
            ))}
          </div>
          <div
            className="timeline-canvas"
            ref={timelineLaneRef}
            style={{
              cursor:
                tool === "copy" ? "copy" : tool === "paste" ? "cell" : "default",
            }}
            onMouseLeave={() => {
              // reset tool, but keep context menu until click-outside
              if (tool !== "select" && !ctxMenu) setTool("select");
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtxMenu({ x: e.clientX, y: e.clientY });
            }}
            onClick={() => {
              if (tool === "paste" && clipClipboard) {
                pasteClipAtPlayhead();
              }
              setCtxMenu(null);
            }}
            onWheel={(e) => {
              e.preventDefault();
              if (e.ctrlKey || e.metaKey) {
                // zoom around cursor
                const rect = e.currentTarget.getBoundingClientRect();
                const pct = (e.clientX - rect.left) / rect.width;
                const anchorMs = clampedViewStart + pct * viewDurationMs;
                const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
                setTimelineZoom((z) => {
                  const next = Math.min(64, Math.max(1, z * factor));
                  const vd = Math.max(500, duration / next);
                  setViewStartMs(Math.max(0, Math.min(duration - vd, anchorMs - pct * vd)));
                  return next;
                });
              } else {
                // pan
                const shift = (e.deltaY + e.deltaX) * viewDurationMs * 0.0015;
                setViewStartMs((s) =>
                  Math.max(0, Math.min(Math.max(0, duration - viewDurationMs), s + shift))
                );
              }
            }}
          >
            <div
              className="timeline-ruler"
              onClick={(e) => {
                // Left click = jump only
                if (dragRef.current) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * 100;
                seekTo(pctToMs(pct));
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * 100;
                const t = pctToMs(pct);
                seekTo(t);
                // Right-click: IN then OUT
                if (rangeClickStep === "in" || loopInMs === null) {
                  setLoopInMs(t);
                  setLoopOutMs(null);
                  setRangeClickStep("out");
                  flash(`IN ${formatTime(t)} — right-click OUT`);
                } else {
                  const a = Math.min(loopInMs!, t);
                  const b = Math.max(loopInMs!, t);
                  if (b - a < 50) {
                    flash("Range too short");
                    return;
                  }
                  setLoopInMs(a);
                  setLoopOutMs(b);
                  setRangeClickStep("in");
                  flash(`OUT ${formatTime(b)} · range set`);
                }
              }}
            >
              {/* Tick marks: denser when zoomed */}
              {(() => {
                const major =
                  timelineZoom >= 32 ? 20 : timelineZoom >= 12 ? 12 : timelineZoom >= 4 ? 8 : 4;
                const minor = major * 4;
                const ticks = [];
                for (let i = 0; i <= minor; i++) {
                  const p = i / minor;
                  const isMajor = i % 4 === 0;
                  ticks.push(
                    <div
                      key={`t${i}`}
                      className={`ruler-tick ${isMajor ? "major" : "minor"}`}
                      style={{ left: `${p * 100}%` }}
                    />
                  );
                  if (isMajor) {
                    ticks.push(
                      <span
                        key={`l${i}`}
                        className="ruler-label"
                        style={{ left: `${p * 100}%` }}
                      >
                        {formatTime(clampedViewStart + p * viewDurationMs)}
                      </span>
                    );
                  }
                }
                return ticks;
              })()}
              {timelineZoom > 1.2 && (
                <span className="ruler-zoom-badge">{timelineZoom.toFixed(1)}×</span>
              )}
            </div>
            <div className="timeline-tracks">
              {loopInMs != null && loopOutMs != null && (
                <div
                  className="loop-region"
                  style={{
                    left: `${msToPct(loopInMs)}%`,
                    width: `${Math.max(0.2, msToPct(loopOutMs) - msToPct(loopInMs))}%`,
                  }}
                />
              )}
              {loopInMs != null && loopInMs >= clampedViewStart && loopInMs <= clampedViewStart + viewDurationMs && (
                <div className="loop-flag in" style={{ left: `${msToPct(loopInMs)}%` }} title="Loop IN">
                  <span className="loop-flag-label">IN</span>
                </div>
              )}
              {loopOutMs != null && loopOutMs >= clampedViewStart && loopOutMs <= clampedViewStart + viewDurationMs && (
                <div className="loop-flag out" style={{ left: `${msToPct(loopOutMs)}%` }} title="Loop OUT">
                  <span className="loop-flag-label">OUT</span>
                </div>
              )}
              {project.tracks.map((track) => (
                <div
                  key={track.id}
                  className="track-lane"
                  data-track-id={track.id}
                  onClick={(e) => {
                    setTargetTrackId(track.id);
                    onTimelineClick(e);
                    if (tool === "paste" && clipClipboard) {
                      e.stopPropagation();
                      pasteClipAtPlayhead();
                    }
                  }}
                >
                  {track.clips.map((clip) => {
                    const c0 = clip.range.startMs;
                    const c1 = clip.range.endMs;
                    if (c1 < clampedViewStart || c0 > clampedViewStart + viewDurationMs) return null;
                    const left = msToPct(c0);
                    const right = msToPct(c1);
                    const width = Math.max(right - left, 0.15);
                    const selected = selectedClipId === clip.id;
                    return (
                      <div
                        key={clip.id}
                        className={`clip ${track.kind}`}
                        style={{
                          left: `${left}%`,
                          width: `${width}%`,
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
                        {track.kind === "AUDIO" && (() => {
                          const asset = project.mediaAssets.find((a) => a.id === clip.mediaAssetId);
                          const peaks = asset?.analysis?.waveformPeaks;
                          if (!peaks?.length) return null;
                          return (
                            <div className="clip-wave" aria-hidden>
                              {peaks.map((pk, i) => (
                                <span key={i} style={{ height: `${Math.max(8, pk * 100)}%` }} />
                              ))}
                            </div>
                          );
                        })()}
                        <span className="clip-label">{clip.label || track.name}</span>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
            {/* single playhead spanning ruler + all lanes */}
            {playheadInView && <div className="timeline-playhead" style={{ left: `${playheadPct}%` }} />}
            {project.markers
              .filter((m) => m.kind !== "beat")
              .filter((m) => m.timeMs >= clampedViewStart && m.timeMs <= clampedViewStart + viewDurationMs)
              .map((m) => (
                <div
                  key={m.id}
                  className="timeline-marker"
                  data-label={m.label}
                  style={{ left: `${msToPct(m.timeMs)}%` }}
                />
              ))}
          </div>
          {/* Master strip — fader + live peak */}
          <div className="master-strip" title="Main Out">
            <div className="master-label">MAIN</div>
            <div className="master-meter">
              <div
                className="master-meter-fill"
                style={{
                  height: `${Math.round(meterLevel * 100)}%`,
                  background:
                    meterLevel > 0.85 ? "#e74c3c" : meterLevel > 0.6 ? "#f5a623" : "#3ecf8e",
                }}
              />
            </div>
            <input
              className="master-fader"
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={masterVolume}
              onChange={(e) => setMasterVolume(Number(e.target.value))}
              title={`Volume ${Math.round(masterVolume * 100)}%`}
            />
            <div className="master-pct">{Math.round(masterVolume * 100)}</div>
          </div>
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



      {showWelcome && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.72)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 150,
        }}>
          <div style={{
            background: "#151a22", border: "1px solid #333", borderRadius: 12,
            padding: 28, width: 420, maxWidth: "92vw",
          }}>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8, color: "#5b8def" }}>
              AILEXSI Resonance Studio
            </div>
            <p className="muted" style={{ lineHeight: 1.55, marginBottom: 18, fontSize: 13 }}>
              Local-first. Media is stored in this browser so reload keeps your files.
              Import video + audio to start, or open a saved project.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button type="button" onClick={() => {
                setShowWelcome(false);
                document.getElementById("file-input")?.click();
              }} style={{
                padding: "10px 14px", borderRadius: 8, border: "none",
                background: "#5b8def", color: "#fff", fontWeight: 600, cursor: "pointer",
              }}>Import media</button>
              <button type="button" onClick={() => {
                setShowWelcome(false);
                openInputRef.current?.click();
              }} style={{
                padding: "10px 14px", borderRadius: 8, border: "1px solid #444",
                background: "transparent", color: "#e8eaed", cursor: "pointer",
              }}>Open project (.json)</button>
              <button type="button" onClick={() => setShowWelcome(false)} style={{
                padding: "8px", border: "none", background: "transparent",
                color: "#8b93a7", cursor: "pointer", fontSize: 12,
              }}>Continue empty</button>
            </div>
          </div>
        </div>
      )}

      {ctxMenu && (
        <div
          id="rs-ctx-menu"
          style={{
            position: "fixed",
            left: ctxMenu.x,
            top: ctxMenu.y,
            zIndex: 200,
            background: "#1a1f27",
            border: "1px solid #333",
            borderRadius: 8,
            padding: 4,
            minWidth: 160,
            boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
          }}
        >
          {([
            ["select", "↖  Select / Move"],
            ["copy", "❐  Copy tool"],
            ["paste", "⧉  Paste tool"],
          ] as [EditorTool, string][]).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setTool(id);
                setCtxMenu(null);
                flash(id === "select" ? "Select tool" : id === "copy" ? "Copy tool — click a clip" : "Paste tool — click timeline");
              }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "8px 12px",
                border: "none",
                borderRadius: 6,
                background: tool === id ? "#2a3548" : "transparent",
                color: "#e8eaed",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
              {label}
            </button>
          ))}
          <div style={{ height: 1, background: "#333", margin: "4px 0" }} />
          <button
            type="button"
            onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); copySelectedClip(); setCtxMenu(null); }}
            style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", border: "none", borderRadius: 6, background: "transparent", color: "#e8eaed", cursor: "pointer", fontSize: 12 }}
          >
            Copy selected (Ctrl+C)
          </button>
          <button
            type="button"
            onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); pasteClipAtPlayhead(); setCtxMenu(null); }}
            style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", border: "none", borderRadius: 6, background: "transparent", color: "#e8eaed", cursor: "pointer", fontSize: 12 }}
          >
            Paste at playhead (Ctrl+V)
          </button>
        </div>
      )}

      {showExportDlg && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.65)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100,
        }}>
          <div style={{
            background: "#151a22", border: "1px solid #333", borderRadius: 10,
            padding: 20, width: 360, display: "flex", flexDirection: "column", gap: 12,
          }}>
            <div style={{ fontWeight: 600 }}>Export composition</div>
            <label style={{ fontSize: 12, color: "#8b93a7" }}>Filename</label>
            <input
              autoFocus
              value={exportName}
              onChange={(e) => setExportName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && exportName.trim()) void startExportWithName(exportName.trim());
                if (e.key === "Escape") setShowExportDlg(false);
              }}
              style={{
                padding: "8px 10px", borderRadius: 6, border: "1px solid #333",
                background: "#0d0f12", color: "#e8eaed", fontSize: 13,
              }}
            />
            <div className="muted" style={{ fontSize: 11 }}>
              {loopInMs != null && loopOutMs != null
                ? `MP4 export · IN→OUT only (${((loopOutMs - loopInMs) / 1000).toFixed(1)}s). Clear range for full timeline.`
                : "Full timeline. Set IN/OUT (right-click ruler) to export a range."}
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" onClick={() => setShowExportDlg(false)}
                style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #444", background: "transparent", color: "#ccc", cursor: "pointer" }}>
                Cancel
              </button>
              <button type="button" onClick={() => void startExportWithName(exportName.trim() || "resonance_render")}
                style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: "#5b8def", color: "#fff", cursor: "pointer", fontWeight: 600 }}>
                Start export
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
