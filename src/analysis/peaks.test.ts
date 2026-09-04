import { describe, expect, it } from "vitest";
import { minEnergyPointMs, parseAnalysis, rmsDbAt, wavesurferPeaks } from "./peaks";

/** 依 media.rs Analyzer::finish 的 layout 手工打包一份假資料。 */
function pack(opts: { pps: number; hopMs: number; sr: number; mins: number[]; maxs: number[]; rms: number[]; win: number[]; total: number }) {
  const nB = opts.mins.length;
  const nW = opts.win.length / 3;
  const buf = new ArrayBuffer(36 + nB * 3 + nW * 12);
  const dv = new DataView(buf);
  new Uint8Array(buf, 0, 4).set([0x41, 0x49, 0x50, 0x4b]);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, opts.pps, true);
  dv.setUint32(12, opts.hopMs, true);
  dv.setUint32(16, opts.sr, true);
  dv.setUint32(20, nB, true);
  dv.setUint32(24, nW, true);
  dv.setBigUint64(28, BigInt(opts.total), true);
  let off = 36;
  new Int8Array(buf, off, nB).set(opts.mins);
  off += nB;
  new Int8Array(buf, off, nB).set(opts.maxs);
  off += nB;
  new Uint8Array(buf, off, nB).set(opts.rms);
  off += nB;
  opts.win.forEach((v, i) => dv.setFloat32(off + i * 4, v, true));
  return buf;
}

describe("peaks", () => {
  const a = parseAnalysis(
    pack({ pps: 200, hopMs: 100, sr: 48000, mins: [-100, -10, -50, -2], maxs: [100, 10, 50, 2], rms: [255, 128, 200, 0], win: [-16, -17, -18, -30, -31, -32], total: 960 }),
  );

  it("parses header and arrays", () => {
    expect(a.pps).toBe(200);
    expect(a.nBuckets).toBe(4);
    expect(a.nWin).toBe(2);
    expect(a.durationMs).toBe(20);
    expect(Array.from(a.maxs)).toEqual([100, 10, 50, 2]);
    expect(a.win[3]).toBeCloseTo(-30);
  });

  it("rms lookup and min-energy point", () => {
    expect(rmsDbAt(a, 0)).toBeCloseTo(0);
    expect(rmsDbAt(a, 5)).toBeCloseTo(-30, 0);
    expect(rmsDbAt(a, 999)).toBe(-120);
    // 桶 3（15–20 ms）rms=0 最安靜 → 中點 17.5 ms
    expect(minEnergyPointMs(a, 0, 19)).toBeCloseTo(17.5);
  });

  it("wavesurfer peaks are normalized and signed", () => {
    const [top, bottom] = wavesurferPeaks(a);
    expect(top[0]).toBeCloseTo(100 / 127);
    expect(bottom[0]).toBeCloseTo(-100 / 127);
  });

  it("rejects garbage", () => {
    expect(() => parseAnalysis(new ArrayBuffer(8))).toThrow();
  });
});
