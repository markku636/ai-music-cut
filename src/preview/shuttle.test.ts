import { describe, expect, it } from "vitest";
import { isSilentDirection, nextShuttle, shuttleLabel, SHUTTLE_STOPPED, type ShuttleState } from "./shuttle";

const press = (start: ShuttleState, keys: ("J" | "K" | "L")[], opts?: { slow?: boolean }) => keys.reduce((s, k) => nextShuttle(s, k, opts), start);

describe("nextShuttle", () => {
  it("L 連按 → 順向 1x / 2x / 4x，然後停在 4x", () => {
    expect(press(SHUTTLE_STOPPED, ["L"])).toEqual({ dir: 1, rate: 1 });
    expect(press(SHUTTLE_STOPPED, ["L", "L"])).toEqual({ dir: 1, rate: 2 });
    expect(press(SHUTTLE_STOPPED, ["L", "L", "L"])).toEqual({ dir: 1, rate: 4 });
    expect(press(SHUTTLE_STOPPED, ["L", "L", "L", "L"])).toEqual({ dir: 1, rate: 4 });
  });

  it("J 連按 → 倒退 1x / 2x / 4x，然後停在 4x", () => {
    expect(press(SHUTTLE_STOPPED, ["J"])).toEqual({ dir: -1, rate: 1 });
    expect(press(SHUTTLE_STOPPED, ["J", "J"])).toEqual({ dir: -1, rate: 2 });
    expect(press(SHUTTLE_STOPPED, ["J", "J", "J"])).toEqual({ dir: -1, rate: 4 });
    expect(press(SHUTTLE_STOPPED, ["J", "J", "J", "J"])).toEqual({ dir: -1, rate: 4 });
  });

  it("J 與 L 互相抵銷 —— 衝過頭反手點一下是降速，不是立刻倒帶", () => {
    const fast = press(SHUTTLE_STOPPED, ["L", "L", "L"]); // 順向 4x
    expect(nextShuttle(fast, "J")).toEqual({ dir: 1, rate: 2 });
    expect(press(fast, ["J", "J"])).toEqual({ dir: 1, rate: 1 });
    expect(press(fast, ["J", "J", "J"])).toEqual(SHUTTLE_STOPPED);
    expect(press(fast, ["J", "J", "J", "J"])).toEqual({ dir: -1, rate: 1 });
  });

  it("K 一律停", () => {
    expect(nextShuttle({ dir: 1, rate: 4 }, "K")).toEqual(SHUTTLE_STOPPED);
    expect(nextShuttle({ dir: -1, rate: 2 }, "K")).toEqual(SHUTTLE_STOPPED);
    expect(nextShuttle(SHUTTLE_STOPPED, "K")).toEqual(SHUTTLE_STOPPED);
  });

  it("按住 K 再點 J / L → 慢速 0.5x", () => {
    expect(nextShuttle(SHUTTLE_STOPPED, "L", { slow: true })).toEqual({ dir: 1, rate: 0.5 });
    expect(nextShuttle({ dir: 1, rate: 4 }, "J", { slow: true })).toEqual({ dir: -1, rate: 0.5 });
  });

  it("從慢速再按一次會回到整數格", () => {
    expect(nextShuttle({ dir: 1, rate: 0.5 }, "L")).toEqual({ dir: 1, rate: 1 });
    expect(nextShuttle({ dir: 1, rate: 0.5 }, "J")).toEqual(SHUTTLE_STOPPED);
    expect(nextShuttle({ dir: -1, rate: 0.5 }, "J")).toEqual({ dir: -1, rate: 1 });
  });
});

describe("shuttleLabel / isSilentDirection", () => {
  it("停的時候不顯示", () => {
    expect(shuttleLabel(SHUTTLE_STOPPED)).toBe("");
  });

  it("方向與速率都看得到", () => {
    expect(shuttleLabel({ dir: 1, rate: 2 })).toBe("▶▶ 2x");
    expect(shuttleLabel({ dir: -1, rate: 4 })).toBe("◀◀ 4x");
  });

  it("倒退沒有聲音（<audio> 放不出倒轉）", () => {
    expect(isSilentDirection({ dir: -1, rate: 1 })).toBe(true);
    expect(isSilentDirection({ dir: 1, rate: 1 })).toBe(false);
  });
});
