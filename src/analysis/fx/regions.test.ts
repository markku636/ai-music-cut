import { describe, expect, it } from "vitest";
import type { AudioEffect } from "../effects";
import { msToFrames, planOutFrames, type JoinSpec, type SegSpan } from "../edl/joins";
import { FX_MIN_REGION_FRAMES, FX_XF_FRAMES, coveredFrames, fxRegionsToOut, toRenderFx } from "./regions";

const F = msToFrames;
const fx = (kind: AudioEffect["kind"], startMs: number, endMs: number, params?: Record<string, number>): AudioEffect => ({
  id: `${kind}:${startMs}-${endMs}`,
  kind,
  startMs,
  endMs,
  ...(params ? { params } : {}),
});

/** 可重現的偽亂數。 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 逐 frame 的參考實作：把每個成品 frame 對回來源，看哪些效果蓋到。 */
function bruteCoverage(effects: AudioEffect[], segs: SegSpan[], joins: JoinSpec[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let i = 0; i < segs.length; i++) {
    const s0 = F(segs[i].startMs);
    const s1 = F(segs[i].endMs);
    for (const e of effects) {
      const e0 = F(e.startMs);
      const e1 = F(e.endMs);
      const n = Math.max(0, Math.min(e1, s1) - Math.max(e0, s0));
      out.set(e.id, (out.get(e.id) ?? 0) + n);
    }
  }
  void joins;
  return out;
}

describe("toRenderFx", () => {
  it("params 袋 → Rust 的型別化效果；缺的用預設", () => {
    expect(toRenderFx(fx("denoise", 0, 1, { nrDb: 15, nfDb: -45 }))).toEqual({ kind: "denoise", nr_db: 15, nf_db: -45 });
    expect(toRenderFx(fx("denoise", 0, 1))).toEqual({ kind: "denoise", nr_db: 12, nf_db: -50 });
    expect(toRenderFx(fx("hum", 0, 1, { baseHz: 50, harmonics: 6 }))).toEqual({ kind: "hum", base_hz: 50, harmonics: 6 });
    expect(toRenderFx(fx("dc", 0, 1))).toEqual({ kind: "dc", shift: 0 });
  });
  it("增益類不是範圍效果 → null；六種音色 / 動態 / 空間效果都有對應", () => {
    expect(toRenderFx(fx("gain", 0, 1))).toBeNull();
    expect(toRenderFx(fx("reverb", 0, 1))).toEqual({ kind: "reverb", size: 1, mix: 0.6 });
    expect(toRenderFx(fx("reverse", 0, 1))).toEqual({ kind: "reverse" });
    expect(toRenderFx(fx("pitch", 0, 1, { semitones: 3 }))).toEqual({ kind: "pitch", semitones: 3 });
    expect(toRenderFx(fx("compressor", 0, 1, { thresholdDb: -20 }))).toMatchObject({ kind: "compressor", threshold_db: -20, ratio: 4 });
  });
});

