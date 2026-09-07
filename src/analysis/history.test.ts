import { describe, expect, it } from "vitest";
import { currentIndex, historyRows, relativeTime, stepsTo, type HistoryStep } from "./history";

const step = (label: string, at = 0): HistoryStep => ({ label, at });

describe("historyRows", () => {
  it("第一列永遠是初始狀態", () => {
    const rows = historyRows([], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].index).toBe(0);
    expect(rows[0].current).toBe(true);
  });

  it("past 依序排在後面，最後一筆是目前狀態", () => {
    const rows = historyRows([step("剪除字"), step("接受"), step("一鍵智慧剪輯")], []);
    expect(rows.map((r) => r.label)).toEqual(["", "剪除字", "接受", "一鍵智慧剪輯"]);
    expect(rows.find((r) => r.current)!.index).toBe(3);
  });

  it("future 會被反轉：下一個可重做的排在目前狀態的正下方", () => {
    // 復原時 patch 推到 future 尾巴，所以 future[length-1] 才是下一個要重做的
    const rows = historyRows([step("A")], [step("C"), step("B")]);
    expect(rows.map((r) => r.label)).toEqual(["", "A", "B", "C"]);
  });

  it("被復原的列標成 undone", () => {
    const rows = historyRows([step("A")], [step("C"), step("B")]);
    expect(rows.filter((r) => r.undone).map((r) => r.label)).toEqual(["B", "C"]);
    expect(rows.find((r) => r.label === "A")!.undone).toBe(false);
  });

  it("全部復原時目前狀態回到第一列", () => {
    const rows = historyRows([], [step("B"), step("A")]);
    expect(rows.find((r) => r.current)!.index).toBe(0);
    expect(rows.filter((r) => r.undone)).toHaveLength(2);
  });

  it("初始狀態沒有時間", () => {
    expect(historyRows([step("A", 123)], [])[0].at).toBeNull();
  });
});

describe("currentIndex", () => {
  it("等於已套用的改動數", () => {
    expect(currentIndex([])).toBe(0);
    expect(currentIndex([step("A"), step("B")])).toBe(2);
  });
});

describe("stepsTo", () => {
  const past = [step("A"), step("B"), step("C")];
  const future = [step("E"), step("D")];

  it("往回跳算 undo 次數", () => {
    expect(stepsTo(past, future, 1)).toEqual({ undo: 2, redo: 0 });
  });

  it("往前跳算 redo 次數", () => {
    expect(stepsTo(past, future, 5)).toEqual({ undo: 0, redo: 2 });
  });

  it("跳到目前位置什麼都不做", () => {
    expect(stepsTo(past, future, 3)).toEqual({ undo: 0, redo: 0 });
  });

  it("跳到初始狀態＝全部復原", () => {
    expect(stepsTo(past, future, 0)).toEqual({ undo: 3, redo: 0 });
  });

  it("超出範圍會被夾住", () => {
    expect(stepsTo(past, future, 999)).toEqual({ undo: 0, redo: 2 });
    expect(stepsTo(past, future, -999)).toEqual({ undo: 3, redo: 0 });
  });

  it("小數會被四捨五入而不是產生半步", () => {
    expect(stepsTo(past, future, 1.4)).toEqual({ undo: 2, redo: 0 });
  });
});

describe("relativeTime", () => {
  const now = 1_000_000_000;
  it("五秒內是「剛剛」", () => {
    expect(relativeTime(now - 2000, now)).toBe("剛剛");
  });
  it("一分鐘內給秒", () => {
    expect(relativeTime(now - 30_000, now)).toBe("30 秒前");
  });
  it("一小時內給分", () => {
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 分前");
  });
  it("超過一小時給小時", () => {
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 小時前");
  });
  it("未來時間不會變成負的", () => {
    expect(relativeTime(now + 10_000, now)).toBe("剛剛");
  });
});
