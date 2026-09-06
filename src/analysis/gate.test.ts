import { describe, expect, it } from "vitest";
import { DEFAULT_GATE, dbToAmp, estimateGate, gateSpec, percentileDb, worthGating } from "./gate";
import type { LocalAnalysis } from "./peaks";
import { rmsU8ToDb } from "./peaks";

function fake(rms: number[]): LocalAnalysis {
  return {
    version: 3,
    pps: 200,
    hopMs: 100,
    sampleRate: 48000,
    nBuckets: rms.length,
    nWin: 0,
    totalSamples: 0,
    durationMs: (rms.length / 200) * 1000,
    mins: new Int8Array(rms.length),
    maxs: new Int8Array(rms.length),
    rmsU8: Uint8Array.from(rms),
    win: new Float32Array(0),
    zx: null,
  };
}

describe("percentileDb", () => {
  it("取得對應百分位的 dB", () => {
    const a = fake([...new Array(50).fill(10), ...new Array(50).fill(200)]);
    expect(percentileDb(a, 0.1)).toBeCloseTo(rmsU8ToDb(10), 6);
    expect(percentileDb(a, 0.9)).toBeCloseTo(rmsU8ToDb(200), 6);
  });

  it("空的分析不會爆", () => {
    expect(percentileDb(fake([]), 0.5)).toBe(-60);
  });
});

describe("estimateGate", () => {
  // 六成時間是串音（安靜）、四成是自己在講話
  const track = fake([...new Array(600).fill(30), ...new Array(400).fill(210)]);

  it("量出底噪與人聲，門檻落在兩者之間", () => {
    const g = estimateGate(track);
    expect(g.noiseFloorDb).toBeLessThan(g.thresholdDb);
    expect(g.thresholdDb).toBeLessThan(g.speechDb);
  });

  it("門檻偏保守（比較靠近底噪那一側）", () => {
    const g = estimateGate(track);
    const half = g.noiseFloorDb + g.marginDb / 2;
    expect(g.thresholdDb).toBeLessThan(half);
  });

  it("人聲與底噪差得夠多才值得處理", () => {
    expect(worthGating(estimateGate(track))).toBe(true);
  });

  it("整軌都一樣大聲（沒有安靜段）就不該亂切", () => {
    const flat = fake(new Array(1000).fill(180));
    const g = estimateGate(flat);
    expect(g.marginDb).toBeLessThan(DEFAULT_GATE.minMarginDb);
    expect(worthGating(g)).toBe(false);
  });
});

describe("gateSpec", () => {
  const g = { noiseFloorDb: -48, speechDb: -12, thresholdDb: -36, marginDb: 36 };

  it("dB 換成 ffmpeg 用的線性值", () => {
    expect(dbToAmp(0)).toBe(1);
    expect(dbToAmp(-6)).toBeCloseTo(0.501, 3);
    expect(dbToAmp(-96)).toBeCloseTo(0, 4);
  });

  it("不會提供「完全靜音」—— 那會讓換人講話時出現空間感落差", () => {
    expect(gateSpec(g, -200).range).toBeGreaterThan(0);
    // 就算要求 -1 dB 也至少壓 3 dB，否則等於沒作用
    expect(gateSpec(g, -1).range).toBeCloseTo(dbToAmp(-3), 6);
  });

  it("門檻直接來自量測結果", () => {
    expect(gateSpec(g, -12).threshold).toBeCloseTo(dbToAmp(-36), 6);
  });
});
