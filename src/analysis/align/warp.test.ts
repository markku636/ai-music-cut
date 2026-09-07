import { describe, expect, it } from "vitest";
import { applyTightness, pathToWarp, resampleOnly, simplifyWarp, straightenSilence, summarizeWarp, warpAt, warpSegments, type WarpPoint } from "./warp";

const pts = (list: [number, number][]): WarpPoint[] => list.map(([dubMs, guideMs]) => ({ dubMs, guideMs }));

describe("pathToWarp / warpAt", () => {
  it("同一個 i 或 j 連續出現只留第一個；warpAt 線性內插與外推", () => {
    const w = pathToWarp(
      [
        [0, 0],
        [1, 1],
        [1, 2],
        [2, 3],
        [3, 3],
      ],
      10,
      10,
    );
    expect(w).toEqual(pts([[0, 0], [10, 10], [30, 20]]));
    expect(warpAt(w, 20)).toBeCloseTo(15, 6);
    expect(warpAt(w, 50)).toBeCloseTo(30, 6);
    expect(warpAt(w, -10)).toBeCloseTo(-10, 6);
  });
});

describe("applyTightness", () => {
  // dev = guide − dub：100, 130, 80, 80, 130, 100（左右對稱 → 直線斜率 0、截距 = 平均 103.33）
  const base = pts([[0, 100], [1000, 1130], [2000, 2080], [3000, 3080], [4000, 4130], [5000, 5100]]);
  const c = (100 + 130 + 80 + 80 + 130 + 100) / 6;
  it("T=0 == 只剩趨勢（沒漂移時就是全域位移）", () => {
    const r = applyTightness(base, 0);
    const devs = r.map((p) => p.guideMs - p.dubMs);
    expect(devs.every((d) => Math.abs(d - c) < 1e-6)).toBe(true);
  });
  it("T=0 保留線性漂移（每小時 2 秒的斜率不會被削掉）", () => {
    const list: WarpPoint[] = [];
    for (let t = 0; t <= 600_000; t += 30_000) list.push({ dubMs: t, guideMs: 300 + t * (1 + 2 / 3600) + (t % 60_000 === 0 ? 15 : -15) });
    const r = applyTightness(list, 0);
    const s = summarizeWarp(r);
    expect(s.slope).toBeCloseTo(1 + 2 / 3600, 6);
    expect(s.maxResidualMs).toBeLessThan(1e-6);
  });
  it("T=100 原封不動", () => {
    const r = applyTightness(base, 100);
    for (let i = 0; i < base.length; i++) {
      expect(r[i].dubMs).toBe(base[i].dubMs);
      expect(r[i].guideMs).toBeCloseTo(base[i].guideMs, 6);
    }
  });
  it("中間值：殘差變小但方向不變", () => {
    const r = applyTightness(base, 60);
    const before = base.map((p) => p.guideMs - p.dubMs - c);
    const after = r.map((p) => p.guideMs - p.dubMs - c);
    for (let i = 0; i < before.length; i++) {
      expect(Math.abs(after[i])).toBeLessThanOrEqual(Math.abs(before[i]) + 1e-6);
      if (Math.abs(before[i]) > 1e-6) expect(Math.sign(after[i]) === Math.sign(before[i]) || Math.abs(after[i]) < 1e-6).toBe(true);
    }
  });
  it("保持單調（性質測試）", () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let k = 0; k < 50; k++) {
      const list: WarpPoint[] = [];
      let d = 0;
      let g = 200;
      for (let i = 0; i < 40; i++) {
        d += 50 + rnd() * 200;
        g += 50 + rnd() * 200;
        list.push({ dubMs: d, guideMs: g });
      }
      const r = applyTightness(list, Math.floor(rnd() * 101));
      for (let i = 1; i < r.length; i++) {
        expect(r[i].dubMs).toBeGreaterThan(r[i - 1].dubMs);
        expect(r[i].guideMs).toBeGreaterThanOrEqual(r[i - 1].guideMs);
      }
    }
  });
});

describe("straightenSilence / simplifyWarp", () => {
  it("兩邊都安靜 ≥ 150 ms 的段落只留頭尾", () => {
    const list = pts([[0, 0], [100, 100], [200, 210], [300, 205], [400, 215], [500, 500], [600, 600]]);
    const quiet = (p: WarpPoint) => p.dubMs >= 100 && p.dubMs <= 400;
    const r = straightenSilence(list, quiet, 150);
    expect(r.map((p) => p.dubMs)).toEqual([0, 100, 400, 500, 600]);
  });
  it("Douglas-Peucker 留下轉折點", () => {
    const list = pts([[0, 0], [100, 100], [200, 200], [300, 350], [400, 450], [500, 550]]);
    const r = simplifyWarp(list, 5);
    expect(r.map((p) => p.dubMs)).toEqual([0, 200, 300, 500]);
    expect(simplifyWarp(list, 1000).length).toBe(2);
  });
});

describe("warpSegments", () => {
  it("速率 = Δguide/Δdub，短段併進前一段重算、量化、夾限、相鄰同速率合併", () => {
    const list = pts([[0, 0], [1000, 1100], [2000, 2200], [2100, 2400], [3000, 3300]]);
    const segs = warpSegments(list, { minSegMs: 250, rateQuant: 0.005, clamp: [0.5, 2] });
    // 0–1000 與 1000–2000 都是 1.1；2000–2100 只有 100 ms 併進 1000–2000 → (1100+200)/1100 = 1.18；2100–3000 = 1.0
    expect(segs).toEqual([
      { dubStartMs: 0, dubEndMs: 1000, rate: 1.1 },
      { dubStartMs: 1000, dubEndMs: 2100, rate: 1.18 },
      { dubStartMs: 2100, dubEndMs: 3000, rate: 1 },
    ]);
    const same = pts([[0, 0], [1000, 1100], [2000, 2200], [3000, 3300]]);
    expect(warpSegments(same)).toEqual([{ dubStartMs: 0, dubEndMs: 3000, rate: 1.1 }]);
    const wild = pts([[0, 0], [1000, 5000], [2000, 5100]]);
    const s2 = warpSegments(wild);
    expect(s2[0].rate).toBe(2);
    expect(s2[1].rate).toBe(0.5);
  });
});

describe("summarizeWarp / resampleOnly", () => {
  it("每小時漂 2 秒 = 斜率 1.00056，殘差小 → 純重取樣", () => {
    const list: WarpPoint[] = [];
    for (let t = 0; t <= 3_600_000; t += 60_000) list.push({ dubMs: t, guideMs: 500 + t * (1 + 2 / 3600) });
    const s = summarizeWarp(list);
    expect(s.offsetMs).toBeGreaterThan(500);
    expect(s.slope).toBeCloseTo(1 + 2 / 3600, 8);
    expect(s.maxResidualMs).toBeLessThan(1);
    expect(resampleOnly(s)).toBeCloseTo(1 + 2 / 3600, 8);
  });
  it("有真正的伸縮變化就不能只重取樣；沒漂移也回 null", () => {
    const list = pts([[0, 0], [1000, 1000], [2000, 2100], [3000, 3100]]);
    expect(resampleOnly(summarizeWarp(list))).toBeNull();
    const flat = pts([[0, 100], [1000, 1100], [2000, 2100]]);
    expect(resampleOnly(summarizeWarp(flat))).toBeNull();
  });
});
