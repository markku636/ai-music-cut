import { describe, expect, it } from "vitest";
import type { Candidate, DecisionMap } from "../analysis/types";
import { advanceAfterDecision, queueProgress, reviewQueue, stepQueue } from "./queue";

function c(id: string, startMs: number, kind: Candidate["kind"] = "filler"): Candidate {
  return { id, kind, startMs, endMs: startMs + 200, wordIds: [], reason: "r", score: 0.5, source: "rule", sentenceId: 0 };
}

const CANDS = [c("a", 100), c("b", 500), c("c", 900), c("d", 1300)];

describe("reviewQueue", () => {
  it("只收未決的", () => {
    const dec: DecisionMap = {
      a: { state: "accepted", origin: "user", at: "" },
      b: { state: "rejected", origin: "user", at: "" },
    };
    expect(reviewQueue(CANDS, dec).map((x) => x.id)).toEqual(["c", "d"]);
  });

  it("被守門降級的即使已決定也要人看一眼", () => {
    const dec: DecisionMap = {
      a: { state: "accepted", origin: "llm", at: "" },
      b: { state: "rejected", origin: "user", at: "" },
      c: { state: "accepted", origin: "user", at: "" },
      d: { state: "rejected", origin: "user", at: "" },
    };
    const q = reviewQueue(CANDS, dec, { downgrades: [{ candidateId: "c", reason: "整句剪太多" }] });
    expect(q.map((x) => x.id)).toEqual(["c"]);
  });

  it("兩個 agent 意見分歧的也收（R5 之後才有）", () => {
    const dec: DecisionMap = { a: { state: "accepted", origin: "llm", at: "" } };
    const q = reviewQueue([CANDS[0]], dec, { conflictIds: new Set(["a"]) });
    expect(q.map((x) => x.id)).toEqual(["a"]);
  });

  it("類型篩選", () => {
    const mixed = [c("a", 100, "filler"), c("b", 500, "long_pause")];
    expect(reviewQueue(mixed, {}, { kinds: new Set(["long_pause"]) }).map((x) => x.id)).toEqual(["b"]);
  });

  it("依時間排序（候選陣列不保證有序）", () => {
    expect(reviewQueue([c("z", 900), c("y", 100)], {}).map((x) => x.id)).toEqual(["y", "z"]);
  });
});

describe("stepQueue", () => {
  const q = reviewQueue(CANDS, {});

  it("沒有目前項目就從頭 / 從尾開始", () => {
    expect(stepQueue(q, null, 1)?.id).toBe("a");
    expect(stepQueue(q, null, -1)?.id).toBe("d");
  });

  it("前後移動", () => {
    expect(stepQueue(q, "b", 1)?.id).toBe("c");
    expect(stepQueue(q, "b", -1)?.id).toBe("a");
  });

  it("到底不繞回去（免得以為還有東西沒審）", () => {
    expect(stepQueue(q, "d", 1)).toBeNull();
    expect(stepQueue(q, "a", -1)).toBeNull();
  });

  it("空佇列", () => {
    expect(stepQueue([], "a", 1)).toBeNull();
  });
});

describe("advanceAfterDecision", () => {
  const before = reviewQueue(CANDS, {});

  it("決定完往後走一格（這才是「決定並自動前進」）", () => {
    const after = before.filter((x) => x.id !== "b");
    expect(advanceAfterDecision(before, after, "b")?.id).toBe("c");
  });

  it("整組決定會一次拿掉好幾筆 → 跳到下一個還在的", () => {
    const after = before.filter((x) => !["b", "c"].includes(x.id));
    expect(advanceAfterDecision(before, after, "b")?.id).toBe("d");
  });

  it("處理到最後一筆 → 往前退，不要直接跳走", () => {
    const after = before.filter((x) => x.id !== "d");
    expect(advanceAfterDecision(before, after, "d")?.id).toBe("c");
  });

  it("全部清空 → null", () => {
    expect(advanceAfterDecision(before, [], "b")).toBeNull();
  });
});

describe("queueProgress", () => {
  it("done = 一開始的總數減掉現在剩的", () => {
    expect(queueProgress(80, 68, 10_000)).toMatchObject({ done: 12, total: 80 });
  });

  it("速率要等一秒以上才給（避免一開始出現荒謬的數字）", () => {
    expect(queueProgress(80, 79, 500).rate).toBeNull();
    expect(queueProgress(80, 68, 10_000).rate).toBeCloseTo(1.2, 6);
  });

  it("還沒決定任何一筆時沒有速率", () => {
    expect(queueProgress(80, 80, 10_000).rate).toBeNull();
  });
});
