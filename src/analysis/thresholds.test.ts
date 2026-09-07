// 激進度滑桿的行為契約。
//
// `thresholdsFor` 是**每一條規則的參數來源**，也是使用者唯一能一鍵調整剪輯力道的地方。
// 它一直沒有測試 —— 而它會壞掉的方式很安靜：把某一條的 LO/HI 寫反，滑桿往「積極」推
// 反而剪得更少，使用者只會覺得「這個滑桿沒用」，不會覺得是 bug。
//
// 所以這裡測的不是特定數值，是**方向**：每一條門檻往哪一邊走才叫「更積極」。
import { describe, expect, it } from "vitest";
import { thresholdsFor, type Thresholds } from "./thresholds";

/**
 * 激進度變高時，這一條該變大還是變小。
 *
 * `up` = 值要變大才算更積極（例如「單句最多剪除比例」）；
 * `down` = 值要變小才算更積極（例如「多長的停頓才算長停頓」）。
 */
const DIRECTION: Record<keyof Thresholds, "up" | "down" | "flat"> = {
  // 自動剪的門檻放低 → 更多候選會自動剪
  fillerAutoScore: "down",
  // 更短的停頓就算「長停頓」→ 剪得更多
  pauseMinBetweenSentencesMs: "down",
  pauseMinWithinSentenceMs: "down",
  // 停頓縮得更短 → 剪得更多
  pauseKeepMs: "down",
  leadTrailKeepMs: "down",
  // 容許更大的間隔仍算同一串口吃 / 重複 → 抓得更多
  stutterMaxGapMs: "up",
  ngramRepeatMaxGapMs: "up",
  // 重疊要求更低、字數上限更高 → 更容易判成「講一半重講」
  restartMinOverlap: "down",
  restartMaxChars: "up",
  // 信心門檻更高、連續字數要求更低 → 更多字被判成聽不清
  unclearWordProb: "up",
  unclearMinRun: "down",
  // 段級訊號的門檻兩端一樣（刻意不隨滑桿動，見原始碼註解）
  unclearSegWordProb: "flat",
  // 小聲 / 雜音的判定門檻更寬鬆 → 抓得更多
  unclearQuietLu: "down",
  noiseAboveFloorLu: "down",
  markerOverusePer30s: "down",
  // 允許一句話被剪掉更大比例
  maxSentenceRemovalRatio: "up",
};

const KEYS = Object.keys(DIRECTION) as (keyof Thresholds)[];

describe("thresholdsFor", () => {
  it("涵蓋每一條門檻（新增欄位時這裡要跟著想清楚方向）", () => {
    expect(Object.keys(thresholdsFor(50)).sort()).toEqual([...KEYS].sort());
  });

  it("**每一條都朝著「更積極」的方向單調變化**（寫反了滑桿就會反效果）", () => {
    const steps = [0, 10, 25, 50, 75, 90, 100].map(thresholdsFor);
    for (const k of KEYS) {
      const dir = DIRECTION[k];
      for (let i = 1; i < steps.length; i++) {
        const prev = steps[i - 1][k];
        const cur = steps[i][k];
        if (dir === "up") expect(cur, `${k} @${i}`).toBeGreaterThanOrEqual(prev);
        else if (dir === "down") expect(cur, `${k} @${i}`).toBeLessThanOrEqual(prev);
        else expect(cur, `${k} @${i}`).toBe(prev);
      }
    }
  });

  it("兩端真的有差（每一條都要對滑桿有反應，flat 的除外）", () => {
    const lo = thresholdsFor(0);
    const hi = thresholdsFor(100);
    for (const k of KEYS) {
      if (DIRECTION[k] === "flat") continue;
      expect(hi[k], `${k} 兩端一樣，滑桿對它沒有作用`).not.toBe(lo[k]);
    }
  });

  it("50 落在兩端之間", () => {
    const lo = thresholdsFor(0);
    const mid = thresholdsFor(50);
    const hi = thresholdsFor(100);
    for (const k of KEYS) {
      const [a, b] = lo[k] <= hi[k] ? [lo[k], hi[k]] : [hi[k], lo[k]];
      expect(mid[k], k).toBeGreaterThanOrEqual(a);
      expect(mid[k], k).toBeLessThanOrEqual(b);
    }
  });

  it("超出範圍會被夾住，不會外推出荒謬的門檻", () => {
    expect(thresholdsFor(-50)).toEqual(thresholdsFor(0));
    expect(thresholdsFor(999)).toEqual(thresholdsFor(100));
  });

  it("非數字不會產生 NaN 門檻（NaN 會讓每一條規則靜靜地全部不命中）", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined as unknown as number]) {
      const t = thresholdsFor(bad);
      for (const k of KEYS) expect(Number.isFinite(t[k]), `${k} @${String(bad)}`).toBe(true);
    }
  });

  it("壞值退回預設 50，不是退回 0（退回 0 會靜靜地變成最保守，看起來像 AI 什麼都沒抓到）", () => {
    expect(thresholdsFor(Number.NaN)).toEqual(thresholdsFor(50));
    expect(thresholdsFor(undefined as unknown as number)).toEqual(thresholdsFor(50));
  });

  it("該是整數的就是整數（次數 / 字數 / 連續字數不能是 2.5）", () => {
    for (const a of [0, 33, 50, 67, 100]) {
      const t = thresholdsFor(a);
      expect(Number.isInteger(t.unclearMinRun), `unclearMinRun @${a}`).toBe(true);
      expect(Number.isInteger(t.markerOverusePer30s), `markerOverusePer30s @${a}`).toBe(true);
      expect(Number.isInteger(t.restartMaxChars), `restartMaxChars @${a}`).toBe(true);
    }
  });

  it("機率類的門檻留在 0–1 之間", () => {
    for (const a of [0, 50, 100]) {
      const t = thresholdsFor(a);
      for (const k of ["fillerAutoScore", "restartMinOverlap", "unclearWordProb", "unclearSegWordProb", "maxSentenceRemovalRatio"] as const) {
        expect(t[k], `${k} @${a}`).toBeGreaterThan(0);
        expect(t[k], `${k} @${a}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("時間類的門檻不會是負的", () => {
    for (const a of [0, 50, 100]) {
      const t = thresholdsFor(a);
      for (const k of KEYS) {
        if (!k.endsWith("Ms")) continue;
        expect(t[k], `${k} @${a}`).toBeGreaterThan(0);
      }
    }
  });
});
