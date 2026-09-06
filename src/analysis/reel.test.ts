import { describe, expect, it } from "vitest";
import { clipUnitsMulti, MIN_REEL_RANGE_MS, normalizeRanges, reelProblem, reelSourceMs, type ReelRange } from "./reel";

const r = (startMs: number, endMs: number, id = `${startMs}`): ReelRange => ({ id, startMs, endMs });

/** 響度單元：帶 keepId 才測得到「同一個保留段裡挑兩段」那個坑。 */
const u = (startMs: number, endMs: number, keepId = "k1") => ({ startMs, endMs, keepId });

describe("normalizeRanges", () => {
  it("排序", () => {
    expect(normalizeRanges([r(5000, 6000), r(1000, 2000)])).toEqual([
      { startMs: 1000, endMs: 2000 },
      { startMs: 5000, endMs: 6000 },
    ]);
  });

  it("合併重疊 —— 不合併的話同一段聲音會在合輯裡出現兩次", () => {
    expect(normalizeRanges([r(1000, 3000), r(2000, 4000)])).toEqual([{ startMs: 1000, endMs: 4000 }]);
  });

  it("相接也要合併 —— 完全連續的地方不該插一個交越", () => {
    expect(normalizeRanges([r(1000, 2000), r(2000, 3000)])).toEqual([{ startMs: 1000, endMs: 3000 }]);
  });

  it("被完全包住的範圍不會多出一段", () => {
    expect(normalizeRanges([r(1000, 9000), r(3000, 4000)])).toEqual([{ startMs: 1000, endMs: 9000 }]);
  });

  it("丟掉空的與無效的", () => {
    expect(normalizeRanges([r(1000, 1000), r(5000, 4000), { id: "x", startMs: Number.NaN, endMs: 10 }])).toEqual([]);
  });

  it("負數起點夾到 0", () => {
    expect(normalizeRanges([r(-500, 1000)])).toEqual([{ startMs: 0, endMs: 1000 }]);
  });
});

describe("clipUnitsMulti", () => {
  const units = [u(0, 5000, "k1"), u(5000, 10_000, "k2"), u(10_000, 20_000, "k3")];

  it("依範圍順序串起來，不是依來源順序", () => {
    // 範圍給的順序是亂的，normalize 會排好
    const got = clipUnitsMulti(units, [r(12_000, 13_000), r(1000, 2000)]);
    expect(got.map((x) => [x.startMs, x.endMs, x.rangeIdx])).toEqual([
      [1000, 2000, 0],
      [12_000, 13_000, 1],
    ]);
  });

  it("每個單元帶著自己屬於第幾個範圍", () => {
    const got = clipUnitsMulti(units, [r(4000, 6000)]);
    // 跨兩個保留段 → 兩個單元，但同屬第 0 個範圍
    expect(got).toHaveLength(2);
    expect(got.every((x) => x.rangeIdx === 0)).toBe(true);
    expect(got.map((x) => x.keepId)).toEqual(["k1", "k2"]);
  });

  it("同一個保留段裡挑兩段：keepId 相同，但 rangeIdx 不同", () => {
    // 這就是不能只看 keepId 判接點的原因 —— 只看 keepId 會判成「同段內邊界」直接對接，
    // 聽起來是中間被挖掉一塊、沒有任何過渡
    const got = clipUnitsMulti([u(0, 20_000, "k1")], [r(1000, 2000), r(15_000, 16_000)]);
    expect(got.map((x) => x.keepId)).toEqual(["k1", "k1"]);
    expect(got.map((x) => x.rangeIdx)).toEqual([0, 1]);
  });

  it("完全落在範圍外的單元不會出現", () => {
    expect(clipUnitsMulti(units, [r(10_500, 11_000)]).map((x) => x.keepId)).toEqual(["k3"]);
  });

  it("重疊的範圍合併之後只出現一次", () => {
    const got = clipUnitsMulti([u(0, 20_000, "k1")], [r(1000, 3000), r(2000, 4000)]);
    expect(got).toHaveLength(1);
    expect([got[0].startMs, got[0].endMs]).toEqual([1000, 4000]);
  });

  it("沒有範圍就沒有東西", () => {
    expect(clipUnitsMulti(units, [])).toEqual([]);
  });
});

describe("reelSourceMs / reelProblem", () => {
  it("素材總長是合併之後的長度", () => {
    expect(reelSourceMs([r(0, 1000), r(500, 2000), r(5000, 6000)])).toBe(3000);
  });

  it("沒有片段就說沒有片段", () => {
    expect(reelProblem([])).toBe("還沒有精華片段");
  });

  it("全部太短就擋下來", () => {
    expect(reelProblem([r(0, MIN_REEL_RANGE_MS - 50)])).toContain("太短");
  });

  it("只要有一段夠長就放行（短的那些串進去也還好）", () => {
    expect(reelProblem([r(0, 100), r(5000, 9000)])).toBeNull();
  });
});
