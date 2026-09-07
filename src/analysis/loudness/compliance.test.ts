import { describe, expect, it } from "vitest";
import { checkCompliance, explainMiss } from "./compliance";

describe("compliance", () => {
  it("達標 → ok", () => {
    const r = checkCompliance({ outputLufs: -16.2, outputTp: -1.6, targetLufs: -16 });
    expect(r.level).toBe("ok");
    expect(r.summary).toContain("達標");
  });
  it("差 1 LU → warn；差 3 LU → fail", () => {
    expect(checkCompliance({ outputLufs: -17, outputTp: -1.6, targetLufs: -16 }).level).toBe("warn");
    expect(checkCompliance({ outputLufs: -19, outputTp: -1.6, targetLufs: -16 }).level).toBe("fail");
  });
  it("真實峰值超過 0 dBTP → fail", () => {
    expect(checkCompliance({ outputLufs: -16, outputTp: 0.4, targetLufs: -16 }).level).toBe("fail");
    expect(checkCompliance({ outputLufs: -16, outputTp: -0.5, targetLufs: -16 }).level).toBe("warn");
  });
  it("dynamic 模式會提醒", () => {
    const r = checkCompliance({ outputLufs: -16, outputTp: -1.6, targetLufs: -16, normalizationType: "dynamic" });
    expect(r.level).toBe("warn");
    expect(r.checks.some((c) => c.detail.includes("dynamic"))).toBe(true);
  });
  it("沒量到值 → warn 不當掉", () => {
    expect(checkCompliance({ outputLufs: null, outputTp: null, targetLufs: -16 }).level).toBe("warn");
  });
});

describe("explainMiss", () => {
  it("打到目標就不用解釋", () => {
    expect(explainMiss({ outputLufs: -16.2, outputTp: -1.6, targetLufs: -16 })).toBeNull();
  });

  it("**偏小聲又貼著峰值上限 = 被上限擋住的**，不是工具沒拉", () => {
    const r = explainMiss({ outputLufs: -17.3, outputTp: -1.5, targetLufs: -16 })!;
    expect(r.cause).toBe("headroom");
    expect(r.deltaLu).toBeCloseTo(-1.3, 5);
    expect(r.detail).toContain("dBTP");
  });

  it("偏小聲但峰值還有空間 = 另一回事（不要都推給上限）", () => {
    expect(explainMiss({ outputLufs: -19, outputTp: -8, targetLufs: -16 })!.cause).toBe("quiet");
  });

  it("比目標大聲", () => {
    expect(explainMiss({ outputLufs: -13, outputTp: -1.6, targetLufs: -16 })!.cause).toBe("too_loud");
  });

  it("沒量到響度就不猜原因", () => {
    expect(explainMiss({ outputLufs: null, outputTp: -1.5, targetLufs: -16 })).toBeNull();
  });

  it("峰值沒量到時不會誤判成被上限擋住", () => {
    expect(explainMiss({ outputLufs: -19, outputTp: null, targetLufs: -16 })!.cause).toBe("quiet");
  });

  it("上限可調（廣播規範用 -1 或 -2）", () => {
    expect(explainMiss({ outputLufs: -25, outputTp: -2.1, targetLufs: -23, truePeakDbtp: -2 })!.cause).toBe("headroom");
  });
});
