import { describe, expect, it } from "vitest";
import { hasZeroCross, nearestZeroCrossMs, parseAnalysis, type LocalAnalysis } from "./peaks";

const PPS = 200;
const SR = 48_000;
const SAMPLES_PER_BUCKET = SR / PPS; // 240

/** 造一份 v3 的 analysis.bin（可指定每個桶的零交越位移與 RMS）。 */
function packV3(zx: number[], rmsU8: number[], version = 3): ArrayBuffer {
  const nB = zx.length;
  const nW = 1;
  const perBucket = version >= 3 ? 4 : 3;
  const buf = new ArrayBuffer(36 + nB * perBucket + nW * 12);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  u8.set([0x41, 0x49, 0x50, 0x4b], 0); // "AIPK"
  dv.setUint32(4, version, true);
  dv.setUint32(8, PPS, true);
  dv.setUint32(12, 100, true);
  dv.setUint32(16, SR, true);
  dv.setUint32(20, nB, true);
  dv.setUint32(24, nW, true);
  dv.setBigUint64(28, BigInt(nB * SAMPLES_PER_BUCKET), true);
  let off = 36;
  off += nB; // mins
  off += nB; // maxs
  u8.set(rmsU8, off);
  off += nB;
  if (version >= 3) {
    u8.set(zx, off);
    off += nB;
  }
  return buf;
}

/** RMS u8：0..255 ↔ −60..0 dBFS。 */
const dbToU8 = (db: number) => Math.round(((db + 60) / 60) * 255);

describe("parseAnalysis 版本相容", () => {
  it("v3 讀得到零交越", () => {
    const a = parseAnalysis(packV3([10, 20, 30], [0, 0, 0]));
    expect(a.version).toBe(3);
    expect(hasZeroCross(a)).toBe(true);
    expect([...(a.zx as Uint8Array)]).toEqual([10, 20, 30]);
  });

  it("v2 的舊檔照樣讀得動，只是沒有零交越（舊專案不必強迫重新分析）", () => {
    const a = parseAnalysis(packV3([], [0, 0, 0], 2));
    expect(a.version).toBe(2);
    expect(hasZeroCross(a)).toBe(false);
    expect(a.nBuckets).toBe(0);
  });

  it("長度不足會丟明確的錯（而不是靜靜地讀到錯位的資料）", () => {
    const buf = packV3([1, 2, 3], [0, 0, 0]);
    expect(() => parseAnalysis(buf.slice(0, buf.byteLength - 1))).toThrow(/長度不足/);
  });
});

describe("nearestZeroCrossMs", () => {
  const quiet = dbToU8(-60);
  const loud = dbToU8(-10);
  const atMs = (bucket: number, off: number) => ((bucket * SAMPLES_PER_BUCKET + off) / SR) * 1000;

  it("找到窗內最近的上升零交越", () => {
    // 桶 2 的第 120 個 sample 有零交越 → 2*5 + 2.5 = 12.5ms
    const a = parseAnalysis(packV3([255, 255, 120, 255, 255], [quiet, quiet, quiet, quiet, quiet]));
    expect(nearestZeroCrossMs(a, 12, 5)).toBeCloseTo(atMs(2, 120), 6);
    expect(atMs(2, 120)).toBeCloseTo(12.5, 6);
  });

  it("窗外的不算（不能為了對零點把剪點挪很遠）", () => {
    const a = parseAnalysis(packV3([0, 255, 255, 255, 255], [quiet, quiet, quiet, quiet, quiet]));
    // 桶 0 的零交越在 0ms，離 12ms 有 12ms > 窗 3ms
    expect(nearestZeroCrossMs(a, 12, 3)).toBe(12);
  });

  it("太吵的桶不用 —— 語音正中間的零交越一樣切在字中間", () => {
    const a = parseAnalysis(packV3([255, 255, 120, 255, 255], [loud, loud, loud, loud, loud]));
    expect(nearestZeroCrossMs(a, 12, 5)).toBe(12);
  });

  it("255 表示這個桶裡沒有零交越", () => {
    const a = parseAnalysis(packV3([255, 255, 255], [quiet, quiet, quiet]));
    expect(nearestZeroCrossMs(a, 5, 5)).toBe(5);
  });

  it("v2 沒有這段資料就原值回傳（不會爆）", () => {
    const a = parseAnalysis(packV3([], [quiet], 2));
    expect(nearestZeroCrossMs(a, 123, 5)).toBe(123);
  });

  it("兩邊都有時取比較近的那個", () => {
    // 桶 1 的 0（= 5ms）與桶 3 的 0（= 15ms），目標 13ms → 應取 15ms
    const a = parseAnalysis(packV3([255, 0, 255, 0, 255], [quiet, quiet, quiet, quiet, quiet]));
    expect(nearestZeroCrossMs(a, 13, 5)).toBeCloseTo(15, 6);
  });

  it("超出範圍不會讀到界外", () => {
    const a = parseAnalysis(packV3([0, 0], [quiet, quiet]));
    expect(() => nearestZeroCrossMs(a, -100, 5)).not.toThrow();
    expect(() => nearestZeroCrossMs(a, 99_999, 5)).not.toThrow();
  });

  it("5 ms 桶解析不出來的東西，樣本層級可以 —— 這正是 v3 的理由", () => {
    // 100 Hz 基頻週期 10 ms；桶只有 5 ms，桶中心永遠不會剛好是零點
    const a = parseAnalysis(packV3([255, 37, 255], [quiet, quiet, quiet]));
    const got = nearestZeroCrossMs(a, 5.5, 3);
    expect(got).toBeCloseTo(atMs(1, 37), 6);
    // 不是桶中心（7.5ms），而是樣本位置
    expect(Math.abs(got - 7.5)).toBeGreaterThan(0.5);
  });
});

describe("LocalAnalysis 型別", () => {
  it("zx 是 null 或 Uint8Array，不會是 undefined", () => {
    const a: LocalAnalysis = parseAnalysis(packV3([1], [0]));
    expect(a.zx).toBeInstanceOf(Uint8Array);
    const b: LocalAnalysis = parseAnalysis(packV3([], [0], 2));
    expect(b.zx).toBeNull();
  });
});
