import { describe, expect, it } from "vitest";
import type { Candidate, DecisionMap, Sentence, Word } from "../types";
import { candidateId } from "../types";
import { activeRanges, buildEdl, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE, type EdlInput } from "./build";
import { mapOutToSrc, mapSrcToOut } from "./map";

function mkWords(spec: [string, number, number][]): Word[] {
  return spec.map(([text, s, e], i) => ({ id: i, segId: 0, text, norm: text, startMs: s, endMs: e, prob: 0.9 }));
}
function mkSentences(words: Word[], groups: number[][]): Sentence[] {
  return groups.map((ids, i) => ({ id: i, wordIds: ids, startMs: words[ids[0]].startMs, endMs: words[ids[ids.length - 1]].endMs, endsWithQuestion: false }));
}
function cand(kind: Candidate["kind"], words: Word[], ids: number[], score = 0.9, sentenceId = 0): Candidate {
  const s = words[ids[0]].startMs;
  const e = words[ids[ids.length - 1]].endMs;
  return { id: candidateId(kind, s, e), kind, startMs: s, endMs: e, wordIds: ids, reason: "", score, source: "rule", sentenceId };
}
function rangeCand(kind: Candidate["kind"], s: number, e: number, score = 0.8): Candidate {
  return { id: candidateId(kind, s, e), kind, startMs: s, endMs: e, wordIds: [], reason: "", score, source: "rule", sentenceId: -1 };
}
const auto = (ids: string[]): DecisionMap => Object.fromEntries(ids.map((id) => [id, { state: "auto" as const, origin: "rule" as const, at: "" }]));

