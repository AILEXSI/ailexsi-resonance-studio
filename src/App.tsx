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
  const [isRendering, setIsRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);
  const [exportName, setExportName] = useState("");
  const [showExportDlg, setShowExportDlg] = useState(false);
  const cancelRenderRef = useRef(false);

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
    if (isRendering) return;
    if (project.durationMs < 200) {
      flash("Nothing to render — add clips first");
      return;
    }
    const safeName = (filename || project.name || "resonance").replace(/[^\w\-]+/g, "_");
    cancelRenderRef.current = false;
    setShowExportDlg(false);
    setIsRendering(true);
    setRenderProgress(0);
    setPlayError(null);
    stopPlayback();
    seekTo(0);

    // Let seek settle
    await new Promise((r) => setTimeout(r, 120));

    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      setIsRendering(false);
      flash("Canvas not available");
      return;
    }

    const canvasStream = canvas.captureStream(30);
    const tracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks()];

    // Prefer element.captureStream for audio (no single-use WebAudio node limit)
    const captureAudio = (el: HTMLAudioElement | null) => {
      if (!el || !el.src) return;
      try {
        const anyEl = el as HTMLAudioElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream };
        const s = anyEl.captureStream?.() || anyEl.mozCaptureStream?.();
        if (s) for (const t of s.getAudioTracks()) tracks.push(t);
      } catch (e) {
        console.warn("[render] audio captureStream failed", e);
      }
    };
    captureAudio(audio1Ref.current);
    captureAudio(audio2Ref.current);

    const combined = new MediaStream(tracks);
    const mimeCandidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ];
    const mime = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) || "video/webm";
    const chunks: BlobPart[] = [];
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(combined, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
    } catch {
      recorder = new MediaRecorder(combined);
    }

    recorder.ondataavailable = (ev) => {
      if (ev.data.size) chunks.push(ev.data);
    };

    const done = new Promise<Blob>((resolve) => {
      recorder.onstop = () => {
        resolve(new Blob(chunks, { type: mime }));
      };
    });

    recorder.start(200);

    // Draw loop
    let drawing = true;
    const draw = () => {
      if (!drawing) return;
      const v = videoRef.current;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (v && v.readyState >= 2 && v.videoWidth > 0) {
        const scale = Math.min(canvas.width / v.videoWidth, canvas.height / v.videoHeight);
        const w = v.videoWidth * scale;
        const h = v.videoHeight * scale;
        const x = (canvas.width - w) / 2;
        const y = (canvas.height - h) / 2;
        ctx.drawImage(v, x, y, w, h);
      }
      requestAnimationFrame(draw);
    };
    draw();

    // Progress from playhead
    const total = project.durationMs;
    const progressTimer = window.setInterval(() => {
      setProject((p) => {
        setRenderProgress(Math.min(99, Math.round((p.playheadMs / total) * 100)));
        return p;
      });
    }, 200);

    await startPlayback();

    // Wait until end or cancel
    await new Promise<void>((resolve) => {
      const t0 = performance.now();
      const tickWait = () => {
        if (cancelRenderRef.current) {
          resolve();
          return;
        }
        if (performance.now() - t0 >= total + 400) {
          resolve();
          return;
        }
        requestAnimationFrame(tickWait);
      };
      tickWait();
    });

    stopPlayback();
    drawing = false;
    window.clearInterval(progressTimer);

    if (cancelRenderRef.current) {
      try { if (recorder.state !== "inactive") recorder.stop(); } catch { /* */ }
      setIsRendering(false);
      return;
    }

    if (recorder.state !== "inactive") recorder.stop();
    const blob = await done;

    const outName = `${safeName}.webm`;
    // Prefer system save dialog when available
    try {
      const w = window as Window & {
        showSaveFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle>;
      };
      if (typeof w.showSaveFilePicker === "function") {
        const handle = await w.showSaveFilePicker({
          suggestedName: outName,
          types: [{ description: "WebM video", accept: { "video/webm": [".webm"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        flash(`Exported → ${handle.name}`);
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = outName;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        flash(`Exported → ${outName}`);
      }
    } catch (e: unknown) {
      // user aborted picker
      const msg = e instanceof Error ? e.message : String(e);
      if (/abort/i.test(msg)) {
        flash("Export save cancelled");
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = outName;
        a.click();
        flash(`Exported → ${outName}`);
      }
    }

    setRenderProgress(100);
    setIsRendering(false);
  }, [
    isRendering,
    project.durationMs,
    project.name,
    stopPlayback,
    seekTo,
    startPlayback,
  ]);

  const openExportDialog = useCallback(() => {
    if (isRendering) return;
    setExportName(`${(project.name || "resonance").replace(/\s+/g, "_")}_render`);
    setShowExportDlg(true);
  }, [isRendering, project.name]);

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
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, splitAtPlayhead, deleteSelectedClip, downloadProject, addMarkerAtPlayhead]);

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
          <button type="button" onClick={() => void renderComposition()} disabled={isRendering}>
            {isRendering ? `Render ${renderProgress}%` : "Export"}
          </button>
          {isRendering && (
            <button type="button" onClick={cancelExport} style={{ color: "#f88", borderColor: "#a44" }}>
              Cancel
            </button>
          )}
          <button type="button" onClick={splitAtPlayhead} title="C">Cut</button>
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
                    input.onchange = () => {
                      if (input.files?.length) {
                        // force name match path: temporarily rename expectation
                        const f = input.files[0];
                        // If names differ, still relink this asset id
                        const url = URL.createObjectURL(f);
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
            <div className="muted" style={{ fontSize: 12 }}>{renderProgress}% — WebM export</div>
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
            Space Play/Pause · C Cut · M Marker · Del Delete<br />
            Ctrl+S Save · Multi-import supported<br />
            V2 overlays V1 · Re-import restores media
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
          <div className="timeline-canvas" ref={timelineLaneRef}>
            <div className="timeline-ruler" onClick={onTimelineClick}>
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
                <div
                  key={track.id}
                  className="track-lane"
                  onClick={(e) => {
                    setTargetTrackId(track.id);
                    onTimelineClick(e);
                  }}
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
                </div>
              ))}
            </div>
            {/* single playhead spanning ruler + all lanes */}
            <div className="timeline-playhead" style={{ left: `${playheadPct}%` }} />
            {project.markers
              .filter((m) => m.kind !== "beat")
              .map((m) => (
                <div
                  key={m.id}
                  className="timeline-marker"
                  data-label={m.label}
                  style={{ left: `${Math.min(100, (m.timeMs / duration) * 100)}%` }}
                />
              ))}
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
              After render you can choose the save location (Chrome/Edge) or a download starts.
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
