import { describe, expect, it } from "vitest";
import type { BeatGrid } from "./beats";
import { ALL_SNAP, collectTargets, snapValue, toleranceMs, type SnapContext } from "./snap";

const grid = (bpm: number, offsetMs = 0): BeatGrid => ({
  bpm,
  periodMs: 60000 / bpm,
  offsetMs,
  confidence: 0.5,
  beatsPerBar: 4,
  beats: [],
});

function ctx(over: Partial<SnapContext> = {}): SnapContext {
  return { enabled: true, targets: [], grid: null, tolMs: 100, ...over };
}

describe("snapValue", () => {
  it("關掉就原樣回傳", () => {
    const c = ctx({ enabled: false, targets: [{ ms: 500, kind: "seam" }] });
    expect(snapValue(505, c)).toEqual({ ms: 505, kind: null });
  });

  it("容差外不吸", () => {
    const c = ctx({ targets: [{ ms: 500, kind: "seam" }], tolMs: 10 });
    expect(snapValue(520, c).kind).toBeNull();
    expect(snapValue(508, c)).toEqual({ ms: 500, kind: "seam" });
  });

  it("同一類目標取最近", () => {
    const c = ctx({
      targets: [
        { ms: 480, kind: "word" },
        { ms: 520, kind: "word" },
      ],
    });
    expect(snapValue(505, c)).toEqual({ ms: 520, kind: "word" });
    expect(snapValue(495, c)).toEqual({ ms: 480, kind: "word" });
  });

  it("結構性邊界在差不多近的時候贏過字界", () => {
    // 中文沒空格，字界密到每 220 ms 一個 —— 純比距離的話永遠吸到字界。
    // 量過：站在既有接縫旁 30 ms 拖，36/100 會被字界搶走。
    const c = ctx({
      targets: [
        { ms: 480, kind: "word" },
        { ms: 520, kind: "sentence" },
      ],
    });
    // 字界近 10 ms，但句界是使用者真正瞄準的東西
    expect(snapValue(495, c)).toEqual({ ms: 520, kind: "sentence" });
  });

  it("接縫贏過貼在鼻子上的字界（半個容差以內）", () => {
    const c = ctx({
      tolMs: 140,
      targets: [
        { ms: 1000, kind: "seam" },
        { ms: 1029, kind: "word" },
      ],
    });
    // 離接縫 30 ms、離字界 1 ms —— 使用者是瞄著那一刀去的
    expect(snapValue(1030, c)).toEqual({ ms: 1000, kind: "seam" });
  });

  it("但差太遠的結構性邊界不會硬拉過去", () => {
    const c = ctx({
      tolMs: 140,
      targets: [
        { ms: 1000, kind: "seam" },
        { ms: 1100, kind: "word" },
      ],
    });
    // 離接縫 101 ms（超過半個容差）、離字界 1 ms → 字界贏，不會被拉走 100 ms
    expect(snapValue(1101, c)).toEqual({ ms: 1100, kind: "word" });
  });

  it("同距離時越結構性的邊界越優先（接縫 > 句界 > 字界）", () => {
    const c = ctx({
      targets: [
        { ms: 490, kind: "word" },
        { ms: 490, kind: "seam" },
        { ms: 490, kind: "sentence" },
      ],
    });
    expect(snapValue(500, c).kind).toBe("seam");
  });

  it("拍點用公式算，不需要展開成陣列", () => {
    const c = ctx({ grid: grid(120), tolMs: 100 }); // 一拍 500 ms
    expect(snapValue(1480, c)).toEqual({ ms: 1500, kind: "beat" });
    expect(snapValue(1200, c).kind).toBeNull(); // 離最近的拍 200 ms，超過容差
  });

  it("接縫比拍點近的時候吸接縫", () => {
    const c = ctx({ grid: grid(120), targets: [{ ms: 1470, kind: "seam" }], tolMs: 100 });
    expect(snapValue(1475, c)).toEqual({ ms: 1470, kind: "seam" });
  });
});

describe("collectTargets", () => {
  const src = {
    seams: [1000],
    sentences: [{ startMs: 0, endMs: 800 }],
    words: [{ startMs: 100, endMs: 300 }],
    playheadMs: 2000,
    durationMs: 5000,
  };

  it("收集句界與字界的兩端", () => {
    const t = collectTargets(src, ALL_SNAP);
    expect(t).toContainEqual({ ms: 0, kind: "sentence" });
    expect(t).toContainEqual({ ms: 800, kind: "sentence" });
    expect(t).toContainEqual({ ms: 100, kind: "word" });
    expect(t).toContainEqual({ ms: 300, kind: "word" });
    expect(t).toContainEqual({ ms: 1000, kind: "seam" });
    expect(t).toContainEqual({ ms: 2000, kind: "playhead" });
    expect(t).toContainEqual({ ms: 5000, kind: "bound" });
  });

  it("個別類型可以關掉", () => {
    const t = collectTargets(src, { ...ALL_SNAP, words: false, seams: false });
    expect(t.some((x) => x.kind === "word")).toBe(false);
    expect(t.some((x) => x.kind === "seam")).toBe(false);
    expect(t.some((x) => x.kind === "sentence")).toBe(true);
  });

  it("頭尾永遠在（拖到 0 或結尾要停得住）", () => {
    expect(collectTargets({}, ALL_SNAP)).toContainEqual({ ms: 0, kind: "bound" });
  });
});

describe("toleranceMs", () => {
  it("縮放越大吸得越準", () => {
    expect(toleranceMs(10)).toBe(140); // 很遠的縮放 → 夾在上限
    expect(toleranceMs(100)).toBeCloseTo(80, 6);
    expect(toleranceMs(500)).toBeCloseTo(16, 6);
  });

  it("縮放無效時退回上限", () => {
    expect(toleranceMs(0)).toBe(140);
    expect(toleranceMs(Number.NaN)).toBe(140);
  });
});
