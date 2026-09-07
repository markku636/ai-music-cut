import { describe, expect, it } from "vitest";
import { DEFAULT_QC, findClipping, findDcOffset, findDeadAir, findLevelJumps, scanAudio, summarizeQc, type QcOptions } from "./audioQc";
import type { LocalAnalysis } from "./peaks";

const PPS = 200; // 5 ms 一個桶
const HOP = 100; // 100 ms 一個響度視窗

/** dBFS → rmsU8（peaks.ts 的 rmsU8ToDb 反過來）。 */
function dbToU8(db: number): number {
  return Math.max(0, Math.min(255, Math.round(((db + 60) / 60) * 255)));
}

function mk(opts: {
  durationMs: number;
  /** 每個桶的 [min, max]；沒給就是安靜的小訊號。 */
  peak?: (i: number, ms: number) => [number, number];
  /** 每個桶的 RMS dBFS。 */
  rms?: (i: number, ms: number) => number;
  /** 每個視窗的短期 LUFS。 */
  shortTerm?: (w: number, ms: number) => number;
}): LocalAnalysis {
  const nBuckets = Math.round((opts.durationMs / 1000) * PPS);
  const nWin = Math.round(opts.durationMs / HOP);
  const mins = new Int8Array(nBuckets);
  const maxs = new Int8Array(nBuckets);
  const rmsU8 = new Uint8Array(nBuckets);
  for (let i = 0; i < nBuckets; i++) {
    const ms = (i * 1000) / PPS;
    const [lo, hi] = opts.peak ? opts.peak(i, ms) : [-40, 40];
    mins[i] = lo;
    maxs[i] = hi;
    rmsU8[i] = dbToU8(opts.rms ? opts.rms(i, ms) : -20);
  }
  const win = new Float32Array(nWin * 3);
  for (let w = 0; w < nWin; w++) {
    const st = opts.shortTerm ? opts.shortTerm(w, w * HOP) : -20;
    win[w * 3] = st;
    win[w * 3 + 1] = st;
    win[w * 3 + 2] = st;
  }
  return {
    version: 3, pps: PPS, hopMs: HOP, sampleRate: 48000,
    nBuckets, nWin, totalSamples: Math.round((opts.durationMs / 1000) * 48000),
    durationMs: opts.durationMs, mins, maxs, rmsU8, win, zx: null,
  };
}

describe("findClipping", () => {
  it("乾淨的錄音沒有東西可報", () => {
    expect(findClipping(mk({ durationMs: 5000 }), null)).toHaveLength(0);
  });

  it("連續打到滿刻度會被抓出來，並回報持續多久", () => {
    const a = mk({ durationMs: 5000, peak: (_i, ms) => (ms >= 1000 && ms < 1100 ? [-127, 127] : [-40, 40]) });
    const [f] = findClipping(a, null);
    expect(f.kind).toBe("clipping");
    expect(f.startMs).toBe(1000);
    expect(f.value).toBe(100);
  });

  it("只有一兩個桶打頂不報（那太常見，報了只是雜訊）", () => {
    const a = mk({ durationMs: 5000, peak: (_i, ms) => (ms === 1000 ? [-127, 127] : [-40, 40]) });
    expect(findClipping(a, null)).toHaveLength(0);
  });

  it("負半邊打頂也算", () => {
    const a = mk({ durationMs: 3000, peak: (_i, ms) => (ms >= 500 && ms < 600 ? [-127, 40] : [-40, 40]) });
    expect(findClipping(a, null)).toHaveLength(1);
  });

  it("被剪掉的段落不報（成品裡根本不存在）", () => {
    const a = mk({ durationMs: 5000, peak: (_i, ms) => (ms >= 1000 && ms < 1200 ? [-127, 127] : [-40, 40]) });
    expect(findClipping(a, null)).toHaveLength(1);
    expect(findClipping(a, [{ startMs: 2000, endMs: 5000 }])).toHaveLength(0);
    expect(findClipping(a, [{ startMs: 0, endMs: 5000 }])).toHaveLength(1);
  });

  it("只留最嚴重的幾筆", () => {
    const a = mk({
      durationMs: 20000,
      peak: (_i, ms) => (Math.floor(ms / 1000) % 2 === 0 && ms % 1000 < 100 ? [-127, 127] : [-40, 40]),
    });
    expect(findClipping(a, null).length).toBeLessThanOrEqual(DEFAULT_QC.maxPerKind);
  });
});

