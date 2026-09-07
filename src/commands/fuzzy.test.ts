import { describe, expect, it } from "vitest";
import { fuzzyMatch, rank } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("中文子字串命中；逐字順序錯的對不到", () => {
    expect(fuzzyMatch("降噪", "降噪整集（建議值）")?.ranges).toEqual([[0, 2]]);
    expect(fuzzyMatch("噪降", "降噪整集（建議值）")).toBeNull();
  });
  it("英文子序列：dns → denoise", () => {
    const m = fuzzyMatch("dns", "denoise");
    expect(m).not.toBeNull();
    expect(m!.ranges[0][0]).toBe(0);
  });
  it("前綴比中段高分", () => {
    const a = fuzzyMatch("輸出", "輸出驗收")!.score;
    const b = fuzzyMatch("輸出", "只輸出選取範圍…")!.score;
    expect(a).toBeGreaterThan(b);
  });
  it("空查詢命中全部、score 0", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, ranges: [] });
  });
  it("大小寫不分", () => {
    expect(fuzzyMatch("CTRL+S", "Ctrl+S")).not.toBeNull();
  });
});

describe("rank", () => {
  const items = [
    { id: "a", texts: ["降噪整集（建議值）", "降噪整集（建議值）", "denoise noise"] },
    { id: "b", texts: ["Save project", "儲存專案", "Ctrl+S"] },
    { id: "c", texts: ["修聲（降噪 / 去隆隆 / 齒音）…", "修聲（降噪 / 去隆隆 / 齒音）…"] },
  ];
  it("英文介面打中文也命中（比的是繁中原文那一欄）", () => {
    const r = rank("儲存", items);
    expect(r.map((x) => x.id)).toEqual(["b"]);
    expect(r[0].field).toBe(1);
  });
  it("快捷鍵文字也能搜", () => {
    expect(rank("ctrl+s", items).map((x) => x.id)).toEqual(["b"]);
  });
  it("前綴命中排在中段命中前面", () => {
    expect(rank("降噪", items).map((x) => x.id)).toEqual(["a", "c"]);
  });
  it("空查詢回傳全部、維持原順序", () => {
    expect(rank("", items).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
});
