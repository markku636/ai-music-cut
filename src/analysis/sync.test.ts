import { describe, expect, it } from "vitest";
import type { LocalAnalysis } from "./peaks";
import { bestWindowStart, correlate, delaysFromOffsets, DEFAULT_SYNC, envelopeAt, estimateOffset } from "./sync";

/** 造一份假的本機分析：rms 用 0–255，pps = 每秒幾個桶。 */
function fakeAnalysis(rms: number[], pps = 200): LocalAnalysis {
  return {
    version: 3,
    pps,
    hopMs: 100,
    sampleRate: 48000,
    nBuckets: rms.length,
    nWin: 0,
    totalSamples: 0,
    durationMs: (rms.length / pps) * 1000,
    mins: new Int8Array(rms.length),
    maxs: new Int8Array(rms.length),
    rmsU8: Uint8Array.from(rms),
    win: new Float32Array(0),
    zx: null,
  };
}

/** 一段「講話」的能量樣式：隨機但可重現。 */
function speechPattern(n: number, seed = 7): number[] {
  let x = seed;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    // 一半時間在講話（高能量），一半安靜
    out.push((x >> 16) % 100 < 55 ? 170 + ((x >> 8) % 60) : 10);
  }
  return out;
}

describe("envelopeAt", () => {
  it("降到指定取樣率", () => {
    const a = fakeAnalysis(new Array(400).fill(200), 200);
    const env = envelopeAt(a, 20, -50);
    expect(env.length).toBe(40); // 400 桶 ÷ 200 pps = 2 秒；2 秒 × 20 Hz = 40 格
  });

  it("靜音夾成 0", () => {
    const a = fakeAnalysis(new Array(200).fill(0), 200);
    expect([...envelopeAt(a, 20, -50)].every((v) => v === 0)).toBe(true);
  });
});

describe("bestWindowStart", () => {
  it("挑能量最集中的地方，不會停在安靜段", () => {
    const env = new Float32Array([0, 0, 0, 0, 1, 1, 1, 1, 0, 0]);
    expect(bestWindowStart(env, 4)).toBe(4);
  });

  it("視窗比訊號長時回 0", () => {
    expect(bestWindowStart(new Float32Array([1, 1]), 10)).toBe(0);
  });
});

describe("correlate", () => {
  it("找得出人工造出來的位移", () => {
    const base = speechPattern(600).map((v) => v / 255);
    const a = new Float32Array(base);
    // b 比 a 晚 25 格開始（前面補靜音）
    const b = new Float32Array([...new Array(25).fill(0), ...base]);
    const r = correlate(a, b, 60, 200);
    expect(r.lag).toBe(25);
    expect(r.confidence).toBeGreaterThan(0.3);
  });

  it("完全無關的兩段不會給高信心", () => {
    const a = new Float32Array(speechPattern(600, 1).map((v) => v / 255));
    const b = new Float32Array(speechPattern(600, 99).map((v) => v / 255));
    const r = correlate(a, b, 60, 200);
    expect(r.confidence).toBeLessThan(0.5);
  });

  it("訊號太短就放棄（不要硬給一個位移）", () => {
    const r = correlate(new Float32Array([1, 0]), new Float32Array([0, 1]), 5, 2);
    expect(r.confidence).toBe(0);
  });
});

describe("estimateOffset", () => {
  it("兩份分析算得出毫秒位移", () => {
    const pat = speechPattern(4000);
    const a = fakeAnalysis(pat, 200);
    // b 晚 1 秒（200 個桶 @200pps）
    const b = fakeAnalysis([...new Array(200).fill(0), ...pat], 200);
    const r = estimateOffset(a, b, { ...DEFAULT_SYNC, maxLagSec: 5, windowSec: 5 });
    // b 比 a 晚開始 1 秒 → b 要往前移 1 秒才對齊 → offset 為 −1000
    expect(Math.abs(r.offsetMs - -1000)).toBeLessThanOrEqual(50);
    expect(r.confidence).toBeGreaterThan(0.2);
  });
});

describe("delaysFromOffsets", () => {
  it("平移成「最早那一軌 = 0」（adelay 只能往後推）", () => {
    expect(delaysFromOffsets([0, -1500, 500])).toEqual([1500, 0, 2000]);
  });

  it("已經對齊就全是 0", () => {
    expect(delaysFromOffsets([0, 0])).toEqual([0, 0]);
  });

  it("空陣列不會爆", () => {
    expect(delaysFromOffsets([])).toEqual([]);
  });
});