describe("findLevelJumps", () => {
  it("音量平穩就沒事", () => {
    expect(findLevelJumps(mk({ durationMs: 10000 }), null)).toHaveLength(0);
  });

  it("音量突然掉下去會被抓到，值是負的", () => {
    const a = mk({ durationMs: 10000, shortTerm: (_w, ms) => (ms < 5000 ? -18 : -30) });
    const [f] = findLevelJumps(a, null);
    expect(f.kind).toBe("level_jump");
    expect(f.value).toBeLessThan(-8);
    // 位置要**正好**落在轉折點。一秒中位數在後半段換掉六格時就會翻過去，
    // 所以第一個超過門檻的視窗其實早了 0.4 秒 —— 那會讓人點下去聽不到問題。
    expect(f.startMs).toBe(5000);
  });

  it("跳變位置取相鄰落差最大的那一格，不是第一個超過門檻的視窗", () => {
    // 落差在 3000 ms；若用「第一個超過門檻」會回報 2600
    const a = mk({ durationMs: 8000, shortTerm: (_w, ms) => (ms < 3000 ? -16 : -28) });
    expect(findLevelJumps(a, null)[0].startMs).toBe(3000);
  });

  it("音量突然變大也算，值是正的", () => {
    const a = mk({ durationMs: 10000, shortTerm: (_w, ms) => (ms < 5000 ? -32 : -18) });
    expect(findLevelJumps(a, null)[0].value).toBeGreaterThan(8);
  });

  it("從靜音進到說話不算（那是正常的）", () => {
    const a = mk({ durationMs: 10000, shortTerm: (_w, ms) => (ms < 5000 ? -70 : -18) });
    expect(findLevelJumps(a, null)).toHaveLength(0);
  });

  it("一次跳變只回報一筆，不是連續十格都報", () => {
    const a = mk({ durationMs: 20000, shortTerm: (_w, ms) => (ms < 10000 ? -16 : -30) });
    expect(findLevelJumps(a, null)).toHaveLength(1);
  });

  it("小幅度的起伏不算（講話本來就有強弱）", () => {
    const a = mk({ durationMs: 10000, shortTerm: (_w, ms) => (ms < 5000 ? -20 : -24) });
    expect(findLevelJumps(a, null)).toHaveLength(0);
  });

  it("同一個轉折不會回報兩筆（兩段各自修到同一格）", () => {
    // 降 → 短暫回升到門檻以下 → 再降：兩段「超過門檻」的區間，但轉折是同一個
    const a = mk({
      durationMs: 16000,
      shortTerm: (_w, ms) => (ms < 6000 ? -16 : ms < 6400 ? -26 : ms < 6800 ? -25 : -27),
    });
    const found = findLevelJumps(a, null);
    const positions = new Set(found.map((f) => f.startMs));
    expect(positions.size).toBe(found.length);
  });

  it("掉進近乎無聲的那一段，要等兩側都有人講話才比得出來", () => {
    // 5000 ms 掉到 −60 LUFS（低於 jumpFloorLufs）→ 那個時間點比不出來，不回報
    const a = mk({ durationMs: 12000, shortTerm: (_w, ms) => (ms < 5000 ? -18 : -60) });
    expect(findLevelJumps(a, null)).toHaveLength(0);
  });

  it("門檻可以調", () => {
    const a = mk({ durationMs: 10000, shortTerm: (_w, ms) => (ms < 5000 ? -20 : -25) });
    const loose: QcOptions = { ...DEFAULT_QC, jumpLu: 4 };
    expect(findLevelJumps(a, null, loose)).toHaveLength(1);
  });
});

