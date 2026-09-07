import { describe, expect, it } from "vitest";
import { averageHeight, windowFor, type VirtualInput } from "./virtual";

function inp(over: Partial<VirtualInput> = {}): VirtualInput {
  return { count: 100, heights: [], estimate: 50, scrollTop: 0, viewportHeight: 500, overscan: 0, ...over };
}

describe("windowFor", () => {
  it("空清單什麼都不畫", () => {
    const w = windowFor(inp({ count: 0 }));
    expect(w).toEqual({ start: 0, end: 0, padTop: 0, padBottom: 0, totalHeight: 0 });
  });

  it("捲到最上面：從第 0 列開始，剛好畫滿視窗", () => {
    const w = windowFor(inp());
    expect(w.start).toBe(0);
    expect(w.end).toBe(10); // 500 / 50
    expect(w.padTop).toBe(0);
    expect(w.padBottom).toBe(90 * 50);
    expect(w.totalHeight).toBe(100 * 50);
  });

  it("墊片加上畫出來的列，高度總和永遠等於總高", () => {
    for (const scrollTop of [0, 137, 1000, 2500, 4999]) {
      const w = windowFor(inp({ scrollTop, overscan: 3 }));
      const drawn = (w.end - w.start) * 50;
      expect(w.padTop + drawn + w.padBottom).toBe(w.totalHeight);
    }
  });

  it("捲到中間：只畫看得到的那一段", () => {
    const w = windowFor(inp({ scrollTop: 1000 }));
    expect(w.start).toBe(20);
    expect(w.end).toBe(30);
    expect(w.padTop).toBe(1000);
  });

  it("overscan 讓前後各多畫幾列，但墊片跟著縮", () => {
    const a = windowFor(inp({ scrollTop: 1000, overscan: 0 }));
    const b = windowFor(inp({ scrollTop: 1000, overscan: 4 }));
    expect(b.start).toBe(a.start - 4);
    expect(b.end).toBe(a.end + 4);
    expect(b.padTop).toBe(a.padTop - 4 * 50);
  });

  it("最上面往上 overscan 不會變成負的", () => {
    const w = windowFor(inp({ scrollTop: 0, overscan: 5 }));
    expect(w.start).toBe(0);
    expect(w.padTop).toBe(0);
  });

  it("捲到底：畫到最後一列，下墊片是 0", () => {
    const w = windowFor(inp({ scrollTop: 100 * 50 - 500 }));
    expect(w.end).toBe(100);
    expect(w.padBottom).toBe(0);
  });

  it("捲動位置超出總高（清單被篩短了）→ 夾回範圍內而不是畫空白", () => {
    const w = windowFor(inp({ count: 5, scrollTop: 99999 }));
    expect(w.end).toBe(5);
    expect(w.start).toBeLessThan(5);
    expect(w.padBottom).toBe(0);
  });

  it("量到的列用實際高度，沒量到的用估計值", () => {
    // 前 3 列各 200 高，其餘估 50
    const heights = [200, 200, 200];
    const w = windowFor(inp({ heights, viewportHeight: 300, scrollTop: 0 }));
    expect(w.start).toBe(0);
    expect(w.end).toBe(2); // 200 + 200 就蓋滿 300 了
    expect(w.totalHeight).toBe(200 * 3 + 97 * 50);
  });

  it("實際高度會讓捲動位置算對（不是用估計值硬除）", () => {
    const heights = Array.from({ length: 100 }, (_, i) => (i < 10 ? 200 : undefined));
    const w = windowFor(inp({ heights, scrollTop: 2000, viewportHeight: 100 }));
    // 前 10 列共 2000 高 → 剛好從第 10 列開始
    expect(w.start).toBe(10);
    expect(w.padTop).toBe(2000);
  });

  it("視窗高度還沒量到（第一次繪製）也要畫幾列出來給人量", () => {
    const w = windowFor(inp({ viewportHeight: 0, overscan: 8 }));
    expect(w.end).toBeGreaterThan(0);
    expect(w.start).toBe(0);
    expect(w.padTop + (w.end - w.start) * 50 + w.padBottom).toBe(w.totalHeight);
  });

  it("estimate 是 0 也不會除以零 / 無窮迴圈", () => {
    const w = windowFor(inp({ estimate: 0, count: 3 }));
    expect(w.end).toBeLessThanOrEqual(3);
    expect(Number.isFinite(w.totalHeight)).toBe(true);
  });

  it("只有一列時 start 不會超出範圍", () => {
    const w = windowFor(inp({ count: 1, scrollTop: 5000 }));
    expect(w.start).toBe(0);
    expect(w.end).toBe(1);
  });
});

describe("averageHeight", () => {
  it("一列都還沒量到就用 fallback", () => {
    expect(averageHeight([], 72)).toBe(72);
    expect(averageHeight([undefined, undefined], 72)).toBe(72);
  });

  it("只算量到的那幾列", () => {
    expect(averageHeight([100, undefined, 200], 72)).toBe(150);
  });

  it("0 或負的高度不算（還沒佈局的列會量到 0）", () => {
    expect(averageHeight([0, 100], 72)).toBe(100);
  });
});
