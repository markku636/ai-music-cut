import { describe, expect, it } from "vitest";
import { isVisibleX, pageScroll, playheadX } from "./playhead";

describe("playheadX", () => {
  it("時間 × px/s 減掉捲動量", () => {
    expect(playheadX(2000, 100, 0)).toBe(200);
    expect(playheadX(2000, 100, 150)).toBe(50);
  });

  it("跟拍線用同一組公式：同一個時間點算出同一個 x", () => {
    const px = 300;
    const scroll = 1234.5;
    const ms = 4321;
    const beatX = (ms / 1000) * px - scroll; // BeatGridOverlay 的算法
    expect(playheadX(ms, px, scroll)).toBeCloseTo(beatX, 10);
  });
});

describe("isVisibleX", () => {
  it("含邊界（pad）", () => {
    expect(isVisibleX(-2, 800)).toBe(true);
    expect(isVisibleX(-3, 800)).toBe(false);
    expect(isVisibleX(802, 800)).toBe(true);
    expect(isVisibleX(803, 800)).toBe(false);
  });
});

describe("pageScroll", () => {
  const W = 800;

  it("線還沒到右緣就不捲（不會每幀寫 setScroll）", () => {
    expect(pageScroll(400, W, 0, 5000)).toBeNull();
    expect(pageScroll(W * 0.88, W, 0, 5000)).toBeNull();
  });

  it("越過 88% 就往前翻 80% 一頁", () => {
    expect(pageScroll(W * 0.9, W, 0, 5000)).toBeCloseTo(640, 6);
  });

  it("翻頁不會超過內容尾端", () => {
    expect(pageScroll(W * 0.95, W, 4900, 5000)).toBe(5000);
    // 已經在底了 → 不再回報捲動
    expect(pageScroll(W * 0.95, W, 5000, 5000)).toBeNull();
  });

  it("往回 seek 出左邊界 → 把線帶回左側 1/8 處", () => {
    const next = pageScroll(-300, W, 1000, 5000);
    expect(next).toBeCloseTo(1000 - 300 - 100, 6);
    expect(next).toBeGreaterThanOrEqual(0);
  });

  it("捲不到負數", () => {
    expect(pageScroll(-300, W, 50, 5000)).toBe(0);
  });

  it("寬度為 0（面板收起 / 尚未量到）時不動作", () => {
    expect(pageScroll(10, 0, 0, 5000)).toBeNull();
  });
});
