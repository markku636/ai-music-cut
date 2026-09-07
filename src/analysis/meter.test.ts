import { describe, expect, it } from "vitest";
import { meanLufs, meterAt, meterFraction, rangeLoudness, SILENCE_LUFS, verdict } from "./meter";
import type { LocalAnalysis } from "./peaks";

/** 每個視窗 [momentary, shortTerm, rmsDb]。 */
function analysis(windows: [number, number, number][], hopMs = 100): LocalAnalysis {
  const win = new Float32Array(windows.length * 3);
  windows.forEach(([m, s, r], i) => {
    win[i * 3] = m;
    win[i * 3 + 1] = s;
    win[i * 3 + 2] = r;
  });
  return {
    version: 3,
    pps: 200,
    hopMs,
    sampleRate: 48000,
    nBuckets: 0,
    nWin: windows.length,
    totalSamples: 0,
    durationMs: windows.length * hopMs,
    mins: new Int8Array(0),
    maxs: new Int8Array(0),
    rmsU8: new Uint8Array(0),
    win,
    zx: null,
  };
}

const a = analysis([
  [-20, -19, -25],
  [-16, -17, -21],
  [-90, -90, -120],
]);

describe("meterAt", () => {
  it("讀得到當下的視窗", () => {
    expect(meterAt(a, 0).momentary).toBe(-20);
    expect(meterAt(a, 150).momentary).toBe(-16);
  });

  it("超出結尾夾到最後一個視窗（播放線會跑到結尾之外）", () => {
    expect(meterAt(a, 999_999).momentary).toBe(SILENCE_LUFS);
    expect(() => meterAt(a, 999_999)).not.toThrow();
  });

  it("負的時間回靜音而不是丟例外", () => {
    expect(meterAt(a, -100).silent).toBe(true);
  });

  it("沒有分析資料時回靜音", () => {
    expect(meterAt(null, 0).silent).toBe(true);
    expect(meterAt(undefined, 0).silent).toBe(true);
    expect(meterAt(analysis([]), 0).silent).toBe(true);
  });

  it("−70 以下當靜音", () => {
    expect(meterAt(a, 250).silent).toBe(true);
    expect(meterAt(a, 250).momentary).toBe(SILENCE_LUFS);
  });

  it("非有限值不會漏出去", () => {
    const bad = analysis([[Number.NEGATIVE_INFINITY, Number.NaN, -120]]);
    const r = meterAt(bad, 0);
    expect(r.silent).toBe(true);
    expect(Number.isFinite(r.momentary)).toBe(true);
    expect(Number.isFinite(r.shortTerm)).toBe(true);
  });
});

describe("verdict", () => {
  const at = (shortTerm: number) => ({ momentary: shortTerm, shortTerm, rmsDb: -20, silent: false });

  it("在容差內是 ok", () => {
    expect(verdict(at(-16), -16)).toBe("ok");
    expect(verdict(at(-18.9), -16)).toBe("ok");
    expect(verdict(at(-13.1), -16)).toBe("ok");
  });

  it("太小聲 / 太大聲", () => {
    expect(verdict(at(-22), -16)).toBe("quiet");
    expect(verdict(at(-10), -16)).toBe("loud");
  });

  it("靜音自己一類（不要在安靜處一直喊太小聲）", () => {
    expect(verdict({ ...at(-70), silent: true }, -16)).toBe("silent");
  });

  it("容差可調", () => {
    expect(verdict(at(-18), -16, 1)).toBe("quiet");
    expect(verdict(at(-18), -16, 5)).toBe("ok");
  });

  it("用 short-term 而不是 momentary（momentary 每 100ms 跳好幾 dB，看了會一直閃）", () => {
    // momentary 很大聲但 short-term 很小聲 → 判定要跟著 short-term
    expect(verdict({ momentary: -5, shortTerm: -25, rmsDb: -20, silent: false }, -16)).toBe("quiet");
  });
});

