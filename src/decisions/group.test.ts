import { describe, expect, it } from "vitest";
import type { Candidate, DecisionMap, Word } from "../analysis/types";
import { buildGroups, candidateText, groupKeyOf, normForGroup, sampleForAudition } from "./group";

function w(id: number, text: string, norm = text, startMs = id * 100): Word {
  return { id, segId: 0, text, norm, startMs, endMs: startMs + 90, prob: 0.9 };
}

function c(id: string, kind: Candidate["kind"], wordIds: number[], startMs = 0, endMs = 300, score = 0.5): Candidate {
  return { id, kind, startMs, endMs, wordIds, reason: "r", score, source: "rule", sentenceId: 0 };
}

const WORDS = [w(0, "我"), w(1, "就是，", "就是"), w(2, "想"), w(3, "就是", "就是"), w(4, "說"), w(5, "就是"), w(6, "嗯")];

describe("candidateText / normForGroup", () => {
  it("把候選涵蓋的原字接起來（含標點）", () => {
    expect(candidateText(c("a", "filler", [1]), WORDS)).toBe("就是，");
    expect(normForGroup(c("a", "filler", [1]), WORDS)).toBe("就是");
  });

  it("沒有字的候選（長停頓 / 雜音）回空字串", () => {
    expect(candidateText(c("p", "long_pause", []), WORDS)).toBe("");
  });

  it("多字候選接起來", () => {
    expect(candidateText(c("m", "stutter", [1, 2]), WORDS)).toBe("就是，想");
  });
});

describe("groupKeyOf", () => {
  it("標點不影響分組：「就是，」與「就是」同一組", () => {
    expect(groupKeyOf(c("a", "filler", [1]), WORDS)).toBe(groupKeyOf(c("b", "filler", [3]), WORDS));
  });

  it("同樣的詞但不同類型要分開（filler 的「就是」和 stutter 的「就是」不是同一回事）", () => {
    expect(groupKeyOf(c("a", "filler", [1]), WORDS)).not.toBe(groupKeyOf(c("b", "stutter", [1]), WORDS));
  });

  it("沒有文字的用時長分桶（0.5 秒一階）", () => {
    const k1 = groupKeyOf(c("p1", "long_pause", [], 0, 1200), WORDS);
    const k2 = groupKeyOf(c("p2", "long_pause", [], 5000, 6300), WORDS);
    const k3 = groupKeyOf(c("p3", "long_pause", [], 0, 1800), WORDS);
    expect(k1).toBe(k2); // 1.2s 與 1.3s 同桶
    expect(k1).not.toBe(k3); // 1.8s 是別桶
  });
});

describe("buildGroups", () => {
  const cands = [
    c("a", "filler", [1], 100, 300),
    c("b", "filler", [3], 300, 500),
    c("c", "filler", [5], 500, 700),
    c("d", "noise", [], 900, 1500),
  ];

  it("同一個詞收成一組，並統計各狀態", () => {
    const dec: DecisionMap = { a: { state: "accepted", origin: "user", at: "" } };
    const gs = buildGroups(cands, WORDS, dec);
    const filler = gs.find((g) => g.label === "就是，")!;
    expect(filler.members).toHaveLength(3);
    expect(filler.active).toBe(1);
    expect(filler.pending).toBe(2);
    expect(filler.totalMs).toBe(600);
  });

  it("未決最多的排前面（先處理最省時間的）", () => {
    const gs = buildGroups(cands, WORDS, {});
    expect(gs[0].members).toHaveLength(3);
  });

  it("平均分數是組內平均", () => {
    const gs = buildGroups([c("a", "filler", [1], 0, 100, 0.2), c("b", "filler", [3], 0, 100, 0.8)], WORDS, {});
    expect(gs[0].avgScore).toBeCloseTo(0.5, 6);
  });
});

describe("sampleForAudition", () => {
  const many = Array.from({ length: 47 }, (_, i) => c(`x${i}`, "filler", [1], i * 1000, i * 1000 + 200));

  it("取首 / 中 / 尾，而且穩定不隨機（再聽一次要是同一批）", () => {
    const g = buildGroups(many, WORDS, {})[0];
    const a = sampleForAudition(g, {}, 3).map((x) => x.id);
    const b = sampleForAudition(g, {}, 3).map((x) => x.id);
    expect(a).toEqual(b);
    expect(a).toEqual(["x0", "x23", "x46"]);
  });

  it("只抽未決的（已經決定過的不必再聽）", () => {
    const dec: DecisionMap = {};
    for (let i = 0; i < 45; i++) dec[`x${i}`] = { state: "rejected", origin: "user", at: "" };
    const g = buildGroups(many, WORDS, dec)[0];
    expect(sampleForAudition(g, dec, 3).map((x) => x.id)).toEqual(["x45", "x46"]);
  });

  it("組太小就全給", () => {
    const g = buildGroups([c("a", "filler", [1])], WORDS, {})[0];
    expect(sampleForAudition(g, {}, 3)).toHaveLength(1);
  });
});
