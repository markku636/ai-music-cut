import { describe, expect, it } from "vitest";
import { DEFAULT_DUCK, ENV_MIN_DB, envDbToY, envYToDb, envelopeDb, envelopeGain, mergeRegions, outputDurationWithOverlays, planDuck, voiceRegionsInOutput, type Overlay } from "./overlays";

function clip(outStartMs: number, lenMs: number): Overlay {
  return {
    id: "ov:1",
    lane: "music",
    mediaId: "m",
    srcInMs: 0,
    srcOutMs: lenMs,
    outStartMs,
    gainDb: -18,
    fadeInMs: 0,
    fadeOutMs: 0,
  };
}

describe("mergeRegions", () => {
  it("合併靠太近的區間", () => {
    expect(mergeRegions([{ startMs: 0, endMs: 1000 }, { startMs: 1200, endMs: 2000 }], 500)).toEqual([{ startMs: 0, endMs: 2000 }]);
  });
  it("間隔夠大就不合併", () => {
    expect(mergeRegions([{ startMs: 0, endMs: 1000 }, { startMs: 3000, endMs: 4000 }], 500)).toHaveLength(2);
  });
  it("丟掉零長度的區間", () => {
    expect(mergeRegions([{ startMs: 100, endMs: 100 }], 0)).toEqual([]);
  });
});

describe("planDuck", () => {
  const opts = { ...DEFAULT_DUCK, attackMs: 200, releaseMs: 500, mergeGapMs: 1000 };

  it("一段人聲產生「放開 → 壓下 → 維持 → 放開」四個點", () => {
    const pts = planDuck([{ startMs: 3000, endMs: 5000 }], clip(0, 20000), opts);
    expect(pts).toEqual([
      { ms: 2800, db: 0 },
      { ms: 3000, db: -9 },
      { ms: 5000, db: -9 },
      { ms: 5500, db: 0 },
    ]);
  });

  it("控制點是相對片段起點的（片段不是從 0 開始也對）", () => {
    const pts = planDuck([{ startMs: 13000, endMs: 15000 }], clip(10000, 20000), opts);
    expect(pts[1]).toEqual({ ms: 3000, db: -9 });
  });

  it("人聲從片段之前就在講 → 開頭直接是壓下去的", () => {
    const pts = planDuck([{ startMs: 0, endMs: 4000 }], clip(2000, 20000), opts);
    expect(pts[0].ms).toBe(0);
    expect(pts[0].db).toBe(-9);
  });

  it("兩段人聲貼太近就合併，音樂不會在中間彈起來", () => {
    const pts = planDuck(
      [
        { startMs: 3000, endMs: 4000 },
        { startMs: 4500, endMs: 6000 },
      ],
      clip(0, 20000),
      opts,
    );
    expect(pts).toHaveLength(4);
    expect(pts[2]).toEqual({ ms: 6000, db: -9 });
  });

  it("同一個時間點上「壓下」勝過「放開」", () => {
    // 第一段的 release 點（2000+500）剛好落在第二段開口的那一刻：
    // 如果讓「放開」贏，音樂會在兩句中間彈起來一瞬間。
    const pts = planDuck(
      [
        { startMs: 1000, endMs: 2000 },
        { startMs: 2500, endMs: 3500 },
      ],
      clip(0, 20000),
      { ...opts, mergeGapMs: 0, releaseMs: 500, attackMs: 0 },
    );
    const at2500 = pts.filter((p) => p.ms === 2500);
    expect(at2500).toHaveLength(1);
    expect(at2500[0].db).toBe(-9);
    // 而且整段中間都維持壓下去的狀態
    expect(pts.filter((p) => p.ms > 1000 && p.ms < 3500).every((p) => p.db === -9)).toBe(true);
  });

  it("片段外的人聲不影響", () => {
    expect(planDuck([{ startMs: 50000, endMs: 51000 }], clip(0, 20000), opts)).toEqual([]);
    expect(planDuck([], clip(0, 20000), opts)).toEqual([]);
  });

  it("控制點夾在片段長度內", () => {
    const pts = planDuck([{ startMs: 0, endMs: 99999 }], clip(0, 5000), opts);
    for (const p of pts) {
      expect(p.ms).toBeGreaterThanOrEqual(0);
      expect(p.ms).toBeLessThanOrEqual(5000);
    }
  });
});

describe("voiceRegionsInOutput", () => {
  // 剪掉來源 2000–5000：來源 0–2000 → 成品 0–2000，來源 5000–10000 → 成品 2000–7000
  const keeps = [
    { srcStartMs: 0, srcEndMs: 2000, outStartMs: 0 },
    { srcStartMs: 5000, srcEndMs: 10000, outStartMs: 2000 },
  ];

  it("換算到成品時間軸", () => {
    expect(voiceRegionsInOutput([{ startMs: 6000, endMs: 7000 }], keeps)).toEqual([{ startMs: 3000, endMs: 4000 }]);
  });

  it("跨越剪除區的人聲會被切成兩段", () => {
    const r = voiceRegionsInOutput([{ startMs: 1000, endMs: 6000 }], keeps);
    expect(r).toEqual([{ startMs: 1000, endMs: 3000 }]);
  });

  it("完全落在剪除區的人聲會消失", () => {
    expect(voiceRegionsInOutput([{ startMs: 3000, endMs: 4000 }], keeps)).toEqual([]);
  });
});

