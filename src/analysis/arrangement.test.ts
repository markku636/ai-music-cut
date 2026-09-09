import { describe, expect, it } from "vitest";
import { arrangementBlocks, worthShowing } from "./arrangement";
import type { KeepSegment } from "./edl/build";

/** 依成品順序排好的保留段；out 時間照長度累加。 */
function keeps(spans: { src: [number, number]; pasteId?: string }[]): KeepSegment[] {
  let out = 0;
  return spans.map((s, i) => {
    const len = s.src[1] - s.src[0];
    const k = { id: i, srcStartMs: s.src[0], srcEndMs: s.src[1], outStartMs: out, outEndMs: out + len, gainDb: 0, pasteId: s.pasteId };
    out += len;
    return k as KeepSegment;
  });
}

const outMsOf = (ks: KeepSegment[]) => (ks.length ? ks[ks.length - 1].outEndMs : 0);

describe("arrangementBlocks", () => {
  it("剪掉贅字的那幾百刀不會變成幾百塊 —— 這條帶子看的是編排", () => {
    // 三段之間各剪掉 300 ms（贅字），來源一路往前
    const ks = keeps([{ src: [0, 5000] }, { src: [5300, 9000] }, { src: [9300, 12_000] }]);
    const b = arrangementBlocks(ks, outMsOf(ks));
    expect(b).toHaveLength(1);
    expect(b[0].keepCount).toBe(3);
    expect(b[0].cutInsideMs).toBe(600);
    expect(b[0].srcStartMs).toBe(0);
    expect(b[0].srcEndMs).toBe(12_000);
  });

  it("剪掉一大段會斷開 —— 那是結構性的剪輯，該看得到", () => {
    const ks = keeps([{ src: [0, 5000] }, { src: [60_000, 65_000] }]);
    const b = arrangementBlocks(ks, outMsOf(ks));
    expect(b).toHaveLength(2);
    expect(b[1].srcStartMs).toBe(60_000);
  });

  it("搬移：來源往回跳一定斷開", () => {
    const ks = keeps([{ src: [10_000, 14_000] }, { src: [0, 4000] }]);
    const b = arrangementBlocks(ks, outMsOf(ks));
    expect(b).toHaveLength(2);
    expect(b.map((x) => x.srcStartMs)).toEqual([10_000, 0]);
    // 成品位置照 outStart 換算成 0..1
    expect(b[0].x).toBe(0);
    expect(b[1].x).toBeCloseTo(0.5, 6);
    expect(b[0].w).toBeCloseTo(0.5, 6);
  });

  it("貼上的那一塊標得出來，而且不會跟旁邊的合併", () => {
    const ks = keeps([
      { src: [0, 4000] },
      { src: [4000, 6000], pasteId: "p1" }, // 來源接得上，但它是貼上來的
      { src: [4000, 8000] },
    ]);
    const b = arrangementBlocks(ks, outMsOf(ks));
    expect(b).toHaveLength(3);
    expect(b.map((x) => x.pasteId)).toEqual([undefined, "p1", undefined]);
  });

  it("同一次貼上被切成兩段時要合併成一塊", () => {
    const ks = keeps([
      { src: [0, 2000] },
      { src: [5000, 6000], pasteId: "p1" },
      { src: [6200, 7000], pasteId: "p1" },
    ]);
    const b = arrangementBlocks(ks, outMsOf(ks));
    expect(b).toHaveLength(2);
    expect(b[1].pasteId).toBe("p1");
    expect(b[1].keepCount).toBe(2);
    expect(b[1].srcEndMs).toBe(7000);
  });

  it("空的 / 沒有長度的不會爆", () => {
    expect(arrangementBlocks([], 1000)).toEqual([]);
    expect(arrangementBlocks(keeps([{ src: [0, 1000] }]), 0)).toEqual([]);
  });

  it("區塊加起來剛好蓋滿整條（沒有縫也沒有超出去）", () => {
    const ks = keeps([{ src: [10_000, 14_000] }, { src: [0, 4000] }, { src: [20_000, 26_000] }]);
    const b = arrangementBlocks(ks, outMsOf(ks));
    expect(b[0].x).toBe(0);
    for (let i = 1; i < b.length; i++) expect(b[i].x).toBeCloseTo(b[i - 1].x + b[i - 1].w, 9);
    const last = b[b.length - 1];
    expect(last.x + last.w).toBeCloseTo(1, 9);
  });
});

describe("worthShowing", () => {
  it("沒剪過的檔案只有一塊 —— 畫出來是一條實心橫條，不給資訊", () => {
    const ks = keeps([{ src: [0, 30_000] }]);
    expect(worthShowing(arrangementBlocks(ks, outMsOf(ks)))).toBe(false);
  });

  it("剪過就值得看", () => {
    const ks = keeps([{ src: [0, 5000] }, { src: [60_000, 65_000] }]);
    expect(worthShowing(arrangementBlocks(ks, outMsOf(ks)))).toBe(true);
  });

  it("整集只貼了一塊（其餘完整保留）也值得看", () => {
    const ks = keeps([{ src: [0, 30_000], pasteId: "p1" }]);
    expect(worthShowing(arrangementBlocks(ks, outMsOf(ks)))).toBe(true);
  });
});

describe("x / w 是從 outStartMs 直接換算的", () => {
  it("成品時間中間有洞（gap 接點的 room tone）時，後面的區塊不會往左縮", () => {
    // 手工排出「第二塊之前插了 1 秒留白」的 out 時間
    const ks: KeepSegment[] = [
      { id: 0, srcStartMs: 0, srcEndMs: 4000, outStartMs: 0, outEndMs: 4000, gainDb: 0 },
      { id: 1, srcStartMs: 30_000, srcEndMs: 35_000, outStartMs: 5000, outEndMs: 10_000, gainDb: 0 },
    ];
    const b = arrangementBlocks(ks, 10_000);
    expect(b).toHaveLength(2);
    expect(b[0].x).toBe(0);
    expect(b[0].w).toBeCloseTo(0.4, 9);
    // 第二塊必須落在 0.5，不是接在第一塊後面的 0.4 ——
    // 播放線是照成品時間絕對定位的，兩者要用同一個座標系
    expect(b[1].x).toBeCloseTo(0.5, 9);
    expect(b[1].w).toBeCloseTo(0.5, 9);
  });
});
