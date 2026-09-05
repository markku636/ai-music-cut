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
  stats: { removedMs: 1000, keptMs: 2000, cutCount: 1, byKind: {} },
  downgrades: [],
  removals: [],
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
