import { describe, expect, it } from "vitest";
import { applyOverride, detectBeats, foldBpm, isDownbeat, snapToBeat, tapTempo } from "./beats";
import type { LocalAnalysis } from "./peaks";

/** 造一個 pps=200（5 ms 桶）的假分析：每 beatMs 打一下鼓（RMS 突起）。 */
function pulseAnalysis(bpm: number, seconds = 30): LocalAnalysis {
  const pps = 200;
  const n = seconds * pps;
  const rmsU8 = new Uint8Array(n);
  const beatMs = 60000 / bpm;
  for (let i = 0; i < n; i++) {
    const ms = (i / pps) * 1000;
    const phase = ms % beatMs;
    // 20 ms 的擊點：安靜 → 大聲 → 衰減
    rmsU8[i] = phase < 20 ? 235 : phase < 90 ? 190 : 120;
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
    mins: new Int8Array(n),
    maxs: new Int8Array(n),
    rmsU8,
    win: new Float32Array(0),
  };
}

describe("beats", () => {
  it("120 BPM 脈衝 → 抓到 120 BPM、拍點間隔 500 ms", () => {
    const g = detectBeats(pulseAnalysis(120));
    expect(g.bpm).toBeCloseTo(120, 0);
    expect(g.periodMs).toBeCloseTo(500, 0);
    expect(g.confidence).toBeGreaterThan(0.3);
    expect(g.beats.length).toBeGreaterThan(50);
    expect(g.beats[1] - g.beats[0]).toBeCloseTo(500, 0);
  });

  it("90 BPM 也抓得到", () => {
    const g = detectBeats(pulseAnalysis(90));
    expect(g.bpm).toBeGreaterThan(88);
    expect(g.bpm).toBeLessThan(92);
  });

  it("純靜音 → 信心低（UI 不該顯示網格）", () => {
    const n = 6000;
    const flat: LocalAnalysis = {
      version: 2,
      pps: 200,
      hopMs: 100,
      sampleRate: 48000,
      nBuckets: n,
      nWin: 0,
      totalSamples: 48000 * 30,
      durationMs: 30000,
      mins: new Int8Array(n),
      maxs: new Int8Array(n),
      rmsU8: new Uint8Array(n).fill(10),
      win: new Float32Array(0),
    };
    expect(detectBeats(flat).confidence).toBeLessThan(0.12);
  });

  it("foldBpm 把半拍 / 倍拍折回常用範圍", () => {
    expect(foldBpm(240)).toBe(120);
    expect(foldBpm(40)).toBe(80);
    expect(foldBpm(128)).toBe(128);
  });

  it("snapToBeat：容差內吸附、容差外不動、信心不足不吸", () => {
    const grid = { bpm: 120, periodMs: 500, offsetMs: 0, confidence: 0.5, beatsPerBar: 4, beats: [] };
    expect(snapToBeat(grid, 1040)).toBe(1000);
    expect(snapToBeat(grid, 1250)).toBe(1250);
    expect(snapToBeat({ ...grid, confidence: 0.05 }, 1040)).toBe(1040);
    expect(snapToBeat(null, 1040)).toBe(1040);
  });

  it("isDownbeat：4/4 每 4 拍一次", () => {
    const grid = { bpm: 120, periodMs: 500, offsetMs: 0, confidence: 0.5, beatsPerBar: 4, beats: [] };
    expect(isDownbeat(grid, 0)).toBe(true);
    expect(isDownbeat(grid, 500)).toBe(false);
    expect(isDownbeat(grid, 2000)).toBe(true);
  });
});

describe("grid override", () => {
  const raw = { bpm: 60, periodMs: 1000, offsetMs: 100, confidence: 0.5, beatsPerBar: 4, beats: [100, 1100, 2100] };
  it("applyOverride ×2 → 週期減半、BPM 加倍", () => {
    const g = applyOverride(raw, { bpmScale: 2, offsetDeltaMs: 0 }, 4000)!;
    expect(g.periodMs).toBe(500);
    expect(g.bpm).toBe(120);
    expect(g.beats.length).toBeGreaterThan(raw.beats.length);
  });
  it("applyOverride 相位平移", () => {
    const g = applyOverride(raw, { bpmScale: 1, offsetDeltaMs: 250 }, 4000)!;
    expect(g.offsetMs).toBe(350);
  });
  it("不改就回原物件", () => {
    expect(applyOverride(raw, { bpmScale: 1, offsetDeltaMs: 0 })).toBe(raw);
  });
  it("tapTempo：500 ms 間隔 → 120 BPM；太少下數回 null", () => {
    expect(tapTempo([0, 500, 1000, 1500])).toBeCloseTo(120, 0);
    expect(tapTempo([0, 500])).toBeNull();
  });
  it("tapTempo 丟掉離群值", () => {
    expect(tapTempo([0, 500, 1000, 3000, 3500, 4000])).toBeCloseTo(120, 0);
  });
});
