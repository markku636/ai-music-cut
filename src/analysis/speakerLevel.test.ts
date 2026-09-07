import { describe, expect, it } from "vitest";
import { levelSpread, MIN_MEASURE_MS, speakerLevels, spreadVerdict, unitSpeakerMap } from "./speakerLevel";
import type { LocalAnalysis } from "./peaks";
import type { Speaker, SpeakerTurn } from "./speakers";

const HOP = 100;

/** 每個 100 ms 視窗一個 momentary 值。 */
function analysis(momentary: number[]): LocalAnalysis {
  const win = new Float32Array(momentary.length * 3);
  momentary.forEach((m, i) => {
    win[i * 3] = m;
    win[i * 3 + 1] = m;
    win[i * 3 + 2] = m - 5;
  });
  return {
    version: 3,
    pps: 200,
    hopMs: HOP,
    sampleRate: 48000,
    nBuckets: 0,
    nWin: momentary.length,
    totalSamples: 0,
    durationMs: momentary.length * HOP,
    mins: new Int8Array(0),
    maxs: new Int8Array(0),
    rmsU8: new Uint8Array(0),
    win,
    zx: null,
  };
}

const list: Speaker[] = [
  { id: "a", label: "A", colorIndex: 0 },
  { id: "b", label: "B", colorIndex: 1 },
];

describe("speakerLevels", () => {
  it("兩個人不同響度就量得出來", () => {
    // 前 10 秒 −16 LUFS（A）、後 10 秒 −24 LUFS（B）
    const a = analysis([...Array<number>(100).fill(-16), ...Array<number>(100).fill(-24)]);
    const turns: SpeakerTurn[] = [
      { startMs: 0, endMs: 10_000, speakerId: "a" },
      { startMs: 10_000, endMs: 20_000, speakerId: "b" },
    ];
    const lv = speakerLevels(a, turns, list);
    expect(lv[0].lufs).toBeCloseTo(-16, 1);
    expect(lv[1].lufs).toBeCloseTo(-24, 1);
  });

  it("同一個人散在各處的發言一起算（不是先算每段再平均）", () => {
    // A 有一段很長的 −20 與一小段 −10；一起閘門積分會接近 −20，逐段平均會被小段拉高
    const win = [...Array<number>(190).fill(-20), ...Array<number>(10).fill(-10)];
    const a = analysis(win);
    const turns: SpeakerTurn[] = [
      { startMs: 0, endMs: 19_000, speakerId: "a" },
      { startMs: 19_000, endMs: 20_000, speakerId: "a" },
    ];
    const lv = speakerLevels(a, turns, list);
    expect(lv[0].lufs).not.toBeNull();
    expect(lv[0].lufs!).toBeLessThan(-17);
  });

  it("講太少不給數字（三秒的附和不能拿來做決定）", () => {
    const a = analysis(Array<number>(200).fill(-16));
    const lv = speakerLevels(a, [{ startMs: 0, endMs: MIN_MEASURE_MS - 1, speakerId: "a" }], list);
    expect(lv[0].lufs).toBeNull();
    expect(lv[0].ms).toBe(MIN_MEASURE_MS - 1);
  });

  it("一句話都沒講的人也列出來（ms 0、沒有數字）", () => {
    const a = analysis(Array<number>(200).fill(-16));
    const lv = speakerLevels(a, [{ startMs: 0, endMs: 20_000, speakerId: "a" }], list);
    expect(lv[1]).toEqual({ speakerId: "b", lufs: null, ms: 0 });
  });

  it("沒有分析資料時不會炸", () => {
    expect(speakerLevels(null, [], list).map((x) => x.lufs)).toEqual([null, null]);
    expect(speakerLevels(analysis([]), [{ startMs: 0, endMs: 20_000, speakerId: "a" }], list)[0].lufs).toBeNull();
  });

  it("段落超出分析長度也不會讀到界外", () => {
    const a = analysis(Array<number>(50).fill(-16));
    expect(() => speakerLevels(a, [{ startMs: 0, endMs: 999_000, speakerId: "a" }], list)).not.toThrow();
  });

  it("全靜音回 null 而不是一個假的數字", () => {
    const a = analysis(Array<number>(200).fill(-90));
    expect(speakerLevels(a, [{ startMs: 0, endMs: 20_000, speakerId: "a" }], list)[0].lufs).toBeNull();
  });
});

describe("levelSpread / spreadVerdict", () => {
  it("最大減最小", () => {
    expect(levelSpread([
      { speakerId: "a", lufs: -16, ms: 9000 },
      { speakerId: "b", lufs: -24, ms: 9000 },
    ])).toBe(8);
  });

  it("量不到的人不參與（不足兩個人回 null）", () => {
    expect(levelSpread([
      { speakerId: "a", lufs: -16, ms: 9000 },
      { speakerId: "b", lufs: null, ms: 100 },
    ])).toBeNull();
  });

  it("判讀分三級", () => {
    expect(spreadVerdict(1)).toBe("even");
    expect(spreadVerdict(4)).toBe("noticeable");
    expect(spreadVerdict(6)).toBe("noticeable");
    expect(spreadVerdict(9)).toBe("bad");
    expect(spreadVerdict(null)).toBeNull();
  });
});

describe("unitSpeakerMap", () => {
  const turns: SpeakerTurn[] = [
    { startMs: 0, endMs: 10_000, speakerId: "a" },
    { startMs: 10_000, endMs: 20_000, speakerId: "b" },
  ];

  it("單元歸給重疊最久的講者", () => {
    const m = unitSpeakerMap([{ id: 1, startMs: 9000, endMs: 15_000 }], turns);
    expect(m.get(1)).toBe("b");
  });

  it("完全落在一個人身上就是那個人", () => {
    const m = unitSpeakerMap([{ id: 1, startMs: 1000, endMs: 5000 }], turns);
    expect(m.get(1)).toBe("a");
  });

  it("沒被標到的單元不進表（planGains 會當成延續）", () => {
    const m = unitSpeakerMap([{ id: 1, startMs: 50_000, endMs: 55_000 }], turns);
    expect(m.has(1)).toBe(false);
  });

  it("沒有講者段落時回空表", () => {
    expect(unitSpeakerMap([{ id: 1, startMs: 0, endMs: 1000 }], []).size).toBe(0);
  });
});
