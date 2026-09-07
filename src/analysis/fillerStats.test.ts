import { beforeEach, describe, expect, it } from "vitest";
import { fillerTotals, groupFillers } from "./fillerStats";
import { setFillerRules } from "./lexicon";
import { normText } from "./normalize";
import type { Candidate, DecisionMap, Word } from "./types";

// norm 一定要用真的那支算 —— 自己寫一個 toLowerCase() 版本，
// 就會做出一份「跟真實管線不一樣的假資料」，測起來全綠但保護不到任何東西。
function w(id: number, text: string, startMs: number, endMs: number): Word {
  return { id, segId: 0, text, norm: normText(text), startMs, endMs, prob: 0.9 };
}

function cand(id: string, wordIds: number[], startMs: number, endMs: number, kind: Candidate["kind"] = "filler"): Candidate {
  return { id, kind, startMs, endMs, wordIds, reason: "", score: 0.9, source: "rule", sentenceId: 0 };
}

const words: Word[] = [
  w(0, "然後", 0, 300),
  w(1, "嗯", 400, 500),
  w(2, "然後", 900, 1200),
  w(3, "然後", 2000, 2400),
  w(4, "內容", 3000, 3400),
];

beforeEach(() => setFillerRules({}));

describe("groupFillers", () => {
  it("同一個詞歸成一列，次數多的排前面", () => {
    const cands = [cand("a", [0], 0, 300), cand("b", [1], 400, 500), cand("c", [2], 900, 1200), cand("d", [3], 2000, 2400)];
    const g = groupFillers(cands, {}, words);
    expect(g.map((x) => x.norm)).toEqual(["然後", "嗯"]);
    expect(g[0].count).toBe(3);
    expect(g[0].totalMs).toBe(300 + 300 + 400);
    expect(g[0].ids).toEqual(["a", "c", "d"]);
  });

  it("分別數已剪 / 待決 / 不剪", () => {
    const cands = [cand("a", [0], 0, 300), cand("c", [2], 900, 1200), cand("d", [3], 2000, 2400)];
    const dec: DecisionMap = {
      a: { state: "auto", origin: "rule", at: "" },
      c: { state: "rejected", origin: "user", at: "" },
      // d 沒有決策 → 待決
    };
    const [g] = groupFillers(cands, dec, words);
    expect([g.cut, g.rejected, g.pending]).toEqual([1, 1, 1]);
    expect(g.cutMs).toBe(300); // 只算真的會剪掉的那筆
    expect(g.totalMs).toBe(1000);
  });

  it("accepted 跟 auto 一樣都算會剪掉", () => {
    const cands = [cand("a", [0], 0, 300), cand("c", [2], 900, 1200)];
    const dec: DecisionMap = { a: { state: "accepted", origin: "user", at: "" }, c: { state: "auto", origin: "rule", at: "" } };
    expect(groupFillers(cands, dec, words)[0].cut).toBe(2);
  });

  it("只收贅字，口吃 / 停頓不混進來", () => {
    const cands = [cand("a", [0], 0, 300), cand("s", [2], 900, 1200, "stutter"), cand("p", [3], 2000, 2400, "long_pause")];
    const g = groupFillers(cands, {}, words);
    expect(g).toHaveLength(1);
    expect(g[0].count).toBe(1);
  });

  it("標出內建詞與使用者自訂詞", () => {
    setFillerRules({ 內容: "always" });
    const cands = [cand("a", [0], 0, 300), cand("x", [4], 3000, 3400)];
    const g = groupFillers(cands, {}, words);
    const ranran = g.find((x) => x.norm === "然後")!;
    const custom = g.find((x) => x.norm === "內容")!;
    expect(ranran.builtin).toBe(true);
    expect(ranran.rule).toBeNull();
    expect(custom.builtin).toBe(false);
    expect(custom.rule).toBe("always");
  });

  it("排序在次數打平時仍然穩定", () => {
    const cands = [cand("a", [0], 0, 300), cand("b", [1], 400, 500)];
    const first = groupFillers(cands, {}, words).map((g) => g.norm);
    const second = groupFillers([...cands].reverse(), {}, words).map((g) => g.norm);
    expect(first).toEqual(second);
  });

  it("找不到字的候選不會炸，也不會產生空白列", () => {
    const g = groupFillers([cand("ghost", [99], 0, 100)], {}, words);
    expect(g).toEqual([]);
  });
});

describe("fillerTotals", () => {
  it("加總各列", () => {
    const cands = [cand("a", [0], 0, 300), cand("b", [1], 400, 500), cand("c", [2], 900, 1200)];
    const dec: DecisionMap = { a: { state: "auto", origin: "rule", at: "" } };
    const tot = fillerTotals(groupFillers(cands, dec, words));
    expect(tot).toEqual({ words: 2, count: 3, cut: 1, pending: 2, totalMs: 700, cutMs: 300 });
  });
});

describe("顯示用文字", () => {
  it("去掉頭尾標點（同一個詞不該因為標點看起來像兩個）", () => {
    const punct: Word[] = [w(0, "對。", 0, 200), w(1, "對，", 500, 700), w(2, "然後…", 1200, 1500)];
    const cands = [cand("a", [0], 0, 200), cand("b", [1], 500, 700), cand("c", [2], 1200, 1500)];
    const g = groupFillers(cands, {}, punct);
    expect(g.find((x) => x.count === 2)!.text).toBe("對");
    expect(g.find((x) => x.count === 1)!.text).toBe("然後");
  });

  it("詞中間的標點留著（那是內容的一部分）", () => {
    const mid: Word[] = [w(0, "so,", 0, 200), w(1, "ok!", 300, 500)];
    const g = groupFillers([cand("a", [0, 1], 0, 500)], {}, mid);
    expect(g[0].text).toBe("so,ok");
  });
});

describe("groupFillers：依講者篩選", () => {
  // 主持人講 0–1000，來賓講 1500–2500
  const turns = [
    { startMs: 0, endMs: 1000, speakerId: "host" },
    { startMs: 1500, endMs: 2500, speakerId: "guest" },
  ];
  const cands = [cand("a", [0], 0, 300), cand("c", [2], 900, 1200), cand("d", [3], 2000, 2400)];

  it("只算指定講者的那幾筆", () => {
    const g = groupFillers(cands, {}, words, { turns, only: "guest" });
    expect(g).toHaveLength(1);
    expect(g[0].ids).toEqual(["d"]);
  });

  it("跨在換人邊界上的候選歸給重疊最久的那個人", () => {
    // "c" 是 900–1200：主持人段落佔 100ms、來賓段落佔 0 → 算主持人
    expect(groupFillers(cands, {}, words, { turns, only: "host" }).flatMap((g) => g.ids).sort()).toEqual(["a", "c"]);
  });

  it("判不出講者的候選在篩選時排除（不確定是誰的不該被整群剪掉）", () => {
    const orphan = [cand("z", [4], 5000, 5400)];
    expect(groupFillers(orphan, {}, words, { turns, only: "host" })).toEqual([]);
  });

  it("only 沒給就是全部人（跟沒有講者標籤時一樣）", () => {
    const all = groupFillers(cands, {}, words, { turns });
    expect(all.flatMap((g) => g.ids).sort()).toEqual(["a", "c", "d"]);
    expect(all).toEqual(groupFillers(cands, {}, words));
  });
});
