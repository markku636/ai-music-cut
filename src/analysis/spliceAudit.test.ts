import { describe, expect, it } from "vitest";
import type { Edl } from "./edl/build";
import type { LocalAnalysis } from "./peaks";
import { auditSplice, ncc, LAG_OK_MS, MAX_LAG_MS, SYSTEMATIC_LAG_MAX_MS } from "./spliceAudit";

const PPS = 200;

function fromDb(db: number[]): LocalAnalysis {
  const rmsU8 = Uint8Array.from(db.map((d) => Math.max(0, Math.min(255, Math.round(((d + 60) / 60) * 255)))));
  return {
    version: 2,
    pps: PPS,
    hopMs: 100,
    sampleRate: 48000,
    nBuckets: rmsU8.length,
    nWin: 0,
    totalSamples: 0,
    durationMs: Math.round((rmsU8.length / PPS) * 1000),
    mins: new Int8Array(0),
    maxs: new Int8Array(0),
    rmsU8,
    win: new Float32Array(0),
    zx: null,
  };
}

/** 造一段有辨識度的包絡：用不同頻率的正弦當「指紋」。 */
function pattern(seconds: number, freq: number, offset = 0): number[] {
  const n = Math.round(seconds * PPS);
  return Array.from({ length: n }, (_, i) => -30 + 20 * Math.sin((2 * Math.PI * freq * (i + offset)) / PPS));
}

// 來源 6 秒：A(0–2s, f=3) B(2–4s, f=7) C(4–6s, f=13)；EDL 保留 A 與 C
const SRC = fromDb([...pattern(2, 3), ...pattern(2, 7, 400), ...pattern(2, 13, 800)]);
const EDL: Edl = {
  keeps: [
    { id: 0, srcStartMs: 0, srcEndMs: 2000, outStartMs: 0, outEndMs: 2000, gainDb: 0 },
    { id: 1, srcStartMs: 4000, srcEndMs: 6000, outStartMs: 2000, outEndMs: 4000, gainDb: 0 },
  ],
  joins: [],
  stats: { removedMs: 2000, keptMs: 4000, outMs: 4000, cutCount: 1, byKind: {} },
  downgrades: [],
  removals: [], rearranged: false,
};

describe("spliceAudit", () => {
  it("剪對了 → 每段都對得上", () => {
    const out = fromDb([...pattern(2, 3), ...pattern(2, 13, 800)]);
    const r = auditSplice(SRC, out, EDL, { probeMs: 1200 });
    expect(r.segments).toHaveLength(2);
    expect(r.okCount).toBe(2);
    expect(Math.abs(r.segments[0].lagMs)).toBeLessThanOrEqual(25);
    expect(r.segments[1].corr).toBeGreaterThan(0.75);
    expect(r.summary).toContain("全部對得上");
  });

  it("接錯段（把 B 接上去）→ 該段對不上", () => {
    const out = fromDb([...pattern(2, 3), ...pattern(2, 7, 400)]);
    const r = auditSplice(SRC, out, EDL, { probeMs: 1200 });
    expect(r.segments[0].ok).toBe(true);
    expect(r.segments[1].ok).toBe(false);
    expect(r.segments[1].note).toContain("對不上");
  });

  it("整體偏移 40 ms → 標成位置偏了", () => {
    const pad = Array.from({ length: Math.round(0.04 * PPS) }, () => -60);
    const out = fromDb([...pad, ...pattern(2, 3), ...pattern(2, 13, 800)]);
    const r = auditSplice(SRC, out, EDL, { probeMs: 1200 });
    expect(Math.abs(r.segments[0].lagMs)).toBeGreaterThanOrEqual(25);
    expect(r.segments[0].ok).toBe(false);
  });

  it("ncc：同訊號 1、反相 −1", () => {
    const a = Float32Array.from([1, 2, 3, 4, 5]);
    const b = Float32Array.from([1, 2, 3, 4, 5]);
    const c = Float32Array.from([5, 4, 3, 2, 1]);
    expect(ncc(a, b)).toBeCloseTo(1, 5);
    expect(ncc(a, c)).toBeCloseTo(-1, 5);
  });
});

