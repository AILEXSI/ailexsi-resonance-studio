/** Desktop (Tauri) MP4 export via system ffmpeg. */

export function isTauri(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return !!(
    w.__TAURI__ ||
    w.__TAURI_IPC__ ||
    w.__TAURI_INTERNALS__ ||
    (w.__TAURI_METADATA__ as unknown)
  );
}

export async function checkFfmpeg(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/tauri");
    return await invoke<string>("check_ffmpeg");
  } catch (e) {
    console.warn("[tauri] check_ffmpeg", e);
    return null;
  }
}

/**
 * Write blob to temp, convert with system ffmpeg → H.264 MP4.
 */
export async function exportBlobToMp4(
  blob: Blob,
  suggestedName: string
): Promise<{ path: string; message: string }> {
  if (!isTauri()) {
    throw new Error("Not in Tauri desktop — start with: npm run tauri:dev");
  }

  const { invoke } = await import("@tauri-apps/api/tauri");
  const { save } = await import("@tauri-apps/api/dialog");
  const { writeBinaryFile } = await import("@tauri-apps/api/fs");
  const { tempDir, join } = await import("@tauri-apps/api/path");

  // Verify ffmpeg before writing large temps
  try {
    await invoke<string>("check_ffmpeg");
  } catch (e) {
    throw new Error(
      "ffmpeg not found. Install: winget install Gyan.FFmpeg — then restart the app"
    );
  }

  const safe = suggestedName.replace(/[^\w\-]+/g, "_").replace(/\.(mp4|webm)$/i, "");
  const tmp = await tempDir();
  const inPath = await join(tmp, `rs_${safe}_${Date.now()}.webm`);

  const bytes = new Uint8Array(await blob.arrayBuffer());
  await writeBinaryFile(inPath, bytes);

  let outPath = await save({
    defaultPath: `${safe}.mp4`,
    filters: [{ name: "MP4 video", extensions: ["mp4"] }],
  });

  if (!outPath) {
    // user cancelled save dialog — still convert to temp Downloads-style path
    outPath = await join(tmp, `${safe}.mp4`);
  }
  if (!outPath.toLowerCase().endsWith(".mp4")) {
    outPath = `${outPath}.mp4`;
  }

  const result = await invoke<{ ok: boolean; path: string; message: string }>(
    "export_webm_to_mp4",
    {
      inputPath: inPath,
      outputPath: outPath,
    }
  );

  if (!result?.ok) {
    throw new Error(result?.message || "ffmpeg convert failed");
  }
  return { path: result.path, message: result.message };
}
