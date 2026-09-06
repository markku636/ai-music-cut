import { describe, expect, it } from "vitest";
import type { Sentence, SplitPoint, Word } from "../types";
import { buildEdl, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE, type EdlInput, type KeepSegment } from "./build";
import { applySplits, canSplitAt } from "./split";
import { planOutDurationMs } from "./joins";

function keep(id: number, a: number, b: number): KeepSegment {
  return { id, srcStartMs: a, srcEndMs: b, outStartMs: 0, outEndMs: 0, gainDb: 0 };
}
function sp(ms: number, gapMs?: number): SplitPoint {
  return { id: `split:${ms}`, ms, ...(gapMs == null ? {} : { gapMs }) };
}

describe("applySplits", () => {
  it("切一刀把保留段斷成兩段，來源時間連續", () => {
    const r = applySplits([keep(0, 0, 1000)], [sp(400)], 80);
    expect(r.keeps.map((k) => [k.srcStartMs, k.srcEndMs])).toEqual([
      [0, 400],
      [400, 1000],
    ]);
    // 切點造成的接縫掛在前一段身上
    expect(r.splitAfter.get(0)).toEqual({ splitId: "split:400", gapMs: 0 });
    expect(r.splitAfter.has(1)).toBe(false);
  });

  it("重新編號 keep.id（joins / units / render 都靠這個對位）", () => {
    const r = applySplits([keep(0, 0, 1000), keep(1, 2000, 3000)], [sp(400)], 80);
    expect(r.keeps.map((k) => k.id)).toEqual([0, 1, 2]);
    expect(r.keeps[2].srcStartMs).toBe(2000);
  });

  it("貼著邊緣切不算數（會切出比 minKeepMs 還短的碎片）", () => {
    expect(applySplits([keep(0, 0, 1000)], [sp(40)], 80).keeps).toHaveLength(1);
    expect(applySplits([keep(0, 0, 1000)], [sp(970)], 80).keeps).toHaveLength(1);
    expect(applySplits([keep(0, 0, 1000)], [sp(80)], 80).keeps).toHaveLength(2);
  });

  it("落在剪除區裡的切點直接忽略", () => {
    const r = applySplits([keep(0, 0, 500), keep(1, 900, 1400)], [sp(700)], 80);
    expect(r.keeps).toHaveLength(2);
    expect(r.splitAfter.size).toBe(0);
  });

  it("同一位置切兩刀等於切一刀", () => {
    const r = applySplits([keep(0, 0, 1000)], [sp(400), { id: "split:400#2", ms: 400 }], 80);
    expect(r.keeps).toHaveLength(2);
  });

  it("一段內切多刀", () => {
    const r = applySplits([keep(0, 0, 1000)], [sp(300), sp(600)], 80);
    expect(r.keeps.map((k) => [k.srcStartMs, k.srcEndMs])).toEqual([
      [0, 300],
      [300, 600],
      [600, 1000],
    ]);
    expect(r.splitAfter.size).toBe(2);
  });

  it("canSplitAt 與 applySplits 的判斷一致", () => {
    const keeps = [keep(0, 0, 1000)];
    expect(canSplitAt(keeps, 40, 80)).toBe(false);
    expect(canSplitAt(keeps, 400, 80)).toBe(true);
  });
});

describe("buildEdl + 切點", () => {
  const words: Word[] = [
    { id: 0, segId: 0, text: "我", norm: "我", startMs: 0, endMs: 400, prob: 0.9 },
    { id: 1, segId: 0, text: "好", norm: "好", startMs: 600, endMs: 1000, prob: 0.9 },
  ];
  const sentences: Sentence[] = [{ id: 0, wordIds: [0, 1], startMs: 0, endMs: 1000, endsWithQuestion: false }];
  const input: EdlInput = { words, sentences, vad: [{ startMs: 0, endMs: 1000 }], durationMs: 1000 };

  it("純切點：兩段 keep + seam join，成品長度不變", () => {
    const plain = buildEdl(input, [], {}, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE);
    const cut = buildEdl({ ...input, splits: [sp(500)] }, [], {}, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE);
    expect(plain.keeps).toHaveLength(1);
    expect(cut.keeps).toHaveLength(2);
    expect(cut.joins).toHaveLength(1);
    expect(cut.joins[0].kind).toBe("seam");
    expect(cut.joins[0].ms).toBe(0);
    expect(cut.joins[0].splitId).toBe("split:500");
    // 對接不重疊也不插東西 → 切完長度必須跟沒切一樣
    expect(cut.stats.outMs).toBeCloseTo(plain.stats.outMs, 6);
    expect(cut.stats.keptMs).toBeCloseTo(plain.stats.keptMs, 6);
  });

  it("切點不算「剪了幾刀」", () => {
    const cut = buildEdl({ ...input, splits: [sp(500)] }, [], {}, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE);
    expect(cut.stats.cutCount).toBe(0);
  });

  it("gapMs > 0 產生 gap join，成品變長", () => {
    const cut = buildEdl({ ...input, splits: [sp(500, 400)] }, [], {}, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE);
    expect(cut.joins[0].kind).toBe("gap");
    expect(cut.joins[0].ms).toBe(400);
    expect(cut.joins[0].fadeOutMs).toBe(DEFAULT_EDL_OPTIONS.fade.gapFadeOutMs);
    expect(cut.stats.outMs).toBeCloseTo(1000 + 400, 3);
  });

  it("EDL 的輸出長度與 joins.ts 的公式一致（seam / gap 混合）", () => {
    const cut = buildEdl({ ...input, splits: [sp(300), sp(700, 250)] }, [], {}, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE);
    const viaFormula = planOutDurationMs(
      cut.keeps.map((k) => ({ startMs: k.srcStartMs, endMs: k.srcEndMs })),
      cut.joins,
    );
    expect(cut.stats.outMs).toBeCloseTo(viaFormula, 6);
  });

  it("沒有切點時整條路徑與以前完全相同", () => {
    const a = buildEdl(input, [], {}, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE);
    const b = buildEdl({ ...input, splits: [] }, [], {}, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE);
    expect(b).toEqual(a);
  });
});
