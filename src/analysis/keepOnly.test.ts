import { describe, expect, it } from "vitest";
import { complement, DEFAULT_KEEP_ONLY, keepSpans, planKeepOnly, wordIdsIn } from "./keepOnly";
import type { Sentence, Transcript, Word } from "./types";

function sent(id: number, startMs: number, endMs: number, wordIds: number[] = []): Sentence {
  return { id, wordIds, startMs, endMs, endsWithQuestion: false };
}

function word(id: number, startMs: number, endMs: number): Word {
  return { id, segId: 0, text: "x", norm: "x", startMs, endMs, prob: 0.9 };
}

function tr(sentences: Sentence[], words: Word[] = []): Transcript {
  return { words, segments: [], sentences, durationMs: 60_000, vad: [], language: "zh", model: "test" } as unknown as Transcript;
}

describe("keepSpans", () => {
  const sentences = [sent(0, 0, 2000), sent(1, 3000, 5000), sent(2, 20_000, 22_000), sent(3, 22_300, 24_000)];

  it("只留被點名的句子", () => {
    const k = keepSpans(sentences, [2], 60_000, { padMs: 0, mergeGapMs: 0 });
    expect(k).toEqual([{ startMs: 20_000, endMs: 22_000 }]);
  });

  it("加邊距（句子頭尾的氣音不要被切掉）", () => {
    const k = keepSpans(sentences, [1], 60_000, { padMs: 100, mergeGapMs: 0 });
    expect(k).toEqual([{ startMs: 2900, endMs: 5100 }]);
  });

  it("靠得近的併起來（不然兩句之間會留一個洞，聽起來像跳針）", () => {
    const k = keepSpans(sentences, [2, 3], 60_000, { padMs: 0, mergeGapMs: 700 });
    expect(k).toEqual([{ startMs: 20_000, endMs: 24_000 }]);
  });

  it("隔太遠的不併", () => {
    const k = keepSpans(sentences, [0, 2], 60_000, { padMs: 0, mergeGapMs: 700 });
    expect(k).toHaveLength(2);
  });

  it("邊距不會超出檔案頭尾", () => {
    const k = keepSpans([sent(0, 0, 1000)], [0], 1000, { padMs: 500, mergeGapMs: 0 });
    expect(k).toEqual([{ startMs: 0, endMs: 1000 }]);
  });

  it("回傳依時間排序（句子 id 順序不影響）", () => {
    const k = keepSpans(sentences, [3, 0], 60_000, { padMs: 0, mergeGapMs: 0 });
    expect(k[0].startMs).toBeLessThan(k[1].startMs);
  });

  it("沒點名任何句子就是空的", () => {
    expect(keepSpans(sentences, [], 60_000)).toEqual([]);
  });
});

describe("complement", () => {
  it("中間一段保留 → 前後各一段剪除", () => {
    expect(complement([{ startMs: 10_000, endMs: 20_000 }], 60_000)).toEqual([
      { startMs: 0, endMs: 10_000 },
      { startMs: 20_000, endMs: 60_000 },
    ]);
  });

  it("從頭開始的保留不會產生長度 0 的剪除", () => {
    expect(complement([{ startMs: 0, endMs: 10_000 }], 60_000)).toEqual([{ startMs: 10_000, endMs: 60_000 }]);
  });

  it("涵蓋整段時沒有東西要剪", () => {
    expect(complement([{ startMs: 0, endMs: 60_000 }], 60_000)).toEqual([]);
  });

  it("沒有保留就是整段剪掉", () => {
    expect(complement([], 60_000)).toEqual([{ startMs: 0, endMs: 60_000 }]);
  });

  it("時長 0 回空的（不會產生負長度）", () => {
    expect(complement([{ startMs: 0, endMs: 10 }], 0)).toEqual([]);
  });
});

describe("planKeepOnly", () => {
  const sentences = [sent(0, 0, 2000), sent(1, 10_000, 12_000), sent(2, 30_000, 32_000)];
  const t = tr(sentences);

  it("命中一句 → 保留一段、剪除兩段", () => {
    const p = planKeepOnly(t, [{ sentenceId: 1 }], 60_000, { padMs: 0, mergeGapMs: 0 });
    expect(p.sentences).toBe(1);
    expect(p.keeps).toEqual([{ startMs: 10_000, endMs: 12_000 }]);
    expect(p.cuts).toHaveLength(2);
    expect(p.keptMs).toBe(2000);
    expect(p.noop).toBe(false);
  });

  it("同一句被命中多次只算一次", () => {
    const p = planKeepOnly(t, [{ sentenceId: 1 }, { sentenceId: 1 }, { sentenceId: 1 }], 60_000, { padMs: 0 });
    expect(p.sentences).toBe(1);
    expect(p.keeps).toHaveLength(1);
  });

  it("沒有命中就是 noop", () => {
    const p = planKeepOnly(t, [], 60_000);
    expect(p.noop).toBe(true);
    expect(p.cuts).toEqual([]);
  });

  it("沒有逐字稿就是 noop", () => {
    expect(planKeepOnly(null, [{ sentenceId: 0 }], 60_000).noop).toBe(true);
  });

  it("命中涵蓋整集時是 noop（沒有東西要剪）", () => {
    const one = tr([sent(0, 0, 60_000)]);
    expect(planKeepOnly(one, [{ sentenceId: 0 }], 60_000, { padMs: 0 }).noop).toBe(true);
  });

  it("負的 sentenceId 被忽略（命中不在任何句子裡）", () => {
    expect(planKeepOnly(t, [{ sentenceId: -1 }], 60_000).noop).toBe(true);
  });

  it("預設值有加邊距與合併（不然會剪出碎片）", () => {
    expect(DEFAULT_KEEP_ONLY.padMs).toBeGreaterThan(0);
    expect(DEFAULT_KEEP_ONLY.mergeGapMs).toBeGreaterThan(0);
  });
});

describe("wordIdsIn", () => {
  const t = tr([], [word(0, 0, 500), word(1, 600, 1000), word(2, 5000, 5500)]);

  it("只收落在區間內的字", () => {
    expect(wordIdsIn(t, { startMs: 0, endMs: 2000 })).toEqual([0, 1]);
  });

  it("剛好在邊界上的不算（endMs 等於區間起點）", () => {
    expect(wordIdsIn(t, { startMs: 500, endMs: 600 })).toEqual([]);
  });

  it("區間在所有字之後回空的", () => {
    expect(wordIdsIn(t, { startMs: 50_000, endMs: 60_000 })).toEqual([]);
  });
});