describe("成品混了配樂時的判定", () => {
  // 成品多了音樂，能量包絡本來就跟來源不一樣（實測相關係數從 0.9 掉到 0.17），
  // 但位置仍然正確。硬用原本的門檻會對一個好成品報假警報。
  const edl = {
    keeps: [
      { id: 0, srcStartMs: 0, srcEndMs: 4000, outStartMs: 0, outEndMs: 4000, gainDb: 0 },
      { id: 1, srcStartMs: 6000, srcEndMs: 10000, outStartMs: 4000, outEndMs: 8000, gainDb: 0 },
    ],
    joins: [],
    stats: { removedMs: 2000, keptMs: 8000, outMs: 8000, cutCount: 1, byKind: {} },
    downgrades: [],
    removals: [], rearranged: false,
  } as unknown as Parameters<typeof auditSplice>[2];

  function envelope(fill: (i: number) => number): LocalAnalysis {
    const n = 2400; // 12 秒 @200pps
    const rms = new Uint8Array(n);
    for (let i = 0; i < n; i++) rms[i] = Math.max(0, Math.min(255, Math.round(fill(i))));
    return {
      version: 3, pps: 200, hopMs: 100, sampleRate: 48000, nBuckets: n, nWin: 0,
      totalSamples: 0, durationMs: (n / 200) * 1000,
      mins: new Int8Array(n), maxs: new Int8Array(n), rmsU8: rms, win: new Float32Array(0), zx: null,
    };
  }

  // 人聲：快速起伏。配樂：另一條慢很多的曲線（與人聲無關）。
  const voice = (i: number) => 120 + 90 * Math.sin(i / 3.1) * Math.sin(i / 11.7);
  const musicBed = (i: number) => 100 + 60 * Math.sin(i / 137);
  const src = envelope(voice);
  // 成品 = 人聲被壓小 + 音樂蓋上去：位置一樣，但包絡的形狀被音樂主導
  const mixedOut = envelope((i) => voice(i) * 0.3 + musicBed(i));

  it("波形被配樂蓋掉但位置對時，混了配樂就算通過", () => {
    const strict = auditSplice(src, mixedOut, edl);
    const mixed = auditSplice(src, mixedOut, edl, { mixedWithOverlays: true });
    // 嚴格模式會因為相關係數不夠而報錯
    expect(strict.okCount).toBeLessThan(strict.segments.length);
    // 但位移其實是對的，所以混音模式應該全過
    expect(mixed.segments.every((x) => Math.abs(x.lagMs) <= LAG_OK_MS)).toBe(true);
    expect(mixed.okCount).toBe(mixed.segments.length);
    expect(mixed.mixedWithOverlays).toBe(true);
    expect(mixed.summary).toContain("只比對位置");
  });

  it("就算混了配樂，位置真的錯掉還是要抓出來", () => {
    // 成品整體晚了 300 ms（遠超過 LAG_OK_MS）
    const shifted = envelope((i) => voice(i - 60) * 0.3 + musicBed(i));
    const r = auditSplice(src, shifted, edl, { mixedWithOverlays: true });
    expect(r.okCount).toBeLessThan(r.segments.length);
  });

  it("沒有配樂時維持原本的嚴格判定", () => {
    const r = auditSplice(src, mixedOut, edl);
    expect(r.mixedWithOverlays).toBe(false);
    expect(r.okCount).toBeLessThan(r.segments.length);
  });
});

