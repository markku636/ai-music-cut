import { describe, expect, it } from "vitest";
import { abGain } from "./cutPlayer";

describe("abGain（A-B 切換的等功率淡接）", () => {
  it("端點是 0 與 1", () => {
    expect(abGain(0, "in")).toBeCloseTo(0, 9);
    expect(abGain(1, "in")).toBeCloseTo(1, 9);
    expect(abGain(0, "out")).toBeCloseTo(1, 9);
    expect(abGain(1, "out")).toBeCloseTo(0, 9);
  });

  it("任何時刻兩邊的功率和恆為 1（線性會在中點凹一個洞）", () => {
    for (const p of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const a = abGain(p, "in");
      const b = abGain(p, "out");
      expect(a * a + b * b).toBeCloseTo(1, 9);
      // 對照：線性的中點只有 0.5²+0.5²=0.5，差 3 dB
    }
  });

  it("中點兩邊都是 1/√2（−3 dB），不是 0.5", () => {
    expect(abGain(0.5, "in")).toBeCloseTo(Math.SQRT1_2, 9);
    expect(abGain(0.5, "out")).toBeCloseTo(Math.SQRT1_2, 9);
  });

  it("超出範圍夾住", () => {
    expect(abGain(-1, "in")).toBeCloseTo(0, 9);
    expect(abGain(2, "in")).toBeCloseTo(1, 9);
  });
});