describe("音量控制點的 dB ↔ 像素", () => {
  const H = 34;

  it("0 dB 在上緣、ENV_MIN_DB 在下緣", () => {
    expect(envDbToY(0, H)).toBeLessThan(envDbToY(ENV_MIN_DB, H));
    expect(envDbToY(0, H)).toBe(3);
  });

  it("來回換算會回到原值（拖曳不會每次都掉一點）", () => {
    for (const db of [0, -3, -6, -9, -12, -18, -24]) {
      expect(envYToDb(envDbToY(db, H), H)).toBe(db);
    }
  });

  it("超出範圍會夾住，不會跑到 lane 外面", () => {
    expect(envDbToY(12, H)).toBe(envDbToY(0, H));
    expect(envDbToY(-99, H)).toBe(envDbToY(ENV_MIN_DB, H));
    expect(envYToDb(-50, H)).toBe(0);
    expect(envYToDb(9999, H)).toBe(ENV_MIN_DB);
  });
});

// 這一組數字與 src-tauri/src/mix.rs 的 mix::tests 是同一組 —— 即時試聽與成品混音
// 算出來的曲線必須一樣，不然「試聽覺得剛好」的閃避到成品會變成另一個深度。
describe("音量包絡（與 Rust 的 mix.rs 對拍）", () => {
  const mk = (gainDb: number, points: { ms: number; db: number }[], fadeInMs = 0, fadeOutMs = 0): Overlay => ({
    id: "ov",
    lane: "music",
    mediaId: "m",
    srcInMs: 0,
    srcOutMs: 10000,
    outStartMs: 0,
    gainDb,
    fadeInMs,
    fadeOutMs,
    points,
  });

  it("沒有控制點就是固定音量", () => {
    const o = mk(-6, []);
    expect(envelopeDb(o, 0)).toBe(-6);
    expect(envelopeDb(o, 5000)).toBe(-6);
  });

  it("控制點在 dB 域線性內插（相對基準的增減）", () => {
    const o = mk(-6, [
      { ms: 1000, db: 0 },
      { ms: 2000, db: -12 },
    ]);
    expect(envelopeDb(o, 1000)).toBe(-6);
    expect(envelopeDb(o, 2000)).toBe(-18);
    expect(envelopeDb(o, 1500)).toBeCloseTo(-12, 9);
  });

  it("範圍外維持頭尾控制點的值", () => {
    const o = mk(0, [
      { ms: 1000, db: -3 },
      { ms: 2000, db: -9 },
    ]);
    expect(envelopeDb(o, 0)).toBe(-3);
    expect(envelopeDb(o, 99999)).toBe(-9);
  });

  it("淡入淡出乘在包絡上", () => {
    const o = mk(0, [], 1000, 1000);
    expect(envelopeGain(o, 0, 10000)).toBeCloseTo(0, 6);
    expect(envelopeGain(o, 500, 10000)).toBeCloseTo(0.5, 6);
    expect(envelopeGain(o, 5000, 10000)).toBeCloseTo(1, 6);
    expect(envelopeGain(o, 9500, 10000)).toBeCloseTo(0.5, 6);
  });

  it("非常低的 dB 是靜音，不是一個很小的數字", () => {
    expect(envelopeGain(mk(-96, []), 0, 10000)).toBe(0);
  });
});

describe("outputDurationWithOverlays", () => {
  const clip2 = (outStartMs: number, lenMs: number): Overlay => ({
    id: "ov", lane: "music", mediaId: "m", srcInMs: 0, srcOutMs: lenMs, outStartMs, gainDb: 0, fadeInMs: 0, fadeOutMs: 0,
  });

  it("片尾曲比最後一句話晚結束時，成品要跟著變長", () => {
    // 主聲軌 30 秒，片尾曲從 28 秒開始播 10 秒 → 成品 38 秒
    expect(outputDurationWithOverlays(30000, [clip2(28000, 10000)])).toBe(38000);
  });

  it("配樂完全在裡面就不影響長度", () => {
    expect(outputDurationWithOverlays(30000, [clip2(5000, 10000)])).toBe(30000);
  });

  it("沒有配樂就是主聲軌的長度", () => {
    expect(outputDurationWithOverlays(30000, [])).toBe(30000);
  });

  it("取最晚結束的那一個", () => {
    expect(outputDurationWithOverlays(30000, [clip2(28000, 5000), clip2(10000, 40000)])).toBe(50000);
  });
});