describe("fxRegionsToOut", () => {
  const segs: SegSpan[] = [
    { startMs: 0, endMs: 10_000 },
    { startMs: 20_000, endMs: 30_000 },
  ];
  const xf: JoinSpec[] = [{ kind: "crossfade", ms: 20 }];

  it("落在剪除區的效果不產生區域", () => {
    const r = fxRegionsToOut([fx("denoise", 12_000, 18_000)], segs, xf);
    expect(r.regions).toEqual([]);
    expect(r.unsupported).toEqual([]);
  });

  it("跨剪點的效果是一塊，長度 = 兩邊保留的部分 − crossfade 重疊", () => {
    const e = fx("denoise", 8_000, 22_000);
    const { regions } = fxRegionsToOut([e], segs, xf);
    expect(regions).toHaveLength(1);
    expect(F(regions[0].out_start_ms)).toBe(F(8_000));
    // 8–10 s 在第一段、20–22 s 在第二段；第二段在成品從 10 s − 20 ms 開始
    expect(F(regions[0].out_end_ms)).toBe(F(10_000) - F(20) + F(2_000));
    expect(regions[0].chain).toEqual([{ kind: "denoise", nr_db: 12, nf_db: -50 }]);
    expect(regions[0].correlated).toBe(true);
  });

  it("兩種效果重疊 → 三塊，中間那塊的鏈依 rank 排（dc 先於 denoise）", () => {
    const a = fx("denoise", 1_000, 5_000);
    const b = fx("dc", 3_000, 7_000);
    const { regions } = fxRegionsToOut([a, b], segs, xf);
    expect(regions.map((r) => [F(r.out_start_ms), F(r.out_end_ms)])).toEqual([
      [F(1_000), F(3_000)],
      [F(3_000), F(5_000)],
      [F(5_000), F(7_000)],
    ]);
    expect(regions[1].chain.map((c) => c.kind)).toEqual(["dc", "denoise"]);
    expect(regions[1].effectIds).toEqual([b.id, a.id]);
  });

  it("同一段同時被兩個相同鏈的效果蓋到時不重複（跨 seg 的同一效果）", () => {
    const e = fx("declick", 9_995, 20_005);
    const { regions } = fxRegionsToOut([e], segs, xf);
    // 9.995–10 s 與 20–20.005 s 各 5 ms，crossfade 重疊區兩個 piece 疊在一起 → 一塊但太短會被丟掉
    expect(regions.every((r) => r.effectIds.length === 1)).toBe(true);
  });

  it("短於 2·XF 的碎片丟掉", () => {
    const tiny = fx("declick", 1_000, 1_000 + 15);
    expect(fxRegionsToOut([tiny], segs, xf).regions).toEqual([]);
    const ok = fx("declick", 1_000, 1_000 + 20);
    expect(fxRegionsToOut([ok], segs, xf).regions).toHaveLength(1);
  });

  it("兩塊之間短於 XF 的縫收起來（前一塊延到後一塊起點）", () => {
    const a = fx("denoise", 1_000, 2_000);
    const b = fx("declick", 2_005, 3_000);
    const { regions } = fxRegionsToOut([a, b], segs, xf);
    expect(regions).toHaveLength(2);
    expect(F(regions[0].out_end_ms)).toBe(F(regions[1].out_start_ms));
  });

  it("縫夠長就保留", () => {
    const a = fx("denoise", 1_000, 2_000);
    const b = fx("declick", 2_050, 3_000);
    const { regions } = fxRegionsToOut([a, b], segs, xf);
    expect(F(regions[1].out_start_ms) - F(regions[0].out_end_ms)).toBe(F(50));
  });

  it("引擎不支援的種類列在 unsupported，不默默少掉", () => {
    const bogus = { ...fx("denoise", 1_000, 2_000), kind: "flanger" as AudioEffect["kind"], id: "bogus" };
    const r = fxRegionsToOut([bogus, fx("denoise", 1_000, 2_000)], segs, xf);
    // flanger 不是範圍效果也不是增益效果 → 兩邊都不理；真正的「不支援」要等 RangeEffectKind 多出引擎沒接的種類
    expect(r.unsupported).toEqual([]);
    expect(r.regions).toHaveLength(1);
  });

  it("反轉 / 變調的區域標成 correlated=false，混在一起也是", () => {
    const r = fxRegionsToOut([fx("reverse", 1_000, 2_000), fx("denoise", 1_500, 3_000)], segs, xf);
    expect(r.regions.map((x) => x.correlated)).toEqual([false, false, true]);
  });

  it("增益類效果完全不理", () => {
    expect(fxRegionsToOut([fx("gain", 0, 5_000), fx("mute", 0, 5_000)], segs, xf).regions).toEqual([]);
  });

  it("gap 接點把後面的區域往後推", () => {
    const gap: JoinSpec[] = [{ kind: "gap", ms: 500 }];
    const { regions } = fxRegionsToOut([fx("denoise", 21_000, 22_000)], segs, gap);
    expect(F(regions[0].out_start_ms)).toBe(F(10_000) + F(500) + F(1_000));
  });

  it("隨機輸入：排序、不重疊、縫 0 或 ≥ XF、長度 ≥ 2·XF、都在成品長度內、覆蓋量對得上參考實作（容忍丟掉的碎片）", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed);
      const nSeg = 1 + Math.floor(r() * 5);
      const sg: SegSpan[] = [];
      let t = 0;
      for (let i = 0; i < nSeg; i++) {
        t += Math.floor(r() * 3000);
        const len = 30 + Math.floor(r() * 5000);
        sg.push({ startMs: t, endMs: t + len });
        t += len;
      }
      const jn: JoinSpec[] = [];
      for (let i = 0; i + 1 < nSeg; i++) {
        const k = r();
        jn.push(k < 0.5 ? { kind: "crossfade", ms: 20 } : k < 0.8 ? { kind: "gap", ms: Math.floor(r() * 400) } : { kind: "seam", ms: 0 });
      }
      const kinds: AudioEffect["kind"][] = ["denoise", "declick", "dc", "hum", "declip"];
      const effects: AudioEffect[] = [];
      const nFx = 1 + Math.floor(r() * 4);
      for (let i = 0; i < nFx; i++) {
        const a = Math.floor(r() * t);
        const b = Math.min(t, a + 10 + Math.floor(r() * 6000));
        effects.push({ ...fx(kinds[Math.floor(r() * kinds.length)], a, b), id: `e${i}` });
      }
      const { regions } = fxRegionsToOut(effects, sg, jn);
      const total = planOutFrames(sg, jn);
      for (let i = 0; i < regions.length; i++) {
        const a = F(regions[i].out_start_ms);
        const b = F(regions[i].out_end_ms);
        expect(b - a, `seed ${seed} region ${i} too short`).toBeGreaterThanOrEqual(FX_MIN_REGION_FRAMES);
        expect(b, `seed ${seed} region ${i} beyond end`).toBeLessThanOrEqual(total);
        if (i > 0) {
          const gap = a - F(regions[i - 1].out_end_ms);
          expect(gap, `seed ${seed} region ${i} gap`).toBeGreaterThanOrEqual(0);
          expect(gap === 0 || gap >= FX_XF_FRAMES, `seed ${seed} region ${i} tiny gap ${gap}`).toBe(true);
        }
        // 鏈依 rank：dc < declick < declip < hum < denoise
        const order = ["dc", "declick", "declip", "hum", "denoise"];
        const ranks = regions[i].chain.map((c) => order.indexOf(c.kind));
        expect([...ranks].sort((x, y) => x - y), `seed ${seed} chain order`).toEqual(ranks);
      }
      const ref = bruteCoverage(effects, sg, jn);
      for (const e of effects) {
        const got = coveredFrames(regions, e.id);
        const want = ref.get(e.id) ?? 0;
        // 丟掉的碎片 < 2·XF、每個縫最多多算 XF；效果最多被切成 (段數 + 效果數·2) 塊
        const slack = (sg.length + effects.length * 2) * (FX_MIN_REGION_FRAMES + FX_XF_FRAMES);
        expect(Math.abs(got - want), `seed ${seed} coverage ${e.id}: got ${got} want ${want}`).toBeLessThanOrEqual(slack);
      }
    }
  });
});
