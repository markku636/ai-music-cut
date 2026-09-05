import { describe, expect, it } from "vitest";
import { findHighlight } from "./highlight";
import type { LocalAnalysis } from "./peaks";

/** 造 60 秒素材：20–40 秒是「副歌」（大聲且有律動），其餘安靜。 */
function analysis(loudFrom = 20, loudTo = 40, seconds = 60): LocalAnalysis {
  const pps = 200;
  const n = seconds * pps;
  const rmsU8 = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const sec = i / pps;
    const loud = sec >= loudFrom && sec < loudTo;
    const beat = Math.floor((sec * 1000) % 500) < 40; // 120 BPM 的擊點
    rmsU8[i] = loud ? (beat ? 245 : 200) : beat ? 120 : 100;
  }
  return {
    version: 2,
    pps,
    hopMs: 100,
    sampleRate: 48000,
    nBuckets: n,
    nWin: 0,
    totalSamples: seconds * 48000,
    durationMs: seconds * 1000,
    mins: new Int8Array(0),
    maxs: new Int8Array(0),
    rmsU8,
    win: new Float32Array(0),
    zx: null,
  };
}

describe("highlight", () => {
  it("15 秒精華落在能量最強的區段", () => {
    const h = findHighlight(analysis(), { targetMs: 15000 });
    expect(h).not.toBeNull();
    // 允許提早一點進（前導）；重點是整段落在副歌範圍內
    expect(h!.startMs).toBeGreaterThanOrEqual(17000);
    expect(h!.endMs).toBeLessThanOrEqual(41000);
    expect(h!.score).toBeGreaterThan(0);
  });

  it("有拍網格時起訖貼齊小節線", () => {
    const grid = { bpm: 120, periodMs: 500, offsetMs: 0, confidence: 0.6, beatsPerBar: 4, beats: [] };
    const h = findHighlight(analysis(), { targetMs: 15000, beats: grid });
    expect(h!.barAligned).toBe(true);
    expect(h!.startMs % 2000).toBe(0); // 一小節 = 4 拍 × 500 ms
    expect((h!.endMs - h!.startMs) % 2000).toBe(0);
  });

  it("素材比目標短 → 夾到全長仍回結果", () => {
    const h = findHighlight(analysis(2, 5, 8), { targetMs: 60000 });
    expect(h).not.toBeNull();
    expect(h!.endMs).toBeLessThanOrEqual(8000);
  });

  it("太短的素材回 null", () => {
    const a = analysis(0, 1, 1);
    expect(findHighlight({ ...a, durationMs: 500 }, { targetMs: 30000 })).toBeNull();
  });
});