describe("findDcOffset", () => {
  it("中線在零就沒事", () => {
    expect(findDcOffset(mk({ durationMs: 5000, peak: () => [-60, 60] }))).toHaveLength(0);
  });

  it("整段偏移會被抓到，回報佔滿刻度的百分比", () => {
    // 中線在 +12.7 ≈ 滿刻度的 10%
    const a = mk({ durationMs: 5000, peak: () => [-47, 73] });
    const [f] = findDcOffset(a);
    expect(f.kind).toBe("dc_offset");
    expect(f.value).toBeCloseTo(10, 0);
  });

  it("負偏移也算", () => {
    expect(findDcOffset(mk({ durationMs: 5000, peak: () => [-73, 47] }))[0].value).toBeLessThan(0);
  });

  it("只看有聲音的桶：整段靜音不下判斷", () => {
    const a = mk({ durationMs: 5000, peak: () => [-47, 73], rms: () => -70 });
    expect(findDcOffset(a)).toHaveLength(0);
  });

  it("樣本太少不下判斷", () => {
    expect(findDcOffset(mk({ durationMs: 50, peak: () => [-47, 73] }))).toHaveLength(0);
  });
});

describe("findDeadAir", () => {
  it("一直有聲音就沒事", () => {
    expect(findDeadAir(mk({ durationMs: 20000 }), null)).toHaveLength(0);
  });

  it("連續好幾秒沒聲音會被抓到", () => {
    const a = mk({ durationMs: 20000, rms: (_i, ms) => (ms >= 5000 && ms < 11000 ? -70 : -20) });
    const [f] = findDeadAir(a, null);
    expect(f.startMs).toBe(5000);
    expect(f.value).toBe(6000);
  });

  it("短的停頓不算（那是呼吸）", () => {
    const a = mk({ durationMs: 20000, rms: (_i, ms) => (ms >= 5000 && ms < 6000 ? -70 : -20) });
    expect(findDeadAir(a, null)).toHaveLength(0);
  });

  it("已經被剪掉的長停頓不報 —— 那正是它被剪掉的原因", () => {
    const a = mk({ durationMs: 20000, rms: (_i, ms) => (ms >= 5000 && ms < 11000 ? -70 : -20) });
    expect(findDeadAir(a, [{ startMs: 0, endMs: 5000 }, { startMs: 11000, endMs: 20000 }])).toHaveLength(0);
  });
});

describe("scanAudio / summarizeQc", () => {
  it("全部一起跑，依時間排序", () => {
    const a = mk({
      durationMs: 30000,
      peak: (_i, ms) => (ms >= 20000 && ms < 20100 ? [-127, 127] : [-40, 40]),
      rms: (_i, ms) => (ms >= 2000 && ms < 8000 ? -70 : -20),
      shortTerm: (_w, ms) => (ms < 15000 ? -18 : -30),
    });
    const list = scanAudio(a, null);
    expect(list.map((f) => f.kind)).toEqual(["dead_air", "level_jump", "clipping"]);
    for (let i = 1; i < list.length; i++) expect(list[i].startMs).toBeGreaterThanOrEqual(list[i - 1].startMs);
  });

  it("摘要把每一種收成數字", () => {
    const s = summarizeQc([
      { kind: "clipping", startMs: 0, endMs: 100, value: 100 },
      { kind: "clipping", startMs: 500, endMs: 560, value: 60 },
      { kind: "level_jump", startMs: 900, endMs: 1000, value: -11.5 },
      { kind: "dc_offset", startMs: 0, endMs: 1000, value: 4.2 },
      { kind: "dead_air", startMs: 2000, endMs: 8000, value: 6000 },
    ]);
    expect(s).toEqual({
      clipping: 2, clippingMs: 160, levelJumps: 1, maxJumpLu: 11.5,
      dcPercent: 4.2, deadAir: 1, longestDeadAirMs: 6000,
    });
  });

  it("乾淨的錄音掃出來是空的（不會硬湊毛病出來）", () => {
    expect(scanAudio(mk({ durationMs: 30000 }), null)).toHaveLength(0);
    expect(summarizeQc([])).toEqual({ clipping: 0, clippingMs: 0, levelJumps: 0, maxJumpLu: 0, dcPercent: 0, deadAir: 0, longestDeadAirMs: 0 });
  });
});
