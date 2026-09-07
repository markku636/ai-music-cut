import { describe, expect, it } from "vitest";
import { DEFAULT_BATCH_STEPS, planForMedia, summarizeBatch, type BatchItemResult, type BatchSteps } from "./batch";

function item(p: Partial<BatchItemResult>): BatchItemResult {
  return { mediaId: "m", name: "a.mp3", status: "done", srcMs: 0, outMs: 0, savedMs: 0, steps: [], ...p };
}

describe("planForMedia", () => {
  const all: BatchSteps = { analyze: true, autoCut: true, judge: true, render: true };

  it("沒有逐字稿時四步都跑", () => {
    const p = planForMedia(all, { hasTranscript: false, forceTranscribe: false });
    expect(p.map((x) => [x.key, x.run])).toEqual([
      ["analyze", true],
      ["autoCut", true],
      ["judge", true],
      ["render", true],
    ]);
  });

  it("已經有逐字稿就跳過分析（那是整條路最慢最花錢的一步）", () => {
    const p = planForMedia(all, { hasTranscript: true, forceTranscribe: false });
    const a = p.find((x) => x.key === "analyze")!;
    expect(a.run).toBe(false);
    expect(a.skipNote).toBe("已經有逐字稿");
    // 其他三步照跑
    expect(p.filter((x) => x.key !== "analyze").every((x) => x.run)).toBe(true);
  });

  it("forceTranscribe 會蓋過快取", () => {
    const p = planForMedia(all, { hasTranscript: true, forceTranscribe: true });
    expect(p.find((x) => x.key === "analyze")!.run).toBe(true);
  });

  it("關掉的步驟不會有跳過說明（它根本沒被要求）", () => {
    const p = planForMedia({ ...all, analyze: false }, { hasTranscript: true, forceTranscribe: false });
    const a = p.find((x) => x.key === "analyze")!;
    expect(a.run).toBe(false);
    expect(a.skipNote).toBeUndefined();
  });

  it("順序固定：分析 → 智慧剪輯 → 判讀 → 輸出", () => {
    const p = planForMedia(all, { hasTranscript: false, forceTranscribe: false });
    expect(p.map((x) => x.key)).toEqual(["analyze", "autoCut", "judge", "render"]);
  });

  it("預設不跑 AI 判讀（慢又要錢）", () => {
    expect(DEFAULT_BATCH_STEPS.judge).toBe(false);
    expect(DEFAULT_BATCH_STEPS.analyze && DEFAULT_BATCH_STEPS.autoCut && DEFAULT_BATCH_STEPS.render).toBe(true);
  });
});

describe("summarizeBatch", () => {
  it("加總跑完的那幾集", () => {
    const s = summarizeBatch([
      item({ srcMs: 100_000, outMs: 90_000, savedMs: 10_000 }),
      item({ srcMs: 200_000, outMs: 170_000, savedMs: 30_000 }),
    ]);
    expect(s).toEqual({ total: 2, done: 2, failed: 0, canceled: 0, srcMs: 300_000, outMs: 260_000, savedMs: 40_000, ratio: 40_000 / 300_000 });
  });

  it("失敗那集不進加總（srcMs 可能是 0，混進去會讓比例失真）", () => {
    const s = summarizeBatch([
      item({ srcMs: 100_000, outMs: 90_000, savedMs: 10_000 }),
      item({ status: "failed", error: "boom" }),
    ]);
    expect([s.done, s.failed]).toEqual([1, 1]);
    expect(s.srcMs).toBe(100_000);
    expect(s.ratio).toBeCloseTo(0.1);
  });

  it("取消的算 canceled，也不進加總", () => {
    const s = summarizeBatch([item({ status: "canceled", srcMs: 999 })]);
    expect([s.done, s.canceled, s.srcMs]).toEqual([0, 1, 0]);
  });

  it("全部失敗時比例是 0 而不是 NaN", () => {
    const s = summarizeBatch([item({ status: "failed" }), item({ status: "failed" })]);
    expect(s.ratio).toBe(0);
    expect(Number.isNaN(s.ratio)).toBe(false);
  });

  it("空清單不會炸", () => {
    expect(summarizeBatch([])).toEqual({ total: 0, done: 0, failed: 0, canceled: 0, srcMs: 0, outMs: 0, savedMs: 0, ratio: 0 });
  });
});
