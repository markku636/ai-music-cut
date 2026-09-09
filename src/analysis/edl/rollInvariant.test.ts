// 捲動修剪唯一的存在理由是「**成品總長不變**」——
// 接縫左右一起動，只換掉這一刀落在哪，不影響後面的時間。
//
// `planTrim` 的 roll 分支確實讓整批平移同一個量，長度自然不變。但它只拿
// 「檔案頭尾」當邊界（`trimActions` 傳的是 `{ minMs: 0, maxMs: 時長 }`），
// **沒有夾相鄰的剪除區**。捲進隔壁那一段的話 `buildEdl` 會把兩段合併，
// 合併後的總剪除量就不等於原本兩段相加 —— 成品長度跟著變。
//
// 所以這裡不驗 `planTrim` 自己，驗的是「套用之後真的重算一次 EDL」的總長。
import { describe, expect, it } from "vitest";
import type { Candidate, DecisionMap } from "../types";
import { candidateId } from "../types";
import { buildEdl, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE, type EdlInput } from "./build";
import { planTrim, type TrimCandidate, type TrimSide } from "./trim";

const rangeCand = (s: number, e: number): Candidate => ({
  id: candidateId("noise", s, e),
  kind: "noise",
  startMs: s,
  endMs: e,
  wordIds: [],
  reason: "",
  score: 0.9,
  source: "user",
  sentenceId: -1,
});
const auto = (ids: string[]): DecisionMap => Object.fromEntries(ids.map((id) => [id, { state: "auto" as const, origin: "rule" as const, at: "" }]));

/** 沒有逐字稿的純範圍剪除：這樣算出來的剪除區就是候選本身，好對帳。 */
const INPUT: EdlInput = { words: [], sentences: [], vad: [{ startMs: 0, endMs: 20_000 }], durationMs: 20_000 };
const BOUNDS = { minMs: 0, maxMs: 20_000 };

function outMsOf(cands: Candidate[]): number {
  return buildEdl(INPUT, cands, auto(cands.map((c) => c.id)), DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE).stats.outMs;
}

/** 把 planTrim 的結果套回候選清單（id 會因為範圍改變而重算）。 */
function apply(cands: Candidate[], next: TrimCandidate[]): Candidate[] {
  return cands.map((c) => {
    const n = next.find((x) => x.id === c.id);
    return n ? rangeCand(n.startMs, n.endMs) : c;
  });
}

describe("捲動修剪：成品總長不變", () => {
  it("一般情況：往左捲、往右捲，總長都不動", () => {
    const cands = [rangeCand(5000, 5500)];
    const before = outMsOf(cands);
    for (const delta of [-300, -50, 50, 300]) {
      const next = planTrim(cands as TrimCandidate[], delta, "roll", "left", BOUNDS);
      expect(outMsOf(apply(cands, next)), `捲 ${delta} ms`).toBe(before);
    }
  });

  it("捲到檔案頭尾時，長度只會差一個交越 —— 那裡的接縫消失了", () => {
    // 這不是 bug，是邊界的固有性質：剪除區貼到檔頭時前面沒有東西可以接，
    // 那個 crossfade（連同它扣掉的重疊）就不存在了。差一個交越，不是差一段內容。
    const XF = 24;
    const cases: { cands: Candidate[]; delta: number; side: TrimSide }[] = [
      { cands: [rangeCand(100, 600)], delta: -5000, side: "left" },
      { cands: [rangeCand(19_000, 19_500)], delta: 5000, side: "right" },
    ];
    for (const { cands, delta, side } of cases) {
      const before = outMsOf(cands);
      const next = planTrim(cands as TrimCandidate[], delta, "roll", side, BOUNDS);
      const after = outMsOf(apply(cands, next));
      expect(Math.abs(after - before)).toBeLessThanOrEqual(XF + 1);
    }
  });

  it("**不能捲進隔壁的剪除區** —— 合併之後總長就變了", () => {
    // 兩段剪除區：[4000,4500) 與 [5000,5500)，中間留著 500 ms。
    // 往左捲 800 ms 會重疊 300 ms，兩段被 buildEdl 合併成 [4000,4700)：
    // 剪掉的總量從 1000 變成 700，成品反而長了 324 ms。
    const cands = [rangeCand(4000, 4500), rangeCand(5000, 5500)];
    const before = outMsOf(cands);

    // 舊的邊界（整個檔案）：真的會合併，長度變了
    const loose = planTrim([{ id: cands[1].id, startMs: 5000, endMs: 5500 }], -800, "roll", "left", BOUNDS);
    expect(outMsOf(apply(cands, loose))).not.toBe(before);

    // 正確的邊界是「左右兩段剪除區之間」——「左邊那段的結束」到「右邊那段的開始」。
    // 這正是 trimSeam 現在算的那一組。
    const tight = { minMs: cands[0].endMs, maxMs: 20_000 };
    const clamped = planTrim([{ id: cands[1].id, startMs: 5000, endMs: 5500 }], -800, "roll", "left", tight);
    expect(clamped[0].startMs).toBe(cands[0].endMs); // 停在隔壁的邊上
    // 停在邊上時兩段仍然會被 buildEdl 合併（mergeGapMs 120，貼著就併）——
    // 但那只是「兩個接縫變成一個」，少一個交越；剪掉的**內容**一模一樣。
    // 剩下的差是一個交越，不是一段內容：324 ms → 24 ms。
    const clampedOut = outMsOf(apply(cands, clamped));
    expect(Math.abs(clampedOut - before)).toBeLessThanOrEqual(25);
    // 而沒有夾的那條差了一整段內容
    expect(Math.abs(outMsOf(apply(cands, loose)) - before)).toBeGreaterThan(300);
  });
});
