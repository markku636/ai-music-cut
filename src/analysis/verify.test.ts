import { describe, expect, it } from "vitest";
import type { Edl } from "./edl/build";
import type { Transcript } from "./types";
import { actualWords, bandedAlign, expectedWords, verifyEdit } from "./verify";

function tr(words: [string, number, number, number?][]): Transcript {
  return {
    words: words.map(([text, s, e, p], i) => ({ id: i, segId: 0, text, norm: text, startMs: s, endMs: e, prob: p ?? 0.95 })),
    segments: [],
    sentences: [],
    vad: [],
    durationMs: words.length ? words[words.length - 1][2] : 0,
    language: "zh",
    model: "test",
  };
}

/** 兩段保留：0–1000（out 0–1000）與 2000–3000（out 1000–2000）；中間剪掉 1000–2000。 */
const EDL: Edl = {
  keeps: [
    { id: 0, srcStartMs: 0, srcEndMs: 1000, outStartMs: 0, outEndMs: 1000, gainDb: 0 },
    { id: 1, srcStartMs: 2000, srcEndMs: 3000, outStartMs: 1000, outEndMs: 2000, gainDb: 0 },
  ],
  joins: [],
  stats: { removedMs: 1000, srcMs: 60_000, keptMs: 2000, outMs: 2000, cutCount: 1, byKind: {} },
  downgrades: [],
  removals: [], rearranged: false,
};

const SRC = tr([
  ["今", 0, 200],
  ["天", 700, 950],
  ["嗯", 1200, 1500],
  ["好", 2100, 2300],
  ["熱", 2300, 2500],
]);

describe("verify", () => {
  it("expectedWords 只留保留段內的字，並換算成品時間", () => {
    const ex = expectedWords(SRC, EDL);
    expect(ex.map((w) => w.text)).toEqual(["今", "天", "好", "熱"]);
    expect(ex[2].outStartMs).toBe(1100); // 2100 − 2000 + 1000
  });

  it("剪得剛好 → 無 finding、接縫乾淨", () => {
    const out = tr([
      ["今", 0, 200],
      ["天", 700, 950],
      ["好", 1100, 1300],
      ["熱", 1300, 1500],
    ]);
    const r = verifyEdit(expectedWords(SRC, EDL), actualWords(out), EDL);
    expect(r.matchRate).toBe(1);
    expect(r.findings).toHaveLength(0);
    expect(r.seams).toHaveLength(1);
    expect(r.seams[0].ok).toBe(true);
  });

  it("接縫吃掉一個字 → missing 且標記在接縫上", () => {
    const out = tr([
      ["今", 0, 200],
      ["好", 1100, 1300],
      ["熱", 1300, 1500],
    ]);
    const r = verifyEdit(expectedWords(SRC, EDL), actualWords(out), EDL);
    const miss = r.findings.filter((f) => f.kind === "missing");
    expect(miss.map((m) => m.expected)).toEqual(["天"]);
    expect(miss[0].nearSeam).toBe(true);
    expect(r.seams[0].ok).toBe(false);
    expect(r.matchRate).toBeLessThan(1);
  });

  it("該剪的字還在 → extra", () => {
    const out = tr([
      ["今", 0, 200],
      ["天", 700, 950],
      ["嗯", 990, 1080],
      ["好", 1100, 1300],
      ["熱", 1300, 1500],
    ]);
    const r = verifyEdit(expectedWords(SRC, EDL), actualWords(out), EDL);
    const extra = r.findings.filter((f) => f.kind === "extra");
    expect(extra.map((e) => e.actual)).toEqual(["嗯"]);
    expect(r.summary).toContain("該剪沒剪 1");
  });

  it("bandedAlign：相同序列全 eq；差一個字有 del", () => {
    expect(bandedAlign(["a", "b", "c"], ["a", "b", "c"]).every((o) => o.op === "eq")).toBe(true);
    const ops = bandedAlign(["a", "b", "c"], ["a", "c"]);
    expect(ops.filter((o) => o.op === "del")).toHaveLength(1);
  });

  it("bandedAlign：band 不夠時自動加寬（長序列大量插入）", () => {
    const a = Array.from({ length: 400 }, (_, i) => String(i % 7));
    const b = [...Array.from({ length: 300 }, () => "z"), ...a];
    const ops = bandedAlign(a, b, 8);
    expect(ops.filter((o) => o.op === "ins").length).toBeGreaterThanOrEqual(300);
  });
});

