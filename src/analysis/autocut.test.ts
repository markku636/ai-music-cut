import { describe, expect, it } from "vitest";
import { DEFAULT_FILLER_PLAN, planFillerCuts, RELIABLE_KINDS, savedOf, SUGGEST_ONLY_KINDS } from "./autocut";
import { normalizeQuery } from "./textSearch";
import type { Transcript, Word } from "./types";

/** 每個字 200 ms。 */
function make(texts: string[]): Transcript {
  const words: Word[] = texts.map((text, i) => ({
    id: i,
    segId: 0,
    text,
    norm: normalizeQuery(text),
    startMs: i * 200,
    endMs: i * 200 + 180,
    prob: 0.9,
  }));
  const sentences = [];
  for (let i = 0; i < words.length; i += 6) {
    const chunk = words.slice(i, i + 6);
    sentences.push({ id: sentences.length, wordIds: chunk.map((w) => w.id), startMs: chunk[0].startMs, endMs: chunk[chunk.length - 1].endMs, endsWithQuestion: false });
  }
  return { words, segments: [], sentences, vad: [], durationMs: words.length * 200, language: "zh", model: "test" };
}

/** 把 filler 混進 n 個正常字裡。 */
function withFiller(filler: string, times: number, padding: number): Transcript {
  const out: string[] = [];
  for (let i = 0; i < times; i++) {
    out.push(filler);
    for (let k = 0; k < padding; k++) out.push("內");
  }
  return make(out);
}

describe("planFillerCuts", () => {
  it("出現夠多次的口頭禪會被挑出來", () => {
    const tr = withFiller("然後", 20, 40);
    const plan = planFillerCuts(tr, tr.durationMs);
    expect(plan.map((p) => p.query)).toContain("然後");
    expect(plan[0].count).toBe(20);
    expect(plan[0].hits).toHaveLength(20);
  });

  it("次數不夠就不碰 —— 講兩次的是講話，不是習慣", () => {
    const tr = withFiller("然後", 3, 30);
    expect(planFillerCuts(tr, tr.durationMs)).toEqual([]);
  });

  it("佔比太高的詞不碰 —— 那是這一集的主題，不是雜訊", () => {
    // 「那個」佔了將近一半的字：談「那個東西」的一集，剪掉會把內容剪爛
    const tr = withFiller("那個", 40, 1);
    const plan = planFillerCuts(tr, tr.durationMs);
    expect(plan.map((p) => p.query)).not.toContain("那個");
  });

  it("佔比門檻是相對節目長度算的（同樣次數，短節目才會被擋）", () => {
    const tr = withFiller("然後", 20, 40);
    // 真實資料的量級：那一集「然後」198 次佔 1.7%，這裡 ≈2.4%，都在 3% 門檻內
    // 用一個假的「很長的節目」→ 佔比變小 → 過關
    expect(planFillerCuts(tr, tr.durationMs).length).toBeGreaterThan(0);
    // 宣稱節目只有素材的十分之一長 → 佔比爆表 → 擋下
    expect(planFillerCuts(tr, tr.durationMs / 10)).toEqual([]);
  });

  it("最多只挑指定數量", () => {
    const words: string[] = [];
    for (const f of ["然後", "就是", "那個", "嗯", "呃", "對啊"]) {
      for (let i = 0; i < 12; i++) {
        words.push(f);
        for (let k = 0; k < 12; k++) words.push("內");
      }
    }
    const tr = make(words);
    const plan = planFillerCuts(tr, tr.durationMs, { ...DEFAULT_FILLER_PLAN, maxQueries: 2 });
    expect(plan).toHaveLength(2);
  });

  it("沒有逐字稿 / 長度為 0 時回空，不會炸", () => {
    expect(planFillerCuts(null, 1000)).toEqual([]);
    expect(planFillerCuts(make(["一", "二"]), 0)).toEqual([]);
  });

  it("回傳的命中總長是真的加起來的（用來預告會短多少）", () => {
    const tr = withFiller("然後", 10, 40);
    const plan = planFillerCuts(tr, tr.durationMs);
    expect(plan[0].totalMs).toBe(180 * 10);
  });
});

describe("類別分工", () => {
  it("可靠類別與只建議類別不重疊 —— 重疊等於自動剪掉了該問人的東西", () => {
    for (const k of RELIABLE_KINDS) expect(SUGGEST_ONLY_KINDS).not.toContain(k);
  });

  it("unclear / rambling 一定在只建議那一邊", () => {
    expect(SUGGEST_ONLY_KINDS).toContain("unclear");
    expect(SUGGEST_ONLY_KINDS).toContain("rambling");
  });
});

describe("savedOf", () => {
  it("算得出省下多少與百分比", () => {
    const r = savedOf({ srcMs: 3_424_914, outMs: 3_052_800 });
    expect(r.ms).toBe(372_114);
    expect(r.percent).toBeCloseTo(10.9, 0);
  });

  it("成品比來源長時不會回負數（配樂可能拖長成品）", () => {
    expect(savedOf({ srcMs: 1000, outMs: 1500 }).ms).toBe(0);
  });

  it("來源長度 0 不會除以零", () => {
    expect(savedOf({ srcMs: 0, outMs: 0 }).percent).toBe(0);
  });
});