describe("訊號鏈的共同延遲（修聲濾鏡）", () => {
  // 修聲的 afftdn 是 FFT 降噪，有 group delay：整個成品相對來源平移幾十毫秒，
  // 每一段都平移一樣多。實測一集 57 分鐘開了修聲的成品：662 段裡 551 段的 lag
  // 剛好 30 ms、相關係數中位數 0.99 —— 每段都接得好好的，卻有 597 段被判失敗。

  function envelope(n: number, fill: (i: number) => number): LocalAnalysis {
    const rms = new Uint8Array(n);
    for (let i = 0; i < n; i++) rms[i] = Math.max(0, Math.min(255, Math.round(fill(i))));
    return {
      version: 3, pps: 200, hopMs: 100, sampleRate: 48000, nBuckets: n, nWin: 0,
      totalSamples: 0, durationMs: (n / 200) * 1000,
      mins: new Int8Array(n), maxs: new Int8Array(n), rmsU8: rms, win: new Float32Array(0), zx: null,
    };
  }
  const shape = (i: number) => 128 + 90 * Math.sin(i / 2.7) * Math.sin(i / 9.3);

  /** n 段連續的保留段（沒有剪除，成品時間 = 來源時間）。 */
  function contiguousEdl(n: number, segMs = 1200) {
    const keeps = Array.from({ length: n }, (_, i) => ({
      id: i, srcStartMs: i * segMs, srcEndMs: (i + 1) * segMs,
      outStartMs: i * segMs, outEndMs: (i + 1) * segMs, gainDb: 0,
    }));
    return { keeps, joins: [], stats: { removedMs: 0, keptMs: n * segMs, outMs: n * segMs, cutCount: 0, byKind: {} }, downgrades: [], removals: [], rearranged: false } as unknown as Parameters<typeof auditSplice>[2];
  }

  const N = 12;
  const total = N * 1200 * 0.2 + 400; // 200 pps
  const src = envelope(total, shape);
  /** 成品整體延後 delayBuckets 個桶（1 桶 = 5 ms）。 */
  const delayed = (buckets: number) => envelope(total, (i) => shape(i - buckets));

  it("整份平移 30 ms（濾鏡延遲）→ 全部視為對得上", () => {
    const r = auditSplice(src, delayed(6), contiguousEdl(N)); // 6 桶 = 30 ms
    expect(r.systematicLagMs).toBe(30);
    expect(r.okCount).toBe(r.segments.length);
    expect(r.summary).toContain("整體延遲");
  });

  it("扣掉共同延遲之後，仍然抓得到單獨偏掉的那一段", () => {
    // 大部分段延後 30 ms，只有中間那一段又多偏了 80 ms
    const out = envelope(total, (i) => {
      const t = i / 0.2; // ms
      const inOdd = t >= 4 * 1200 && t < 5 * 1200;
      return shape(i - (inOdd ? 22 : 6));
    });
    const r = auditSplice(src, out, contiguousEdl(N));
    expect(r.systematicLagMs).toBe(30); // 多數仍然是 30
    expect(r.okCount).toBeLessThan(r.segments.length);
    expect(r.segments.some((x) => !x.ok && x.note.includes("比其他段偏了"))).toBe(true);
  });

  it("段數太少時不談系統性偏移（兩段的中位數證明不了什麼）", () => {
    const r = auditSplice(src, delayed(6), contiguousEdl(2));
    expect(r.systematicLagMs).toBe(0);
  });

  it("平移超過門檻就不算濾鏡延遲，要報出來", () => {
    // 55 ms：還在互相關的搜尋範圍（±60 ms）內量得到，但超過 50 ms 的上限
    const r = auditSplice(src, delayed(11), contiguousEdl(N));
    expect(r.systematicLagMs).toBe(0);
    expect(r.okCount).toBeLessThan(r.segments.length);
    expect(r.summary).toContain("不是濾鏡延遲");
  });

  it("上限必須小於互相關的搜尋範圍，否則那個條件是死碼", () => {
    expect(SYSTEMATIC_LAG_MAX_MS).toBeLessThan(MAX_LAG_MS);
  });
});
