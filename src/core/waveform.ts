/** Decode audio file to normalized peak array for timeline display */
export async function extractWaveformPeaks(
  file: Blob,
  bars = 128
): Promise<number[]> {
  try {
    const ctx = new OfflineAudioContext(1, 44100, 44100);
    const buf = await file.arrayBuffer();
    const audio = await ctx.decodeAudioData(buf.slice(0));
    const ch = audio.getChannelData(0);
    const block = Math.max(1, Math.floor(ch.length / bars));
    const peaks: number[] = [];
    for (let i = 0; i < bars; i++) {
      let max = 0;
      const start = i * block;
      const end = Math.min(ch.length, start + block);
      for (let j = start; j < end; j++) {
        const v = Math.abs(ch[j]);
        if (v > max) max = v;
      }
      peaks.push(max);
    }
    const peak = Math.max(...peaks, 0.001);
    return peaks.map((p) => Math.min(1, p / peak));
  } catch {
    return Array.from({ length: bars }, () => 0.2 + Math.random() * 0.3);
  }
}
