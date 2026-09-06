import { describe, expect, it } from "vitest";
import type { Candidate, DecisionMap } from "../types";
import { buildEdl, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE, type EdlInput } from "./build";
import { MIN_REMOVAL_MS, planSplitRipple, planTrim, type TrimCandidate } from "./trim";

const bounds = { minMs: 0, maxMs: 10_000 };
const one: TrimCandidate[] = [{ id: "a", startMs: 1000, endMs: 1500 }];
const two: TrimCandidate[] = [
  { id: "a", startMs: 1000, endMs: 1200 },
  { id: "b", startMs: 1300, endMs: 1500 },
];

describe("planTrim / ripple", () => {
  it("拖左把手只動最早那一個候選的起點", () => {
    expect(planTrim(two, -200, "ripple", "left", bounds)).toEqual([{ id: "a", startMs: 800, endMs: 1200 }]);
  });

  it("拖右把手只動最晚那一個候選的終點", () => {
    expect(planTrim(two, 300, "ripple", "right", bounds)).toEqual([{ id: "b", startMs: 1300, endMs: 1800 }]);
  });

  it("位移量就是拖曳量（1:1）", () => {
    const r = planTrim(one, -137, "ripple", "left", bounds);
    expect(r[0].startMs).toBe(1000 - 137);
  });

  it("不會把剪除區壓到比 MIN_REMOVAL_MS 短", () => {
    const r = planTrim(one, 10_000, "ripple", "left", bounds);
    expect(r[0].startMs).toBe(1500 - MIN_REMOVAL_MS);
  });

  it("夾在邊界內", () => {
    expect(planTrim(one, -99_999, "ripple", "left", bounds)[0].startMs).toBe(0);
    expect(planTrim(one, 99_999, "ripple", "right", bounds)[0].endMs).toBe(10_000);
  });

  it("沒有變動就回空陣列（不要製造假的 undo 紀錄）", () => {
    expect(planTrim(one, 0, "ripple", "left", bounds)).toEqual([]);
    expect(planTrim([], 100, "ripple", "left", bounds)).toEqual([]);
  });
});

describe("planTrim / roll", () => {
  it("整批平移，長度不變", () => {
    const r = planTrim(two, 250, "roll", "left", bounds);
    expect(r).toEqual([
      { id: "a", startMs: 1250, endMs: 1450 },
      { id: "b", startMs: 1550, endMs: 1750 },
    ]);
    const before = two.reduce((s, c) => s + (c.endMs - c.startMs), 0);
    const after = r.reduce((s, c) => s + (c.endMs - c.startMs), 0);
    expect(after).toBe(before);
  });

  it("任一端頂到邊界，整批一起停住（形狀不變形）", () => {
    const r = planTrim(two, -5000, "roll", "left", bounds);
    expect(r[0].startMs).toBe(0);
    expect(r[1].startMs).toBe(300);
    expect(r[1].endMs - r[1].startMs).toBe(200);
  });
});

describe("planSplitRipple", () => {
  it("往回拖左把手＝開始剪掉切點前面那一段", () => {
    expect(planSplitRipple(5000, -300, "left", bounds)).toEqual({ startMs: 4700, endMs: 5000 });
  });

  it("往前拖右把手＝開始剪掉切點後面那一段", () => {
    expect(planSplitRipple(5000, 300, "right", bounds)).toEqual({ startMs: 5000, endMs: 5300 });
  });

  it("反方向沒有意義（會讓同一段聲音出現兩次）", () => {
    expect(planSplitRipple(5000, 300, "left", bounds)).toBeNull();
    expect(planSplitRipple(5000, -300, "right", bounds)).toBeNull();
  });

  it("太短的拖曳不算數", () => {
    expect(planSplitRipple(5000, -5, "left", bounds)).toBeNull();
  });
});

// 修剪的意義最後要落在 EDL 上，所以這裡走完整條路徑：
// 候選 → buildEdl → 成品長度。捲動不該改變總長，漣漪該剛好改變拖曳的量。
describe("修剪對成品長度的影響（EDL 層）", () => {
  const durationMs = 5000;
  const input: EdlInput = { words: [], sentences: [], vad: [{ startMs: 0, endMs: durationMs }], durationMs };
  const mk = (startMs: number, endMs: number): Candidate => ({
    id: "manual:1",
    kind: "manual",
    startMs,
    endMs,
    wordIds: [],
    reason: "",
    score: 1,
    source: "user",
    sentenceId: -1,
  });
  const dec: DecisionMap = { "manual:1": { state: "accepted", origin: "user", at: "" } };
  const outOf = (startMs: number, endMs: number) => buildEdl(input, [mk(startMs, endMs)], dec, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE).stats.outMs;

  it("捲動：接縫位置換了，成品總長不變", () => {
    const before = outOf(1000, 1500);
    const rolled = planTrim([{ id: "manual:1", startMs: 1000, endMs: 1500 }], 200, "roll", "left", { minMs: 0, maxMs: durationMs });
    expect(rolled).toEqual([{ id: "manual:1", startMs: 1200, endMs: 1700 }]);
    expect(outOf(rolled[0].startMs, rolled[0].endMs)).toBeCloseTo(before, 6);
  });

  it("漣漪：成品剛好變動拖曳的量", () => {
    const before = outOf(1000, 1500);
    const rippled = planTrim([{ id: "manual:1", startMs: 1000, endMs: 1500 }], -200, "ripple", "left", { minMs: 0, maxMs: durationMs });
    expect(rippled[0].startMs).toBe(800);
    // 剪除區變長 200 ms → 成品短 200 ms
    expect(outOf(rippled[0].startMs, rippled[0].endMs)).toBeCloseTo(before - 200, 0);
  });
});