describe("meanLufs", () => {
  it("能量平均而不是 dB 直接平均", () => {
    // 10*log10((10^-2 + 10^-1)/2) = -12.60；dB 直接平均會是 -15
    const two = analysis([
      [-20, -20, -30],
      [-10, -10, -20],
    ]);
    expect(meanLufs(two, 0, 200)).toBeCloseTo(-12.6, 1);
    expect(meanLufs(two, 0, 200)).not.toBeCloseTo(-15, 1);
  });

  it("跳過靜音視窗（不然安靜的部分會把平均拉爛）", () => {
    expect(meanLufs(a, 0, 300)).toBeGreaterThan(-20);
  });

  it("全靜音回 SILENCE_LUFS", () => {
    expect(meanLufs(analysis([[-90, -90, -120]]), 0, 100)).toBe(SILENCE_LUFS);
  });

  it("**右端是開區間**：不要多讀範圍外的那一格（短選取上足以改變結論）", () => {
    // hop 100ms、前 10 格 -20、後 10 格 -14。選 0–1000 只該涵蓋第 0..9 格
    const ep2 = analysis([
      ...Array.from({ length: 10 }, () => [-20, -20, -25] as [number, number, number]),
      ...Array.from({ length: 10 }, () => [-14, -14, -19] as [number, number, number]),
    ]);
    expect(meanLufs(ep2, 0, 1000)).toBeCloseTo(-20, 5);
  });

  it("範圍不正或沒有資料時不會炸", () => {
    expect(meanLufs(a, 200, 100)).toBe(SILENCE_LUFS);
    expect(meanLufs(null, 0, 100)).toBe(SILENCE_LUFS);
  });
});

describe("meterFraction", () => {
  it("映到 0–1", () => {
    expect(meterFraction(-40)).toBe(0);
    expect(meterFraction(-5)).toBe(1);
    expect(meterFraction(-22.5)).toBeCloseTo(0.5, 1);
  });

  it("超出範圍會被夾住", () => {
    expect(meterFraction(-100)).toBe(0);
    expect(meterFraction(0)).toBe(1);
  });

  it("非有限值回 0", () => {
    expect(meterFraction(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(meterFraction(Number.NaN)).toBe(0);
  });
});

describe("rangeLoudness", () => {
  // 整集：前 10 個視窗 -20、後 10 個 -14（整集能量平均會落在兩者之間）
  const ep = analysis([
    ...Array.from({ length: 10 }, () => [-20, -20, -25] as [number, number, number]),
    ...Array.from({ length: 10 }, () => [-14, -14, -19] as [number, number, number]),
  ]);

  it("回這段的平均，以及**跟整集差多少**（會問的是差距不是絕對值）", () => {
    const quiet = rangeLoudness(ep, 0, 1000, -16);
    expect(quiet.lufs).toBeCloseTo(-20, 1);
    expect(quiet.vsEpisodeLu).not.toBeNull();
    expect(quiet.vsEpisodeLu!).toBeLessThan(0); // 比整集小聲
  });

  it("大聲的那一段是正數", () => {
    const loud = rangeLoudness(ep, 1000, 2000, -16);
    expect(loud.lufs).toBeCloseTo(-14, 1);
    expect(loud.vsEpisodeLu!).toBeGreaterThan(0);
  });

  it("跟目標的差距也算出來", () => {
    expect(rangeLoudness(ep, 1000, 2000, -16).vsTargetLu).toBeCloseTo(2, 1);
  });

  it("整段靜音時標成 silent，而且不要謊報一個差距", () => {
    const silent = analysis([[-90, -90, -120]]);
    const r = rangeLoudness(silent, 0, 100, -16);
    expect(r.silent).toBe(true);
    expect(r.vsEpisodeLu).toBeNull();
    expect(r.vsTargetLu).toBe(0);
  });

  it("沒有分析資料時不會炸", () => {
    expect(rangeLoudness(null, 0, 1000, -16).silent).toBe(true);
  });

  it("範圍反了也不會炸", () => {
    expect(rangeLoudness(ep, 1000, 0, -16).silent).toBe(true);
  });
});
