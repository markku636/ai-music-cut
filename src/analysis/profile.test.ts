import { describe, expect, it } from "vitest";
import { bucketWidthMs, loudnessProfile, MAX_BUCKETS, MIN_BUCKET_MS, vsEpisode } from "./profile";
import { SILENCE_LUFS } from "./meter";
import type { LocalAnalysis } from "./peaks";

const HOP = 100;

/** 每個 100 ms 視窗一個 momentary 值；rmsU8 給 gate 用。 */
function analysis(momentary: number[]): LocalAnalysis {
  const win = new Float32Array(momentary.length * 3);
  momentary.forEach((m, i) => {
    win[i * 3] = m;
    win[i * 3 + 1] = m;
    win[i * 3 + 2] = m - 5;
  });
  const nBuckets = momentary.length * 20; // 5ms 一桶
  const rmsU8 = new Uint8Array(nBuckets);
  momentary.forEach((m, i) => {
    const v = Math.max(0, Math.min(255, Math.round(((m + 60) / 60) * 255)));
    for (let k = i * 20; k < (i + 1) * 20; k++) rmsU8[k] = v;
  });
  return {
    version: 3,
    pps: 200,
    hopMs: HOP,
    sampleRate: 48000,
    nBuckets,
    nWin: momentary.length,
    totalSamples: 0,
    durationMs: momentary.length * HOP,
    mins: new Int8Array(0),
    maxs: new Int8Array(0),
    rmsU8,
    win,
    zx: null,
  };
}

/** n 秒的等響度素材。 */
const flat = (sec: number, lufs: number) => analysis(Array.from({ length: sec * 10 }, () => lufs));

describe("bucketWidthMs", () => {
  it("桶數不多時就照要求的寬度", () => {
    expect(bucketWidthMs(600_000, 30_000)).toBe(30_000);
  });

  it("**長節目自動加寬**，不要回三百筆給模型讀", () => {
    const w = bucketWidthMs(3 * 3600_000, 30_000);
    expect(Math.ceil((3 * 3600_000) / w)).toBeLessThanOrEqual(MAX_BUCKETS);
  });

  it("加寬後是 5 秒的倍數（不要出現 37.4 秒這種數字）", () => {
    expect(bucketWidthMs(3 * 3600_000, 30_000) % 5000).toBe(0);
  });

  it("有最小寬度（再細對模型沒有意義）", () => {
    expect(bucketWidthMs(60_000, 10)).toBe(MIN_BUCKET_MS);
  });

  it("長度為 0 時不會除以零", () => {
    expect(bucketWidthMs(0, 30_000)).toBe(30_000);
  });
});

describe("loudnessProfile", () => {
  it("等響度的素材：每個桶子都一樣，整集也一樣", () => {
    const p = loudnessProfile(flat(120, -18), 30_000)!;
    expect(p.bucketMs).toBe(30_000);
    expect(p.buckets).toHaveLength(4);
    for (const b of p.buckets) expect(b.lufs).toBeCloseTo(-18, 1);
    expect(p.episodeLufs).toBeCloseTo(-18, 1);
  });

  it("找得出最安靜與最大聲的段落", () => {
    // 0–30s -12、30–60s -30、60–90s -20
    const a = analysis([
      ...Array.from({ length: 300 }, () => -12),
      ...Array.from({ length: 300 }, () => -30),
      ...Array.from({ length: 300 }, () => -20),
    ]);
    const p = loudnessProfile(a, 30_000)!;
    expect(p.quietest[0].startMs).toBe(30_000);
    expect(p.loudest[0].startMs).toBe(0);
  });

  it("**整段靜音的桶子不參與排名**（片頭空白不是「最安靜的一段」這種答案）", () => {
    const a = analysis([
      ...Array.from({ length: 300 }, () => -90), // 前 30 秒全靜音
      ...Array.from({ length: 300 }, () => -22),
      ...Array.from({ length: 300 }, () => -16),
    ]);
    const p = loudnessProfile(a, 30_000)!;
    expect(p.quietest.every((b) => b.startMs !== 0), "靜音桶不該被選為最安靜").toBe(true);
    expect(p.quietest[0].startMs).toBe(30_000);
  });

  it("最後一個桶子不會超出總長度", () => {
    const p = loudnessProfile(flat(95, -18), 30_000)!;
    expect(p.buckets[p.buckets.length - 1].endMs).toBe(95_000);
  });

  it("三小時的節目桶數在上限內", () => {
    const p = loudnessProfile(flat(3 * 3600, -18), 30_000)!;
    expect(p.buckets.length).toBeLessThanOrEqual(MAX_BUCKETS);
  });

  it("有底噪估計（回答「這一集吵不吵」）", () => {
    const p = loudnessProfile(flat(60, -18), 30_000)!;
    expect(p.gate).not.toBeNull();
    expect(Number.isFinite(p.gate!.noiseFloorDb)).toBe(true);
  });

  it("沒有分析資料回 null（不要編一條假的曲線）", () => {
    expect(loudnessProfile(null)).toBeNull();
    expect(loudnessProfile(undefined)).toBeNull();
    expect(loudnessProfile(analysis([]))).toBeNull();
  });
});

describe("vsEpisode", () => {
  it("比整集大聲是正的、小聲是負的", () => {
    const a = analysis([...Array.from({ length: 300 }, () => -24), ...Array.from({ length: 300 }, () => -12)]);
    const p = loudnessProfile(a, 30_000)!;
    expect(vsEpisode(p, p.buckets[0])!).toBeLessThan(0);
    expect(vsEpisode(p, p.buckets[1])!).toBeGreaterThan(0);
  });

  it("靜音的段落不給差距（沒有意義的數字不要編）", () => {
    const p = loudnessProfile(flat(60, -18), 30_000)!;
    expect(vsEpisode(p, { startMs: 0, endMs: 1000, lufs: SILENCE_LUFS })).toBeNull();
  });
});