describe("buildEdl", () => {
  // 0-2000: 我(0-200) 嗯(300-450) 覺得(500-800) 這(800-950) 很(950-1100) 好(1100-1400)
  const words = mkWords([["我", 0, 200], ["嗯", 300, 450], ["覺得", 500, 800], ["這", 800, 950], ["很", 950, 1100], ["好", 1100, 1400]]);
  const sentences = mkSentences(words, [[0, 1, 2, 3, 4, 5]]);
  const input: EdlInput = { words, sentences, vad: [{ startMs: 0, endMs: 1400 }], durationMs: 2000 };

  it("pads word cuts but never eats neighbouring kept words", () => {
    const c = cand("filler", words, [1]);
    const edl = buildEdl(input, [c], auto([c.id]), DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE);
    expect(edl.removals).toHaveLength(1);
    const r = edl.removals[0];
    // pad 40 前 → 260，但前字 我 結束於 200 → 至少 220；pad 60 後 → 510 > 下一字起 500-20=480 → 夾到 480
    expect(r.startMs).toBeGreaterThanOrEqual(220);
    expect(r.startMs).toBeLessThanOrEqual(300);
    expect(r.endMs).toBeGreaterThanOrEqual(450);
    expect(r.endMs).toBeLessThanOrEqual(480);
    expect(edl.keeps).toHaveLength(2);
    expect(edl.stats.cutCount).toBe(1);
    expect(edl.stats.keptMs + edl.stats.removedMs).toBe(2000);
  });

  it("long pause keeps its exact range and merges nothing across kept words", () => {
    const p = rangeCand("long_pause", 1575, 1900);
    const edl = buildEdl(input, [p], auto([p.id]), { ...DEFAULT_EDL_OPTIONS, snapWindowMs: 0 }, MIDPOINT_PROBE);
    expect(edl.removals[0]).toMatchObject({ startMs: 1575, endMs: 1900, speech: false });
    expect(edl.keeps.map((k) => [k.srcStartMs, k.srcEndMs])).toEqual([
      [0, 1575],
      [1900, 2000],
    ]);
  });

  it("merges two cuts closer than mergeGap when nothing is kept between them", () => {
    const a = cand("filler", words, [1]);
    const b = cand("stutter", words, [2]);
    const edl = buildEdl(input, [a, b], auto([a.id, b.id]), { ...DEFAULT_EDL_OPTIONS, snapWindowMs: 0 }, MIDPOINT_PROBE);
    expect(edl.removals).toHaveLength(1);
    expect(edl.removals[0].candidateIds.sort()).toEqual([a.id, b.id].sort());
  });

  it("sentence guard downgrades the lowest-score auto candidate when the sentence would lose too much", () => {
    const a = cand("filler", words, [1], 0.9);
    const b = cand("filler", words, [2], 0.6);
    const c = cand("filler", words, [3], 0.7);
    const d = cand("filler", words, [4], 0.8);
    const edl = buildEdl(input, [a, b, c, d], auto([a.id, b.id, c.id, d.id]), { ...DEFAULT_EDL_OPTIONS, maxSentenceRemovalRatio: 0.4 }, MIDPOINT_PROBE);
    expect(edl.downgrades.length).toBeGreaterThan(0);
    expect(edl.downgrades[0].candidateId).toBe(b.id);
    expect(edl.downgrades[0].reason).toContain("超過上限");
  });

  it("src↔out mapping is monotonic and round-trips on kept time", () => {
    const c = cand("filler", words, [1]);
    const edl = buildEdl(input, [c], auto([c.id]), { ...DEFAULT_EDL_OPTIONS, snapWindowMs: 0 }, MIDPOINT_PROBE);
    const kept = (ms: number) => edl.keeps.some((k) => ms >= k.srcStartMs && ms <= k.srcEndMs);
    expect(mapSrcToOut(edl.keeps, 100)).toBe(100);
    expect(kept(350)).toBe(false); // 350 ms 被剪掉了，成品裡沒有這一刻
    const o = mapSrcToOut(edl.keeps, 1000);
    expect(o).toBeLessThan(1000);
    expect(mapOutToSrc(edl.keeps, o)).toBe(1000);
    let prev = -1;
    for (let t = 0; t <= 2000; t += 50) {
      if (!kept(t)) continue;
      const v = mapSrcToOut(edl.keeps, t);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("activeRanges merges accepted candidates and ignores rejected", () => {
    const a = cand("filler", words, [1]);
    const b = cand("filler", words, [2]);
    const dec: DecisionMap = { [a.id]: { state: "accepted", origin: "user", at: "" }, [b.id]: { state: "rejected", origin: "user", at: "" } };
    expect(activeRanges([a, b], dec)).toEqual([{ startMs: 300, endMs: 450 }]);
  });

  // R7 起：room tone 只補在句尾 / 段落交界。句子中間剪掉一個「嗯」之後再塞 170 ms
  // 合成靜音，等於把剛拿掉的猶豫又放回去 —— 「呼吸感」要的是斷點的留白。
  it("句中的語音接語音用 crossfade，不插 room tone", () => {
    const c = cand("filler", words, [1]);
    const edl = buildEdl({ ...input, vad: [{ startMs: 0, endMs: 1400 }] }, [c], auto([c.id]), { ...DEFAULT_EDL_OPTIONS, snapWindowMs: 0 }, MIDPOINT_PROBE);
    expect(edl.joins[0].kind).toBe("crossfade");
  });

  it("句子交界處找不到靜音就補 room tone（allowGapInsert=false 則退回 crossfade）", () => {
    // 兩句：S0=[0,1,2]、S1=[3,4,5]，剪掉 S0 最後一個字之後就是句尾接句首
    const twoSentences = mkSentences(words, [[0, 1, 2], [3, 4, 5]]);
    const c = cand("filler", words, [2], 0.9, 0);
    const inp = { ...input, sentences: twoSentences, vad: [{ startMs: 0, endMs: 1400 }] };
    const edl = buildEdl(inp, [c], auto([c.id]), { ...DEFAULT_EDL_OPTIONS, snapWindowMs: 0 }, MIDPOINT_PROBE);
    expect(edl.joins[0].kind).toBe("gap");
    const edl2 = buildEdl(inp, [c], auto([c.id]), { ...DEFAULT_EDL_OPTIONS, snapWindowMs: 0, allowGapInsert: false }, MIDPOINT_PROBE);
    expect(edl2.joins[0].kind).toBe("crossfade");
  });
});

describe("貼上（剪下貼上 / 搬移）", () => {
  const words = mkWords([["我", 0, 200], ["嗯", 300, 450], ["覺得", 500, 800], ["這", 800, 950], ["很", 950, 1100], ["好", 1100, 1400]]);
  const sentences = mkSentences(words, [[0, 1, 2, 3, 4, 5]]);
  const base: EdlInput = { words, sentences, vad: [{ startMs: 0, endMs: 1400 }], durationMs: 2000 };

  it("沒有貼上時跟以前完全一樣", () => {
    const a = buildEdl(base, [], {}, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE);
    const b = buildEdl({ ...base, pastes: [] }, [], {}, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE);
    expect(b.keeps).toEqual(a.keeps);
    expect(b.stats.outMs).toBe(a.stats.outMs);
  });

  it("貼一塊進去，成品變長，而且長度帳對得上", () => {
    const plain = buildEdl(base, [], {}, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE);
    const pasted = buildEdl(
      { ...base, pastes: [{ id: "p1", srcStartMs: 1500, srcEndMs: 1800, atMs: 600 }] },
      [],
      {},
      DEFAULT_EDL_OPTIONS,
      MIDPOINT_PROBE,
    );
    // 多了 300 ms 的內容；接點可能有交越，所以只要求「變長」與「帳自洽」
    expect(pasted.stats.outMs).toBeGreaterThan(plain.stats.outMs);

    // 帳自洽：各段長度總和 + gap − crossfade = outMs（跟 joins.test.ts 同一條不變式）
    const segSum = pasted.keeps.reduce((n, k) => n + (k.srcEndMs - k.srcStartMs), 0);
    const gaps = pasted.joins.filter((j) => j.kind === "gap").reduce((n, j) => n + j.ms, 0);
    const xf = pasted.joins.filter((j) => j.kind === "crossfade").reduce((n, j) => n + j.ms, 0);
    expect(Math.abs(segSum + gaps - xf - pasted.stats.outMs)).toBeLessThanOrEqual(2);
  });

  it("keeps 依成品順序排好（outStart 遞增）", () => {
    const edl = buildEdl(
      { ...base, pastes: [{ id: "p1", srcStartMs: 1500, srcEndMs: 1800, atMs: 600 }] },
      [],
      {},
      DEFAULT_EDL_OPTIONS,
      MIDPOINT_PROBE,
    );
    // 不能要求「不重疊」—— crossfade 本來就是讓前後兩段**重疊**那麼多毫秒。
    // 真正的順序不變式是 outStart 嚴格遞增。
    for (let i = 1; i < edl.keeps.length; i++) {
      expect(edl.keeps[i].outStartMs).toBeGreaterThan(edl.keeps[i - 1].outStartMs);
    }
  });

  it("貼上的那一段來源可以不照順序（搬移的本質）", () => {
    const edl = buildEdl(
      { ...base, pastes: [{ id: "p1", srcStartMs: 1500, srcEndMs: 1800, atMs: 300 }] },
      [],
      {},
      DEFAULT_EDL_OPTIONS,
      MIDPOINT_PROBE,
    );
    const srcOrder = edl.keeps.map((k) => k.srcStartMs);
    // 來源順序被打破了 —— 這正是貼上要做到的事
    expect(srcOrder.some((v, i) => i > 0 && v < srcOrder[i - 1])).toBe(true);
  });
});
