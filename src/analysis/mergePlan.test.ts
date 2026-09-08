import { describe, expect, it } from "vitest";
import { effectiveJoinMs, mergeChannels, mergeOutPath, mergeTotalMs, moveItem, normalizeGains, type MergeItem } from "./mergePlan";

const item = (id: string, durationMs: number, lufs: number | null = null): MergeItem => ({ id, path: `${id}.wav`, name: id, durationMs, lufs, gainDb: 0 });

describe("effectiveJoinMs / mergeChannels", () => {
  it("交越夾在最短檔的一半；留白不夾", () => {
    const items = [item("a", 10_000), item("b", 1_000), item("c", 8_000)];
    expect(effectiveJoinMs(items, "crossfade", 3000)).toBe(500);
    expect(effectiveJoinMs(items, "crossfade", 120)).toBe(120);
    expect(effectiveJoinMs(items, "gap", 3000)).toBe(3000);
    expect(effectiveJoinMs([item("a", 10_000)], "crossfade", 3000)).toBe(3000);
  });
  it("聲道 auto：有立體聲就 2，否則 1", () => {
    expect(mergeChannels([{ channels: 1 }, {}], "auto")).toBe(1);
    expect(mergeChannels([{ channels: 1 }, { channels: 2 }], "auto")).toBe(2);
    expect(mergeChannels([{ channels: 2 }], "1")).toBe(1);
    expect(mergeChannels([{ channels: 1 }], "2")).toBe(2);
  });
});

describe("mergeTotalMs", () => {
  it("gap 加 (N−1)·gap，crossfade 減 (N−1)·交越", () => {
    const items = [item("a", 10_000), item("b", 5_000), item("c", 8_000)];
    expect(mergeTotalMs(items, "gap", 500)).toBe(24_000);
    expect(mergeTotalMs(items, "gap", 0)).toBe(23_000);
    expect(mergeTotalMs(items, "crossfade", 120)).toBe(23_000 - 240);
  });
  it("很短的檔不會被交越吃光（與 EDL 同一條夾限）", () => {
    const items = [item("a", 10_000), item("b", 100), item("c", 10_000)];
    // 100 ms 的檔兩邊各最多吃 50 ms
    expect(mergeTotalMs(items, "crossfade", 1000)).toBe(20_100 - 50 - 50);
  });
  it("隨機不變式：total ≥ Σdur − (N−1)·xf 且 ≤ Σdur + (N−1)·gap", () => {
    let seed = 7;
    const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let k = 0; k < 200; k++) {
      const n = 2 + Math.floor(r() * 6);
      const items = Array.from({ length: n }, (_, i) => item(`i${i}`, 20 + Math.floor(r() * 20_000)));
      const sum = items.reduce((a, b) => a + b.durationMs, 0);
      const xf = Math.floor(r() * 2000);
      const gap = Math.floor(r() * 2000);
      expect(mergeTotalMs(items, "crossfade", xf)).toBeGreaterThanOrEqual(sum - (n - 1) * xf);
      expect(mergeTotalMs(items, "crossfade", xf)).toBeLessThanOrEqual(sum);
      expect(mergeTotalMs(items, "gap", gap)).toBe(sum + (n - 1) * gap);
    }
  });
});

describe("normalizeGains", () => {
  it("以量得到的檔的平均為基準補差，量不到的 0", () => {
    expect(normalizeGains([item("a", 1, -16), item("b", 1, -20), item("c", 1, null)])).toEqual([-2, 2, 0]);
  });
  it("只有一個量得到 → 全 0（沒有可比的基準）", () => {
    expect(normalizeGains([item("a", 1, -16), item("b", 1, null)])).toEqual([0, 0]);
  });
  it("夾在 ±12", () => {
    expect(normalizeGains([item("a", 1, -10), item("b", 1, -50)])).toEqual([-12, 12]);
  });
});

describe("helpers", () => {
  it("mergeOutPath 放在第一個檔旁邊", () => {
    expect(mergeOutPath("C:\\music\\a.mp3")).toBe("C:\\music\\a_merged.wav");
    expect(mergeOutPath("/x/y/b.flac")).toBe("/x/y/b_merged.wav");
  });
  it("moveItem 上下移，越界不動", () => {
    expect(moveItem([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
    expect(moveItem([1, 2, 3], 2, 0)).toEqual([3, 1, 2]);
    expect(moveItem([1, 2, 3], 2, 3)).toEqual([1, 2, 3]);
  });
});
