import { describe, expect, it } from "vitest";
import type { LocalAnalysis } from "./peaks";
import { makeNoisePrint, matchLoudnessGainDb, peakNormalizeGainDb, peakUncertaintyDb, percentileDbRange, rangePeak, rmsDbRange, suggestDenoise } from "./levels";

/** 合成一份分析：每個 5 ms 桶給峰值 q（i8）與 RMS dB。 */
function fake(buckets: { q: number; rmsDb: number }[]): LocalAnalysis {
  const n = buckets.length;
  const mins = new Int8Array(n);
  const maxs = new Int8Array(n);
  const rmsU8 = new Uint8Array(n);
  buckets.forEach((b, i) => {
    mins[i] = -b.q;
    maxs[i] = b.q;
    rmsU8[i] = Math.round(((b.rmsDb + 60) / 60) * 255);
  });
  const nWin = Math.ceil(n / 20);
  const win = new Float32Array(nWin * 3);
  for (let w = 0; w < nWin; w++) {
    // 100 ms 視窗：拿桶的 RMS 當 momentary / short-term
    const b = buckets[Math.min(n - 1, w * 20)];
    win[w * 3] = b.rmsDb;
    win[w * 3 + 1] = b.rmsDb;
    win[w * 3 + 2] = b.rmsDb;
  }
  return { version: 3, pps: 200, hopMs: 100, sampleRate: 48000, nBuckets: n, nWin, totalSamples: n * 240, durationMs: n * 5, mins, maxs, rmsU8, win, zx: null };
}

const quiet = (n: number, rmsDb = -50) => Array.from({ length: n }, () => ({ q: 2, rmsDb }));
const loud = (n: number, q = 100, rmsDb = -12) => Array.from({ length: n }, () => ({ q, rmsDb }));

describe("rangePeak / peakUncertaintyDb", () => {
  it("峰值取範圍內 i8 最大絕對值", () => {
    const a = fake([...quiet(100), ...loud(100, 64), ...quiet(100)]);
    expect(rangePeak(a, 500, 1000).q).toBe(64);
    expect(rangePeak(a, 500, 1000).db).toBeCloseTo(20 * Math.log10(64 / 127), 5);
    expect(rangePeak(a, 0, 500).q).toBe(2);
  });
  it("不確定度表：滿刻度小、−30 dBFS 大", () => {
    expect(peakUncertaintyDb(127)).toBeLessThan(0.05);
    expect(peakUncertaintyDb(13)).toBeGreaterThan(0.3);
    expect(peakUncertaintyDb(4)).toBeGreaterThan(1);
    expect(peakUncertaintyDb(0)).toBe(Infinity);
  });
});

describe("peakNormalizeGainDb", () => {
  it("q ≥ 8 是 measured，增益 = 目標 − 峰值", () => {
    const a = fake(loud(200, 64));
    const s = peakNormalizeGainDb(a, 0, 1000, -1)!;
    expect(s.confidence).toBe("measured");
    expect(s.db).toBeCloseTo(-1 - 20 * Math.log10(64 / 127), 3);
  });
  it("太小聲（q < 8）降成 heuristic 並改建議響度對齊", () => {
    const s = peakNormalizeGainDb(fake(loud(200, 4, -40)), 0, 1000, -1)!;
    expect(s.confidence).toBe("heuristic");
    expect(s.summary).toContain("響度對齊");
  });
  it("靜音回 default、增益 0；沒分析回 null", () => {
    expect(peakNormalizeGainDb(fake(Array.from({ length: 50 }, () => ({ q: 0, rmsDb: -60 }))), 0, 250)!.confidence).toBe("default");
    expect(peakNormalizeGainDb(null, 0, 1)).toBeNull();
  });
  it("增益夾在 ±40 dB", () => {
    expect(peakNormalizeGainDb(fake(loud(200, 1, -55)), 0, 1000, 0)!.db).toBeLessThanOrEqual(40);
  });
});

