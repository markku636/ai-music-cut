import { describe, expect, it } from "vitest";
import { bandedDtw, pathConfidence, straightCost } from "./dtw";

/** 一段合成「語音」能量：幾個高斯脈衝加底噪。 */
function signal(n: number, pulses: number[], width = 6): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0.05;
    for (const c of pulses) v += Math.exp(-((i - c) ** 2) / (2 * width * width));
    out[i] = Math.min(1, v);
  }
  return out;
}
const l1 = (a: Float32Array, b: Float32Array) => (i: number, j: number) => Math.abs(a[i] - b[j]);

describe("bandedDtw", () => {
  it("固定位移：路徑就是一條平移的對角線", () => {
    const n = 300;
    const a = signal(n, [40, 90, 150, 220, 270]);
    const b = signal(n + 20, [40 + 17, 90 + 17, 150 + 17, 220 + 17, 270 + 17]);
    const r = bandedDtw(n, b.length, { center: (i) => i + 17, halfWidth: 30, dist: l1(a, b) });
    expect(r.path[0]).toEqual([0, 17]);
    expect(r.path[r.path.length - 1]).toEqual([n - 1, n - 1 + 17]);
    // 幾乎全部是對角步
    const diag = r.path.filter(([i, j], k) => k === 0 || (i - r.path[k - 1][0] === 1 && j - r.path[k - 1][1] === 1)).length;
    expect(diag / r.path.length).toBeGreaterThan(0.95);
  });

  it("線性伸縮 1.03×：每段速率在 1 % 內", () => {
    const n = 400;
    const pulses = [30, 80, 140, 210, 260, 330, 380];
    const a = signal(n, pulses);
    const b = signal(Math.round(n * 1.03) + 2, pulses.map((p) => Math.round(p * 1.03)));
    const r = bandedDtw(n, b.length, { center: (i) => i * 1.03, halfWidth: 20, dist: l1(a, b), openEnd: true });
    // 取脈衝附近的路徑點看斜率
    for (const p of pulses.slice(1, -1)) {
      const at = r.path.find(([i]) => i === p)!;
      expect(Math.abs(at[1] - p * 1.03)).toBeLessThanOrEqual(3);
    }
  });

  it("分段速率 0.9 / 1.1：路徑跟著轉彎", () => {
    const n = 600;
    const a = signal(n, [40, 100, 160, 220, 280, 340, 400, 460, 520, 580]);
    // 前半 0.9（dub 較快 = 對應 dub 索引較小）、後半 1.1
    const map = (i: number) => (i < 300 ? i * 0.9 : 270 + (i - 300) * 1.1);
    const b = signal(Math.round(map(n)) + 5, [40, 100, 160, 220, 280, 340, 400, 460, 520, 580].map((p) => Math.round(map(p))));
    const r = bandedDtw(n, b.length, { center: (i) => i, halfWidth: 80, dist: l1(a, b), openEnd: true });
    const at = (i: number) => r.path.find(([x]) => x === i)![1];
    expect(Math.abs(at(160) - map(160))).toBeLessThanOrEqual(4);
    expect(Math.abs(at(460) - map(460))).toBeLessThanOrEqual(4);
  });

  it("帶不越界、斜率 ∈ [½, 2]（隨機輸入）", () => {
    let seed = 11;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let k = 0; k < 30; k++) {
      const n = 50 + Math.floor(rnd() * 200);
      const m = 50 + Math.floor(rnd() * 200);
      const a = new Float32Array(n).map(() => rnd());
      const b = new Float32Array(m).map(() => rnd());
      const W = 5 + Math.floor(rnd() * 30);
      const r = bandedDtw(n, m, { center: (i) => (i * m) / n, halfWidth: W, dist: l1(a, b), openBegin: true, openEnd: true });
      for (let p = 0; p < r.path.length; p++) {
        const [i, j] = r.path[p];
        expect(Math.abs(j - (i * m) / n)).toBeLessThanOrEqual(W + 1);
        if (p > 0) {
          const [pi, pj] = r.path[p - 1];
          const di = i - pi;
          const dj = j - pj;
          expect([`1,1`, `1,2`, `2,1`]).toContain(`${di},${dj}`);
        }
      }
    }
  });

  it("forceDiagonal 的列真的只走對角", () => {
    const n = 200;
    const a = signal(n, [30, 90, 150]);
    const b = signal(n + 30, [30, 100, 175]); // 後面越來越慢
    const r = bandedDtw(n, b.length, {
      center: (i) => i + Math.round((i / n) * 30),
      halfWidth: 40,
      dist: l1(a, b),
      openEnd: true,
      forceDiagonal: (i) => i >= 60 && i < 120,
    });
    for (let p = 1; p < r.path.length; p++) {
      const [i, j] = r.path[p];
      if (i > 60 && i < 120) expect([i - r.path[p - 1][0], j - r.path[p - 1][1]]).toEqual([1, 1]);
    }
  });

  it("openBegin 忽略 dub 前面的多餘靜音", () => {
    const n = 150;
    const a = signal(n, [20, 60, 110]);
    const lead = 45;
    const b = signal(n + lead, [20 + lead, 60 + lead, 110 + lead]);
    const r = bandedDtw(n, b.length, { center: (i) => i + lead, halfWidth: 60, dist: l1(a, b), openBegin: true, openEnd: true });
    expect(Math.abs(r.path[0][1] - lead)).toBeLessThanOrEqual(3);
  });

  it("信心：真的對上的路徑比錯位路徑低很多；亂數訊號信心低", () => {
    const n = 300;
    const a = signal(n, [40, 90, 150, 220, 270]);
    const b = signal(n + 20, [57, 107, 167, 237, 287]);
    const d = l1(a, b);
    const r = bandedDtw(n, b.length, { center: (i) => i + 17, halfWidth: 30, dist: d });
    expect(pathConfidence(r.path, b.length, 40, d)).toBeGreaterThan(0.5);
    expect(straightCost(n, b.length, 17, d)).toBeLessThan(straightCost(n, b.length, 0, d));
    // 內容不同的兩段話（脈衝位置無關）：帶內扭不到一起，信心明顯低於對上的那組
    const c = signal(n + 20, [12, 70, 118, 200, 250, 292]);
    const r2 = bandedDtw(n, c.length, { center: (i) => i + 17, halfWidth: 12, dist: l1(a, c), openBegin: true, openEnd: true });
    const confMatched = pathConfidence(r.path, b.length, 40, d);
    const confUnrelated = pathConfidence(r2.path, c.length, 40, l1(a, c));
    expect(confUnrelated).toBeLessThan(confMatched);
    expect(confUnrelated).toBeLessThan(0.6);
  });
});