describe("expectedWords：亂序的 EDL（剪下貼上 / 搬移）", () => {
  const SRC2 = tr([
    ["甲", 0, 400],
    ["乙", 500, 900],
    ["丙", 2000, 2400],
    ["丁", 2500, 2900],
  ]);

  it("貼上：同一段來源在成品出現兩次，預期字也要出現兩次", () => {
    // 成品＝甲乙（來源 0–1000）、丙丁（2000–3000）、丙丁再一次（貼上）
    const edl: Edl = {
      keeps: [
        { id: 0, srcStartMs: 0, srcEndMs: 1000, outStartMs: 0, outEndMs: 1000, gainDb: 0 },
        { id: 1, srcStartMs: 2000, srcEndMs: 3000, outStartMs: 1000, outEndMs: 2000, gainDb: 0 },
        { id: 2, srcStartMs: 2000, srcEndMs: 3000, outStartMs: 2000, outEndMs: 3000, gainDb: 0 },
      ],
      joins: [], stats: { removedMs: 1000, srcMs: 60_000, keptMs: 3000, outMs: 3000, cutCount: 1, byKind: {} },
      downgrades: [], removals: [], rearranged: true,
    };
    const exp = expectedWords(SRC2, edl);
    expect(exp.map((w) => w.text)).toEqual(["甲", "乙", "丙", "丁", "丙", "丁"]);
    // 成品時間必須遞增，而且第二份在後面
    expect(exp.map((w) => w.outStartMs)).toEqual([0, 500, 1000, 1500, 2000, 2500]);
  });

  it("貼上的內容不會被驗收報成「該剪沒剪」", () => {
    const edl: Edl = {
      keeps: [
        { id: 0, srcStartMs: 0, srcEndMs: 1000, outStartMs: 0, outEndMs: 1000, gainDb: 0 },
        { id: 1, srcStartMs: 0, srcEndMs: 1000, outStartMs: 1000, outEndMs: 2000, gainDb: 0 },
      ],
      joins: [], stats: { removedMs: 0, srcMs: 60_000, keptMs: 2000, outMs: 2000, cutCount: 0, byKind: {} },
      downgrades: [], removals: [], rearranged: true,
    };
    // 成品逐字稿：甲乙甲乙（真的講了兩次，因為使用者貼了兩份）
    const out = tr([["甲", 0, 400], ["乙", 500, 900], ["甲", 1000, 1400], ["乙", 1500, 1900]]);
    const rep = verifyEdit(expectedWords(SRC2, edl), actualWords(out), edl);
    // 「該剪沒剪」在報告裡的種類是 extra（成品聽到、預期裡沒有）
    const extra = rep.findings.filter((f) => f.kind === "extra");
    expect(extra).toEqual([]);
    expect(rep.matchRate).toBe(1);
    // 舊寫法只認得一份（expectedChars 2），成品卻有 4 個字 —— 多出來的兩個
    // 就是被指控成「該剪沒剪」的那兩個
    expect(rep.expectedChars).toBe(4);
    expect(rep.actualChars).toBe(4);
  });

  it("搬移：預期字照成品順序排", () => {
    // 成品＝丙丁（來源 2000–3000）在前、甲乙（0–1000）在後
    const edl: Edl = {
      keeps: [
        { id: 0, srcStartMs: 2000, srcEndMs: 3000, outStartMs: 0, outEndMs: 1000, gainDb: 0 },
        { id: 1, srcStartMs: 0, srcEndMs: 1000, outStartMs: 1000, outEndMs: 2000, gainDb: 0 },
      ],
      joins: [], stats: { removedMs: 1000, srcMs: 60_000, keptMs: 2000, outMs: 2000, cutCount: 1, byKind: {} },
      downgrades: [], removals: [], rearranged: true,
    };
    expect(expectedWords(SRC2, edl).map((w) => w.text)).toEqual(["丙", "丁", "甲", "乙"]);
  });
});
