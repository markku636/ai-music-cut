import { beforeEach, describe, expect, it } from "vitest";
import { subscribeTick, tickCount, tickRunning, TICK_PRIORITY, __setScheduler } from "./ticker";

/** 假 rAF：手動推進，才能斷言「一幀裡誰先跑」。 */
function fakeScheduler() {
  const queue = new Map<number, () => void>();
  let next = 1;
  __setScheduler(
    (cb) => {
      const h = next++;
      queue.set(h, cb);
      return h;
    },
    (h) => {
      queue.delete(h);
    },
  );
  return {
    /** 跑掉目前排隊的那一幀（回呼裡排的下一幀留到下次）。 */
    frame() {
      const now = [...queue.entries()];
      queue.clear();
      for (const [, cb] of now) cb();
    },
    pending: () => queue.size,
  };
}

describe("ticker", () => {
  let sched: ReturnType<typeof fakeScheduler>;
  beforeEach(() => {
    sched = fakeScheduler();
  });

  it("依 priority 由小到大跑，跟訂閱順序無關", () => {
    const order: string[] = [];
    subscribeTick(() => order.push("draw"), TICK_PRIORITY.draw);
    subscribeTick(() => order.push("skip"), TICK_PRIORITY.skip);
    subscribeTick(() => order.push("store"), TICK_PRIORITY.store);
    subscribeTick(() => order.push("effects"), TICK_PRIORITY.effects);
    sched.frame();
    expect(order).toEqual(["skip", "effects", "store", "draw"]);
  });

  it("priority 相同時依訂閱順序", () => {
    const order: string[] = [];
    subscribeTick(() => order.push("a"), 5);
    subscribeTick(() => order.push("b"), 5);
    sched.frame();
    expect(order).toEqual(["a", "b"]);
  });

  it("有訂閱者就持續排下一幀，全退訂後停掉", () => {
    const un = subscribeTick(() => {}, 0);
    expect(tickRunning()).toBe(true);
    sched.frame();
    expect(sched.pending()).toBe(1);
    un();
    expect(tickCount()).toBe(0);
    expect(tickRunning()).toBe(false);
    expect(sched.pending()).toBe(0);
  });

  it("單一 subscriber 丟例外不會拖垮其他人與迴圈", () => {
    const seen: string[] = [];
    subscribeTick(() => {
      throw new Error("boom");
    }, 0);
    subscribeTick(() => seen.push("ok"), 10);
    expect(() => sched.frame()).not.toThrow();
    expect(seen).toEqual(["ok"]);
    expect(tickRunning()).toBe(true);
  });

  it("退訂兩次不會誤停還活著的迴圈", () => {
    const un = subscribeTick(() => {}, 0);
    subscribeTick(() => {}, 1);
    un();
    un();
    expect(tickCount()).toBe(1);
    expect(tickRunning()).toBe(true);
  });
});
