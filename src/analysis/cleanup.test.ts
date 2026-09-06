import { describe, expect, it } from "vitest";
import { CLEANUP_OFF, describeCleanup, estimateCleanup, isCleanupActive, normalizeCleanup, RUMBLE_HZ } from "./cleanup";
import type { LocalAnalysis } from "./peaks";


/** rmsU8ToDb 的反函式：dB → 0..255 桶值。 */
const dbToRmsU8 = (db: number) => Math.max(0, Math.min(255, Math.round(((db + 60) / 60) * 255)));

/** rms 桶用 dB 給，直接對應「這段有多大聲」。 */
function fake(dbs: number[]): LocalAnalysis {
  return {
    version: 3,
    pps: 200,
    hopMs: 100,
    sampleRate: 48000,
    nBuckets: dbs.length,
    nWin: 0,
    totalSamples: 0,
    durationMs: (dbs.length / 200) * 1000,
    mins: new Int8Array(dbs.length),
    maxs: new Int8Array(dbs.length),
    rmsU8: Uint8Array.from(dbs.map((d) => dbToRmsU8(d))),
    win: new Float32Array(0),
    zx: null,
  };
}

/** 一半安靜、一半在講話。 */
function recording(floorDb: number, speechDb: number): LocalAnalysis {
  return fake([...Array(50).fill(floorDb), ...Array(50).fill(speechDb)]);
}

describe("estimateCleanup", () => {
  it("吵的錄音：建議降噪，量越吵減越多", () => {
    const noisy = estimateCleanup(recording(-40, -18));
    const lessNoisy = estimateCleanup(recording(-50, -18));
    expect(noisy.worthDenoise).toBe(true);
    expect(lessNoisy.worthDenoise).toBe(true);
    expect(noisy.suggested.denoiseDb).toBeGreaterThan(lessNoisy.suggested.denoiseDb);
  });

  it("已經夠安靜就不建議降噪 —— 再減只會傷到尾音", () => {
    const clean = estimateCleanup(recording(-70, -18));
    expect(clean.worthDenoise).toBe(false);
    expect(clean.suggested.denoiseDb).toBe(0);
    expect(clean.summary).toContain("夠安靜");
  });

  it("降噪量有上限，再吵也不會超過 18 dB（過量會出現水聲）", () => {
    const awful = estimateCleanup(recording(-22, -16));
    expect(awful.suggested.denoiseDb).toBeLessThanOrEqual(18);
  });

  it("高通一律建議開著 —— 人聲基頻在 80 Hz 之上，這一刀幾乎零成本", () => {
    expect(estimateCleanup(recording(-70, -18)).suggested.rumbleHz).toBe(RUMBLE_HZ);
    expect(estimateCleanup(recording(-35, -18)).suggested.rumbleHz).toBe(RUMBLE_HZ);
  });

  it("齒音預設不開 —— 這份分析只有能量包絡、量不到頻譜，沒有依據就別動", () => {
    expect(estimateCleanup(recording(-35, -18)).suggested.deessAmount).toBe(0);
  });

  it("nf 夾在 afftdn 接受的 −80..−20 之間", () => {
    expect(estimateCleanup(recording(-95, -18)).suggested.noiseFloorDb).toBeGreaterThanOrEqual(-80);
    expect(estimateCleanup(recording(-10, -5)).suggested.noiseFloorDb).toBeLessThanOrEqual(-20);
  });

  it("沒有分析資料時不會炸，也不會亂建議", () => {
    const none = estimateCleanup(null);
    expect(none.worthDenoise).toBe(false);
    expect(isCleanupActive(none.suggested)).toBe(false);
  });

  it("marginDb 就是語音與底噪的差", () => {
    const e = estimateCleanup(recording(-50, -20));
    expect(e.marginDb).toBeCloseTo(e.speechDb - e.floorDb, 5);
    expect(e.marginDb).toBeGreaterThan(20);
  });
});

describe("isCleanupActive / describeCleanup", () => {
  it("三項都關就是不修聲", () => {
    expect(isCleanupActive(CLEANUP_OFF)).toBe(false);
    expect(isCleanupActive(null)).toBe(false);
    expect(describeCleanup(CLEANUP_OFF)).toBe("不修聲");
  });

  it("只要有一項開著就算有修聲", () => {
    expect(isCleanupActive({ ...CLEANUP_OFF, rumbleHz: 80 })).toBe(true);
    expect(isCleanupActive({ ...CLEANUP_OFF, denoiseDb: 6 })).toBe(true);
    expect(isCleanupActive({ ...CLEANUP_OFF, deessAmount: 0.2 })).toBe(true);
  });

  it("描述只列出真的有開的項目", () => {
    const d = describeCleanup({ rumbleHz: 80, denoiseDb: 12, noiseFloorDb: -48, deessAmount: 0 });
    expect(d).toContain("80 Hz");
    expect(d).toContain("12 dB");
    expect(d).not.toContain("齒音");
  });
});

describe("normalizeCleanup", () => {
  it("夾到 Rust 端接受的範圍", () => {
    const n = normalizeCleanup({ rumbleHz: 9999, denoiseDb: 999, noiseFloorDb: -999, deessAmount: 99 });
    expect(n.rumbleHz).toBe(200);
    expect(n.denoiseDb).toBe(30);
    expect(n.noiseFloorDb).toBe(-80);
    expect(n.deessAmount).toBe(1);
  });

  it("0 就是關掉，不會被夾成最小值", () => {
    const n = normalizeCleanup({ rumbleHz: 0, denoiseDb: 0, deessAmount: 0 });
    expect(n.rumbleHz).toBe(0);
    expect(n.denoiseDb).toBe(0);
    expect(n.deessAmount).toBe(0);
    expect(isCleanupActive(n)).toBe(false);
  });

  it("缺欄位時給安全的預設", () => {
    expect(normalizeCleanup(null).noiseFloorDb).toBe(-60);
    expect(isCleanupActive(normalizeCleanup({}))).toBe(false);
  });
});
