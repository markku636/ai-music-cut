import { describe, expect, it } from "vitest";
import { addLines, gainLine, loudnessFraction, loudnessLine, quietShare, SILENT_LUFS } from "./loudnessLine";

/** 造 n 個視窗，第 i 個的 shortTerm 由 f(i) 決定。 */
function win(n: number, f: (i: number) => number): Float32Array {
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = f(i); // momentary（這裡用不到）
    a[i * 3 + 1] = f(i); // shortTerm
    a[i * 3 + 2] = -30;
  }
  return a;
}

describe("loudnessLine", () => {
  it("壓到指定寬度，每格取那一段的中位數", () => {
    // 10 個視窗壓成 2 格：前 5 個是 -20，後 5 個是 -30
    const line = loudnessLine(win(10, (i) => (i < 5 ? -20 : -30)), 10, 2);
    expect(line).toHaveLength(2);
    expect(line[0]).toBe(-20);
    expect(line[1]).toBe(-30);
  });

  it("停頓不會把那一格拉下去 —— 用中位數不是平均", () => {
    // 一格裡 4 個 -20 加一個靜音：平均會被拉到 -30 左右，中位仍是 -20
    const line = loudnessLine(win(5, (i) => (i === 2 ? -70 : -20)), 5, 1);
    expect(line[0]).toBe(-20);
  });

  it("整段偏小聲要畫成偏小聲 —— 不是取最大值", () => {
    const line = loudnessLine(win(5, () => -28), 5, 1);
    expect(line[0]).toBe(-28);
  });

  it("完全沒有聲音的那一格是 NaN（呼叫端不要畫）", () => {
    const line = loudnessLine(win(4, () => SILENT_LUFS - 5), 4, 2);
    expect(Number.isNaN(line[0])).toBe(true);
    expect(Number.isNaN(line[1])).toBe(true);
  });

  it("視窗比像素少也不會漏格", () => {
    const line = loudnessLine(win(2, () => -18), 2, 8);
    expect(line).toHaveLength(8);
    expect([...line].every((v) => v === -18)).toBe(true);
  });

  it("空的不會爆", () => {
    expect(loudnessLine(new Float32Array(0), 0, 5)).toHaveLength(5);
    expect(loudnessLine(win(3, () => -20), 3, 0)).toHaveLength(1);
  });
});

describe("loudnessFraction", () => {
  it("目標比 0.5 高一點（上面刻意留少一點）", () => {
    const at = loudnessFraction(-16, -16);
    expect(at).toBeGreaterThan(0.5);
    expect(at).toBeLessThan(0.9);
  });

  it("越小聲越低、越大聲越高，而且夾在 0..1", () => {
    expect(loudnessFraction(-40, -16)).toBe(0);
    expect(loudnessFraction(-4, -16)).toBe(1);
    expect(loudnessFraction(-20, -16)).toBeLessThan(loudnessFraction(-16, -16));
  });

  it("NaN 進 NaN 出", () => {
    expect(Number.isNaN(loudnessFraction(NaN, -16))).toBe(true);
  });
});

describe("quietShare", () => {
  it("算的是有聲的部分裡有多少明顯低於目標", () => {
    const line = Float32Array.from([-16, -16, -22, -22, NaN, NaN]);
    // 有聲 4 格、其中 2 格低於 -19
    expect(quietShare(line, -16)).toBeCloseTo(0.5, 6);
  });

  it("差一點點不算 —— 3 LU 才是聽得出來的門檻", () => {
    expect(quietShare(Float32Array.from([-18, -18]), -16)).toBe(0);
    expect(quietShare(Float32Array.from([-20, -20]), -16)).toBe(1);
  });

  it("整段沒有聲音時回 0，不要除以 0", () => {
    expect(quietShare(Float32Array.from([NaN, NaN]), -16)).toBe(0);
  });
});

describe("gainLine", () => {
  const units = [
    { startMs: 0, endMs: 1000 },
    { startMs: 1000, endMs: 2000 },
  ];

  it("每個像素拿到它所屬單元的增益", () => {
    const g = gainLine(units, [3, -2], 2000, 4);
    expect([...g]).toEqual([3, 3, -2, -2]);
  });

  it("取像素中心而不是左緣 —— 邊界落在像素上時不會歸錯邊", () => {
    // 兩個單元、寬度 2：像素中心是 500 與 1500，各自落在正確的單元裡
    expect([...gainLine(units, [5, -5], 2000, 2)]).toEqual([5, -5]);
  });

  it("沒有單元覆蓋的像素是 NaN（剪掉了 / 靜音）", () => {
    const g = gainLine([{ startMs: 0, endMs: 500 }], [4], 2000, 4);
    expect(g[0]).toBe(4);
    expect(Number.isNaN(g[1])).toBe(true);
    expect(Number.isNaN(g[3])).toBe(true);
  });

  it("空的 / 長度 0 不會爆", () => {
    expect([...gainLine([], [], 1000, 3)].every(Number.isNaN)).toBe(true);
    expect([...gainLine(units, [1, 2], 0, 3)].every(Number.isNaN)).toBe(true);
  });

  it("增益少給的話當成 0，不要變成 undefined", () => {
    expect([...gainLine(units, [3], 2000, 2)]).toEqual([3, 0]);
  });
});

describe("addLines", () => {
  it("相加；任一邊 NaN 就是 NaN", () => {
    const r = addLines(Float32Array.from([-22, -20, NaN]), Float32Array.from([6, NaN, 3]));
    expect(r[0]).toBe(-16);
    expect(Number.isNaN(r[1])).toBe(true);
    expect(Number.isNaN(r[2])).toBe(true);
  });
});
