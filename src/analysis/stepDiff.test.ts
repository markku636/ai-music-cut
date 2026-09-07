import { describe, expect, it } from "vitest";
import { audibleChanges, canPartiallyRevert, diffDecisions, revertSubset } from "./stepDiff";
import type { Candidate, DecisionMap, DecisionState } from "./types";

const dec = (state: DecisionState): DecisionMap[string] => ({ state, origin: "rule", at: "" });
const map = (o: Record<string, DecisionState>): DecisionMap =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, dec(v)]));

function cand(id: string, startMs: number): Candidate {
  return { id, kind: "filler", startMs, endMs: startMs + 100, wordIds: [], reason: "", score: 0.9, source: "rule", sentenceId: 0 };
}

const order = [cand("a", 0), cand("b", 1000), cand("c", 2000)];

describe("diffDecisions", () => {
  it("只列出真的變了的", () => {
    const d = diffDecisions(map({ a: "pending", b: "pending" }), map({ a: "accepted", b: "pending" }), order);
    expect(d.map((x) => x.id)).toEqual(["a"]);
    expect(d[0]).toMatchObject({ from: "pending", to: "accepted", wasCut: false, isCut: true });
  });

  it("這一步新增的候選 from 是 null", () => {
    const d = diffDecisions({}, map({ a: "auto" }), order);
    expect(d[0]).toMatchObject({ id: "a", from: null, to: "auto", wasCut: false, isCut: true });
  });

  it("這一步移除的候選 to 是 null", () => {
    const d = diffDecisions(map({ a: "accepted" }), {}, order);
    expect(d[0]).toMatchObject({ id: "a", from: "accepted", to: null, wasCut: true, isCut: false });
  });

  it("依候選的時間排序（跟波形上的順序一致）", () => {
    const d = diffDecisions(map({ c: "pending", a: "pending" }), map({ c: "accepted", a: "accepted" }), order);
    expect(d.map((x) => x.id)).toEqual(["a", "c"]);
  });

  it("不在候選清單裡的排最後（順序仍然穩定）", () => {
    const d = diffDecisions(map({ zz: "pending", b: "pending" }), map({ zz: "accepted", b: "accepted" }), order);
    expect(d.map((x) => x.id)).toEqual(["b", "zz"]);
  });

  it("完全沒變就是空的", () => {
    expect(diffDecisions(map({ a: "auto" }), map({ a: "auto" }), order)).toEqual([]);
  });
});

describe("audibleChanges", () => {
  it("auto → accepted 對使用者沒差別，不列出來", () => {
    const d = diffDecisions(map({ a: "auto" }), map({ a: "accepted" }), order);
    expect(d).toHaveLength(1); // 狀態確實變了
    expect(audibleChanges(d)).toEqual([]); // 但剪不剪沒變
  });

  it("pending → accepted 是聽得出來的差別", () => {
    expect(audibleChanges(diffDecisions(map({ a: "pending" }), map({ a: "accepted" }), order))).toHaveLength(1);
  });

  it("accepted → rejected 也是", () => {
    expect(audibleChanges(diffDecisions(map({ a: "accepted" }), map({ a: "rejected" }), order))).toHaveLength(1);
  });
});

describe("revertSubset", () => {
  it("只換回選中的那幾筆", () => {
    const before = map({ a: "pending", b: "pending" });
    const current = map({ a: "accepted", b: "accepted" });
    const next = revertSubset(current, before, ["a"]);
    expect(next.a.state).toBe("pending");
    expect(next.b.state).toBe("accepted");
  });

  it("這一步之後改的其他東西不受影響（不是整步還原）", () => {
    const before = map({ a: "pending" });
    const current = map({ a: "accepted", later: "rejected" });
    const next = revertSubset(current, before, ["a"]);
    expect(next.later.state).toBe("rejected");
  });

  it("這一步之前不存在的候選會被刪掉而不是留下垃圾", () => {
    const next = revertSubset(map({ a: "accepted" }), {}, ["a"]);
    expect(next.a).toBeUndefined();
  });

  it("不改到原本的物件", () => {
    const current = map({ a: "accepted" });
    revertSubset(current, map({ a: "pending" }), ["a"]);
    expect(current.a.state).toBe("accepted");
  });

  it("選空的就是原樣", () => {
    const current = map({ a: "accepted" });
    expect(revertSubset(current, map({ a: "pending" }), [])).toEqual(current);
  });
});

describe("canPartiallyRevert", () => {
  it("只改了一筆時整步還原就夠了", () => {
    expect(canPartiallyRevert(diffDecisions(map({ a: "pending" }), map({ a: "accepted" }), order))).toBe(false);
  });

  it("改了多筆才值得部分還原", () => {
    const d = diffDecisions(map({ a: "pending", b: "pending" }), map({ a: "accepted", b: "accepted" }), order);
    expect(canPartiallyRevert(d)).toBe(true);
  });
});
