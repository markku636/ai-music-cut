import { describe, expect, it } from "vitest";
import { normalizeTranscript } from "../normalize";
import { candidateId, type Candidate } from "../types";
import { renderWindow } from "./prompt";
import { actionToState, locateText, validateJudge } from "./validate";
import { hashString, makeWindows } from "./windows";

const tr = normalizeTranscript({
  duration_sec: 10,
  segments: [
    { id: 0, start: 0, end: 2, text: "嗯我們今天要聊剪輯。", words: [["嗯", 0, 0.2], ["我們", 0.4, 0.6], ["今天", 0.6, 0.9], ["要", 0.9, 1.0], ["聊", 1.0, 1.2], ["剪輯。", 1.2, 1.6]].map(([w, s, e]) => ({ word: w as string, start: s as number, end: e as number, probability: 0.9 })) },
    { id: 1, start: 2.5, end: 4, text: "那個這個工具很好用。", words: [["那個", 2.5, 2.8], ["這個", 3.0, 3.2], ["工具", 3.2, 3.5], ["很", 3.5, 3.6], ["好用。", 3.6, 4.0]].map(([w, s, e]) => ({ word: w as string, start: s as number, end: e as number, probability: 0.9 })) },
    { id: 2, start: 5, end: 6, text: "謝謝大家。", words: [["謝謝", 5, 5.3], ["大家。", 5.3, 5.8]].map(([w, s, e]) => ({ word: w as string, start: s as number, end: e as number, probability: 0.9 })) },
  ],
});

function cand(kind: Candidate["kind"], wordIds: number[], score = 0.9): Candidate {
  const s = tr.words[wordIds[0]].startMs;
  const e = tr.words[wordIds[wordIds.length - 1]].endMs;
  const sid = tr.sentences.find((x) => x.wordIds.includes(wordIds[0]))!.id;
  return { id: candidateId(kind, s, e), kind, startMs: s, endMs: e, wordIds, reason: "r", score, source: "rule", sentenceId: sid };
}

describe("llm windows/prompt/validate", () => {
  const c1 = cand("filler", [0]);
  const c2 = cand("filler", [6]);
  const cands = [c1, c2];

  it("makes one window with only candidate sentences as core and stable hash", () => {
    const ws = makeWindows(tr, cands);
    expect(ws).toHaveLength(1);
    expect(ws[0].coreSentenceIds).toEqual([0, 1]);
    expect(ws[0].candidateIds).toEqual([c1.id, c2.id]);
    expect(ws[0].hash).toBe(makeWindows(tr, cands)[0].hash);
    expect(hashString("a")).not.toBe(hashString("b"));
  });

  it("renders aliases and candidate list", () => {
    const w = makeWindows(tr, cands)[0];
    const r = renderWindow(tr, w, cands, {});
    expect(r.prompt).toContain("⟦c1:嗯⟧");
    expect(r.prompt).toContain("⟦c2:那個⟧");
    expect(r.prompt).toContain("c1 | 贅字");
    expect(r.alias.get("c2")).toBe(c2.id);
  });

  it("validates decisions, maps actions and locates new candidates by text", () => {
    const w = makeWindows(tr, cands)[0];
    const r = renderWindow(tr, w, cands, {});
    const v = validateJudge(
      {
        window_id: "W1",
        decisions: [
          { id: "c1", action: "apply", reason: "純語助詞" },
          { id: "c9", action: "drop", reason: "?" },
        ],
        new_candidates: [
          { kind: "rambling", sentence_id: 1, text: "這個工具很好用", action: "apply", reason: "冗長" },
          { kind: "filler", sentence_id: 5, text: "x", action: "apply", reason: "bad" },
        ],
      },
      w,
      r.alias,
      tr,
      cands,
    );
    expect(v.updates).toEqual(expect.arrayContaining([{ id: c1.id, state: "auto", reason: "純語助詞" }]));
    expect(v.updates.find((u) => u.id === c2.id)?.state).toBe("pending");
    expect(v.added).toHaveLength(1);
    expect(v.added[0]).toMatchObject({ kind: "rambling", source: "llm", sentenceId: 1 });
    expect(v.added[0].wordIds).toEqual([7, 8, 9, 10]);
    expect(v.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it("suggest-only kinds never become auto", () => {
    expect(actionToState("apply", "unclear")).toBe("pending");
    expect(actionToState("apply", "filler")).toBe("auto");
    expect(actionToState("drop", "filler")).toBe("rejected");
  });

  it("locateText ignores punctuation", () => {
    expect(locateText(tr, 0, "聊剪輯")).toEqual([4, 5]);
    expect(locateText(tr, 0, "不存在")).toBeNull();
  });
});
