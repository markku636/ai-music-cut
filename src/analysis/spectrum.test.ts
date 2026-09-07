import { describe, expect, it } from "vitest";
import { findHum, HUM_PROMINENCE_DB, suggestedHarmonics, type SpectrumData } from "./spectrum";

/** 合成一份頻譜：底 −90 dB 平坦，指定頻率放峰。 */
function spectrum(peaks: Record<number, number>, n = 8192, sr = 48_000): SpectrumData {
  const db = new Float32Array(n / 2 + 1).fill(-90);
  for (const [hz, v] of Object.entries(peaks)) db[Math.round((Number(hz) * n) / sr)] = v;
  return { sample_rate: sr, n, db, frames: 10 };
}

describe("findHum", () => {
  it("60 Hz 加四個諧波 → 60，諧波數 4", () => {
    const r = findHum(spectrum({ 60: -30, 120: -40, 180: -50, 240: -55 }));
    expect(r.baseHz).toBe(60);
    expect(r.harmonics).toBe(4);
    expect(r.prominenceDb).toBeGreaterThanOrEqual(HUM_PROMINENCE_DB);
    expect(r.summary).toContain("60 Hz");
    expect(suggestedHarmonics(r)).toBe(4);
  });
  it("50 Hz 系列 → 50", () => {
    const r = findHum(spectrum({ 50: -35, 100: -45, 150: -55, 200: -60, 250: -70 }));
    expect(r.baseHz).toBe(50);
    expect(suggestedHarmonics(r)).toBe(5);
  });
  it("只有基頻沒有諧波 → 不是嗡聲（可能只是低頻的聲音）", () => {
    const r = findHum(spectrum({ 60: -20 }));
    expect(r.baseHz).toBeNull();
    expect(r.summary).toContain("沒有偵測到");
    expect(suggestedHarmonics(r)).toBe(4);
  });
  it("平的頻譜 → null", () => {
    expect(findHum(spectrum({})).baseHz).toBeNull();
  });
  it("峰不夠突出（只高 6 dB）→ null", () => {
    expect(findHum(spectrum({ 60: -84, 120: -84, 180: -84 })).baseHz).toBeNull();
  });
  it("解析度太粗（bin > 4 Hz）就不判", () => {
    const r = findHum(spectrum({ 60: -30, 120: -40, 180: -50 }, 1024));
    expect(r.baseHz).toBeNull();
    expect(r.summary).toContain("解析度");
  });
  it("60 Hz 的第 2 諧波 120 也是 50 Hz 系列不會誤判：諧波數多的贏", () => {
    // 60/120/180/240 四個都在；50 系列只有 100（≠120）… 這裡 100/150 沒有峰
    const r = findHum(spectrum({ 60: -30, 120: -38, 180: -46, 240: -52, 300: -58 }));
    expect(r.baseHz).toBe(60);
  });
});