describe("matchLoudnessGainDb", () => {
  it("對齊到整集：這段比整集小 → 正增益", () => {
    // 前半 −12、後半 −24：整集平均在中間，後半要往上補
    const a = fake([...loud(400, 100, -12), ...loud(400, 30, -24)]);
    const s = matchLoudnessGainDb(a, 2000, 4000, "episode")!;
    expect(s.confidence).toBe("measured");
    expect(s.db).toBeGreaterThan(0);
  });
  it("對齊到數字目標", () => {
    const a = fake(loud(400, 100, -20));
    const s = matchLoudnessGainDb(a, 0, 2000, -16)!;
    expect(s.db).toBeCloseTo(4, 0);
  });
});

describe("rmsDbRange / percentileDbRange", () => {
  it("功率平均與百分位", () => {
    const a = fake([...quiet(100, -50), ...loud(100, 100, -10)]);
    expect(rmsDbRange(a, 0, 500)).toBeCloseTo(-50, 0);
    expect(percentileDbRange(a, 0, 1000, 0.05)).toBeCloseTo(-50, 0);
    expect(percentileDbRange(a, 0, 1000, 0.95)).toBeCloseTo(-10, 0);
  });
});

describe("makeNoisePrint", () => {
  it("太短 / 太長 / 有起伏都拒絕，並說原因", () => {
    const a = fake([...quiet(200, -50), ...loud(200), ...quiet(200, -50)]);
    expect("error" in makeNoisePrint(a, 0, 200)).toBe(true);
    expect("error" in makeNoisePrint(a, 0, 6000)).toBe(true);
    const r = makeNoisePrint(a, 500, 1500);
    expect("error" in r && r.error).toContain("講話");
  });
  it("平的一段 → 底噪值", () => {
    const a = fake(quiet(400, -52));
    const r = makeNoisePrint(a, 0, 1000, 123);
    expect("print" in r).toBe(true);
    if ("print" in r) {
      expect(r.print.floorDb).toBeCloseTo(-52, 0);
      expect(r.print.at).toBe(123);
    }
  });
});

describe("suggestDenoise", () => {
  it("有噪音樣本就用它（measured）；夠安靜就不建議，summary 也要說不用降", () => {
    const s = suggestDenoise(null, null, { startMs: 0, endMs: 1000, floorDb: -40, at: 0 });
    expect(s.confidence).toBe("measured");
    expect(s.nrDb).toBeGreaterThan(0);
    expect(s.summary).toBe(`噪音樣本 -40.0 dBFS → 降噪 ${s.nrDb} dB`);
    const quiet = suggestDenoise(null, null, { startMs: 0, endMs: 1000, floorDb: -70, at: 0 });
    expect(quiet.nrDb).toBe(0);
    expect(quiet.summary).toBe("噪音樣本 -70.0 dBFS，已經夠安靜，不建議降噪");
  });
  it("summary 的參數有代進去（t() 的 {floor} / {nr} 不能原樣留著）", () => {
    const a = fake([...quiet(200, -45), ...loud(200)]);
    const s = suggestDenoise(a, { startMs: 0, endMs: 2000 }, null);
    expect(s.summary).not.toContain("{");
    expect(s.summary).toContain(`降噪 ${s.nrDb} dB`);
    const peak = peakNormalizeGainDb(fake(loud(200, 64)), 0, 1000, -1)!;
    expect(peak.summary).not.toContain("{");
    expect(peak.summary).toMatch(/^峰值 -\d+\.\d dBFS → -1 dBFS，增益 \+\d+\.\d dB（±\d\.\d\d）$/);
    const lu = matchLoudnessGainDb(fake(loud(400, 100, -20)), 0, 2000, -16)!;
    expect(lu.summary).toMatch(/^這段 -\d+\.\d LUFS → -16 LUFS，增益 \+\d+\.\d dB$/);
  });
  it("沒樣本用範圍 5% 百分位（heuristic）；沒分析用一般值（default）", () => {
    const a = fake([...quiet(200, -45), ...loud(200)]);
    expect(suggestDenoise(a, { startMs: 0, endMs: 2000 }, null).confidence).toBe("heuristic");
    expect(suggestDenoise(null, null, null).confidence).toBe("default");
  });
});
