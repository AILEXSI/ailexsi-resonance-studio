import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

let ffmpeg: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

export async function getFFmpeg(onProgress?: (ratio: number) => void): Promise<FFmpeg> {
  if (ffmpeg?.loaded) {
    if (onProgress) {
      ffmpeg.on("progress", ({ progress }) => onProgress(progress));
    }
    return ffmpeg;
  }
  if (loading) return loading;

  loading = (async () => {
    const ff = new FFmpeg();
    if (onProgress) {
      ff.on("progress", ({ progress }) => onProgress(Math.min(0.99, progress)));
    }
    ff.on("log", ({ message }) => {
      if (message) console.debug("[ffmpeg]", message);
    });

    const base = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm";
    await withTimeout(
      ff.load({
        coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, "application/wasm"),
      }),
      45_000,
      "ffmpeg.load"
    );
    ffmpeg = ff;
    return ff;
  })().catch((e) => {
    loading = null;
    ffmpeg = null;
    throw e;
  });

  return loading;
}

/**
 * Convert WebM → MP4. Tries libx264, then mpeg4.
 * Throws on failure (caller falls back to WebM).
 */
export async function webmToMp4(
  input: Blob,
  onProgress?: (ratio: number) => void
): Promise<Blob> {
  if (input.size < 1000) throw new Error("input too small");
  // Very large blobs choke browser WASM — fail fast
  if (input.size > 80 * 1024 * 1024) {
    throw new Error("input too large for in-browser MP4 convert");
  }

  const ff = await getFFmpeg(onProgress);
  const inName = "input.webm";
  const outName = "output.mp4";

  await ff.writeFile(inName, await fetchFile(input));

  const attempts: string[][] = [
    // H.264 — preferred when available in core build
    [
      "-i", inName,
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-crf", "28",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      "-y", outName,
    ],
    // MPEG-4 Part 2 — widely present in ffmpeg.wasm builds
    [
      "-i", inName,
      "-c:v", "mpeg4",
      "-q:v", "8",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      "-y", outName,
    ],
  ];

  let lastErr: unknown;
  for (const args of attempts) {
    try {
      try {
        await ff.deleteFile(outName);
      } catch {
        /* */
      }
      await withTimeout(ff.exec(args), 75_000, `ffmpeg.exec ${args[2]}`);
      const data = await ff.readFile(outName);
      await ff.deleteFile(inName).catch(() => undefined);
      await ff.deleteFile(outName).catch(() => undefined);
      const bytes =
        data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
      if (bytes.byteLength < 1000) throw new Error("mp4 output too small");
      return new Blob([bytes], { type: "video/mp4" });
    } catch (e) {
      lastErr = e;
      console.warn("[export-mp4] attempt failed", args[2], e);
    }
  }

  try {
    await ff.deleteFile(inName);
  } catch {
    /* */
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
