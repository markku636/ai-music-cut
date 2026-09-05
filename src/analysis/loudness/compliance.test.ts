import { describe, expect, it } from "vitest";
import { checkCompliance } from "./compliance";

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
