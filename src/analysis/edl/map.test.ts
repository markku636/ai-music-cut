import { describe, expect, it } from "vitest";
import type { Edl, KeepSegment } from "./build";
import { mapOutToSrc, mapSrcToOut, seamNear, seamsOf, seamWindow } from "./map";

function k(id: number, s: number, e: number, os: number, oe: number): KeepSegment {
  return { id, srcStartMs: s, srcEndMs: e, outStartMs: os, outEndMs: oe, gainDb: 0 };
}

// 剪掉 1000–1500 與 3000–3200；第一刀是 crossfade（重疊 20ms），第二刀是 gap（+150ms）
const KEEPS = [k(0, 0, 1000, 0, 1000), k(1, 1500, 3000, 980, 2480), k(2, 3200, 5000, 2630, 4430)];
const EDL: Edl = {
  keeps: KEEPS,
  joins: [
    { afterKeepId: 0, kind: "crossfade", ms: 20, removedCandidateIds: ["c1"] },
    { afterKeepId: 1, kind: "gap", ms: 150, removedCandidateIds: ["c2", "c3"] },
  ],
  stats: { removedMs: 700, srcMs: 60_000, keptMs: 4300, outMs: 4430, cutCount: 2, byKind: {} },
  downgrades: [],
  removals: [], rearranged: false,
};

describe("mapSrcToOut", () => {
  it("保留區內線性對應", () => {
    expect(mapSrcToOut(KEEPS, 0)).toBe(0);
    expect(mapSrcToOut(KEEPS, 500)).toBe(500);
    expect(mapSrcToOut(KEEPS, 2000)).toBe(980 + 500);
    expect(mapSrcToOut(KEEPS, 4000)).toBe(2630 + 800);
  });

  it("落在剪除區時預設靠下一段的開頭", () => {
    expect(mapSrcToOut(KEEPS, 1200)).toBe(980);
    expect(mapSrcToOut(KEEPS, 3100)).toBe(2630);
  });

  it("可以改成靠前一段的結尾", () => {
    expect(mapSrcToOut(KEEPS, 1200, "prev")).toBe(1000);
    expect(mapSrcToOut(KEEPS, 3100, "prev")).toBe(2480);
  });

  it("超出範圍夾住", () => {
    expect(mapSrcToOut(KEEPS, -100)).toBe(0);
    expect(mapSrcToOut(KEEPS, 99_999)).toBe(4430);
  });

  it("沒有保留段時回 0（不要丟例外）", () => {
    expect(mapSrcToOut([], 1234)).toBe(0);
  });
});

describe("mapOutToSrc", () => {
  it("是 mapSrcToOut 在保留區內的反函式（避開 crossfade 重疊）", () => {
    for (const src of [0, 250, 900, 1530, 2200, 3200, 4999]) {
      const out = mapSrcToOut(KEEPS, src);
      expect(mapOutToSrc(KEEPS, out)).toBeCloseTo(src, 6);
    }
  });

  it("crossfade 重疊區內來回不是恆等 —— 那 20 ms 兩段真的同時在響", () => {
    // keeps[0] 的 out 是 [0,1000]、keeps[1] 是 [980,2480]，中間 20 ms 重疊
    expect(mapSrcToOut(KEEPS, 1500)).toBe(980);
    // 反查 980 會落在前一段（先找到誰就是誰），這是預期行為而不是 bug
    expect(mapOutToSrc(KEEPS, 980)).toBe(980);
    // 離開重疊之後就精準了
    expect(mapOutToSrc(KEEPS, 1001)).toBeCloseTo(1521, 6);
  });

  it("落在 gap（room tone）裡就回下一段的起點", () => {
    // keeps[1].outEndMs=2480、keeps[2].outStartMs=2630 → 中間 150ms 是 room tone
    expect(mapOutToSrc(KEEPS, 2550)).toBe(3200);
  });

  it("超出範圍夾住", () => {
    expect(mapOutToSrc(KEEPS, -5)).toBe(0);
    expect(mapOutToSrc(KEEPS, 99_999)).toBe(5000);
  });
});

describe("seamsOf", () => {
  it("每一刀一個接縫，帶成品位置與被剪掉的來源區間", () => {
    const seams = seamsOf(EDL);
    expect(seams).toHaveLength(2);
    expect(seams[0]).toMatchObject({ index: 0, kind: "crossfade", outMs: 1000, srcBeforeMs: 1000, srcAfterMs: 1500, removedMs: 500 });
    expect(seams[1]).toMatchObject({ index: 1, kind: "gap", outMs: 2480, srcBeforeMs: 3000, srcAfterMs: 3200, removedMs: 200 });
  });

  it("帶出造成這個接縫的候選（巡覽時要能當場改判保留）", () => {
    expect(seamsOf(EDL)[1].candidateIds).toEqual(["c2", "c3"]);
  });

  it("最後一段之後沒有接縫", () => {
    const one: Edl = { ...EDL, keeps: [KEEPS[0]], joins: [{ afterKeepId: 0, kind: "crossfade", ms: 20, removedCandidateIds: [] }] };
    expect(seamsOf(one)).toHaveLength(0);
  });
});

describe("seamNear / seamWindow", () => {
  const seams = seamsOf(EDL);

  it("往後找下一個、往前找上一個", () => {
    expect(seamNear(seams, 0, 1)?.index).toBe(0);
    expect(seamNear(seams, 1000, 1)?.index).toBe(1);
    expect(seamNear(seams, 2480, -1)?.index).toBe(0);
    expect(seamNear(seams, 3000, 1)).toBeNull();
    expect(seamNear(seams, 0, -1)).toBeNull();
  });

  it("巡覽視窗前後各留 pad，而且不會是負的", () => {
    expect(seamWindow(seams[0], 1200)).toEqual({ startMs: 0, endMs: 2200 });
    expect(seamWindow(seams[1], 500)).toEqual({ startMs: 1980, endMs: 2980 });
  });
});

describe("seamsOf：編排接縫不謊報「剪掉多久」", () => {
  const edlOf = (keeps: KeepSegment[], joins: Edl["joins"]): Edl =>
    ({ keeps, joins, removals: [], stats: { outMs: keeps.length ? keeps[keeps.length - 1].outEndMs : 0 } }) as unknown as Edl;

  it("一般接縫照常報中間剪掉多久", () => {
    const e = edlOf([k(0, 0, 1000, 0, 1000), k(1, 2000, 3000, 1000, 2000)], [{ afterKeepId: 0, kind: "crossfade", ms: 24, removedCandidateIds: [] }] as never);
    const s = seamsOf(e)[0];
    expect(s.rearranged).toBe(false);
    expect(s.removedMs).toBe(1000);
  });

  it("搬移的接縫：不是「剪掉 0 ms」，是「這裡沒有剪掉東西」", () => {
    const e = edlOf([k(0, 5000, 6000, 0, 1000), k(1, 0, 1000, 1000, 2000)], [{ afterKeepId: 0, kind: "seam", ms: 0, removedCandidateIds: [] }] as never);
    const s = seamsOf(e)[0];
    expect(s.rearranged).toBe(true);
    // 舊版是 Math.max(0, 0 - 6000) = 0，畫面上就寫著「剪掉 0.00s」——
    // 旗標存在才分得出「剛好沒剪到」與「這裡根本不是一刀」
    expect(s.removedMs).toBe(0);
  });
});
