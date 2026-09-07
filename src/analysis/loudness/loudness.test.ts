import { describe, expect, it } from "vitest";
import type { KeepSegment } from "../edl/build";
import { integratedFromBlocks, integratedLufs } from "./gating";
import { planGains, type MeasuredUnit } from "./plan";
import { splitUnits } from "./units";

describe("gating", () => {
  it("ignores silence below the absolute gate and quiet tails below the relative gate", () => {
    expect(integratedFromBlocks([-100, -100])).toBeNull();
    expect(integratedFromBlocks([-20, -20, -20])).toBeCloseTo(-20, 5);
    // 大量 -20 與少量 -40（低於相對閘 -30）→ 結果 ≈ -20
    const v = integratedFromBlocks([-20, -20, -20, -20, -40, -40]);
    expect(v).toBeCloseTo(-20, 1);
  });
  it("integratedLufs slices windows by time", () => {
    const w = Array.from({ length: 30 }, (_, i) => ({ tMs: i * 100, momentary: i < 10 ? -30 : -18, shortTerm: -20, rmsDb: -20 }));
    expect(integratedLufs(w, 100, 0, 1000)).toBeCloseTo(-30, 3);
    expect(integratedLufs(w, 100, 1000, 3000)).toBeCloseTo(-18, 3);
    expect(integratedLufs(w, 100, 5000, 6000)).toBeNull();
  });
});

describe("units", () => {
  const keep = (id: number, s: number, e: number): KeepSegment => ({ id, srcStartMs: s, srcEndMs: e, outStartMs: 0, outEndMs: 0, gainDb: 0 });
  it("splits long keeps at silences without crossing keep boundaries", () => {
    const keeps = [keep(0, 0, 40_000), keep(1, 50_000, 52_000)];
    const vad = [{ startMs: 0, endMs: 14_000 }, { startMs: 14_400, endMs: 27_000 }, { startMs: 27_300, endMs: 40_000 }, { startMs: 50_000, endMs: 52_000 }];
    const u = splitUnits(keeps, vad, 15_000);
    expect(u.map((x) => [x.keepId, x.startMs, x.endMs])).toEqual([
      [0, 0, 14_200],
      [0, 14_200, 27_150],
      [0, 27_150, 40_000],
      [1, 50_000, 52_000],
    ]);
  });
  it("hard-splits when there is no silence", () => {
    const u = splitUnits([keep(0, 0, 32_000)], [{ startMs: 0, endMs: 32_000 }], 15_000);
    expect(u.map((x) => x.endMs)).toEqual([15_000, 30_000, 32_000]);
  });
});

describe("planGains", () => {
  const mk = (id: number, keepId: number, lufs: number | null, peakDb = -10): MeasuredUnit => ({ id, keepId, startMs: id * 1000, endMs: id * 1000 + 1000, lufs, peakDb });
  it("pulls units toward target with clamp, peak guard, smoothing and step limit", () => {
    const g = planGains([mk(0, 0, -16), mk(1, 0, -30), mk(2, 0, -16), mk(3, 1, null), mk(4, 1, -10, -1)]);
    expect(g[0].gainDb).toBeCloseTo(0.25 * 8, 1); // 鄰居 +12 被峰值守門壓到 +8，平滑進來 1/4
    expect(g[1].gainDb).toBeLessThanOrEqual(g[0].gainDb + 3); // 階差 ≤ 3
    expect(g[3].gainDb).toBeGreaterThanOrEqual(-3); // 靜音 0，受階差牽制
    expect(g[4].gainDb).toBeLessThanOrEqual(-2 - -1); // 峰值 -1 dB → 最多 -1 dB
  });
  it("never exceeds the peak ceiling", () => {
    const g = planGains([mk(0, 0, -40, -3)]);
    expect(g[0].gainDb).toBeLessThanOrEqual(1);
  });
});

describe("planGains：換人的地方不平滑也不限階差", () => {
  const mk = (id: number, keepId: number, lufs: number | null, peakDb = -10): MeasuredUnit => ({ id, keepId, startMs: id * 1000, endMs: id * 1000 + 1000, lufs, peakDb });
  // 同一個保留段內：前兩個單元是主持人 −16、後兩個是來賓 −24
  const units = [mk(0, 0, -16), mk(1, 0, -16), mk(2, 0, -24), mk(3, 0, -24)];
  const byId: Record<number, string> = { 0: "h", 1: "h", 2: "g", 3: "g" };
  const spk = (id: number) => byId[id] ?? null;

  it("知道換人時，來賓第一個單元一次補到位（不受 3 dB 階差限制）", () => {
    const g = planGains(units, undefined, spk);
    // 目標 −16：來賓要 +8 dB，但峰值 −10 → 最多 +8（-2 - -10）
    expect(g[2].gainDb).toBeCloseTo(8, 1);
  });

  it("不知道換人時要爬好幾格才到位（這就是要修的問題）", () => {
    const g = planGains(units);
    expect(g[2].gainDb).toBeLessThan(8);
    expect(g[2].gainDb).toBeLessThanOrEqual(g[1].gainDb + 3);
  });

  it("平滑不會把前一個人的增益混進來", () => {
    // 沒有講者時，來賓第一格會被主持人的 0 dB 拉低 25%
    expect(planGains(units)[2].gainDb).toBeLessThan(planGains(units, undefined, spk)[2].gainDb);
  });

  it("同一個人之內仍然平滑、仍然限階差", () => {
    const solo = [mk(0, 0, -16), mk(1, 0, -40), mk(2, 0, -16)];
    const same = (id: number) => (id >= 0 ? "h" : null);
    const g = planGains(solo, undefined, same);
    expect(g[1].gainDb).toBeLessThanOrEqual(g[0].gainDb + 3);
    expect(g[0].gainDb).toBeGreaterThan(0); // 鄰居的增益平滑進來了
  });

  it("判不出講者的單元當成延續，不製造音量跳點", () => {
    const unknown = (id: number) => (id === 2 ? null : byId[id] ?? null);
    expect(planGains(units, undefined, unknown)[2].gainDb).toBeLessThanOrEqual(planGains(units)[1].gainDb + 3);
  });

  it("沒給 speakerOf 時行為跟以前完全一樣", () => {
    expect(planGains(units, undefined, undefined)).toEqual(planGains(units));
  });

  it("跨保留段仍然斷開（原本就有的行為）", () => {
    const across = [mk(0, 0, -16), mk(1, 1, -24)];
    const oneVoice = () => "h";
    expect(planGains(across, undefined, oneVoice)[1].gainDb).toBeCloseTo(8, 1);
  });
});
