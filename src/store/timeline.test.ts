import { describe, expect, it } from "vitest";
import { clampZoom, MAX_PX_PER_SEC, nextZoom, useTimeline } from "./timeline";

describe("timeline zoom", () => {
  it("clampZoom 夾在 [fit, MAX]", () => {
    expect(clampZoom(0.1, 2)).toBe(2);
    expect(clampZoom(10_000, 2)).toBe(MAX_PX_PER_SEC);
    expect(clampZoom(50, 2)).toBe(50);
  });
  it("nextZoom 放大從 fit 起算、縮回 fit 回 null", () => {
    expect(nextZoom(null, 2, 1.25)).toBeCloseTo(2.5);
    expect(nextZoom(2.5, 2, 0.8)).toBeNull();
    expect(nextZoom(null, 2, 0.8)).toBeNull();
    expect(nextZoom(400, 2, 2)).toBe(MAX_PX_PER_SEC);
  });
  it("setSelection 正規化並丟掉過短的選取", () => {
    const st = useTimeline.getState();
    st.setSelection({ startMs: 5000.4, endMs: 1000.2 });
    expect(useTimeline.getState().selection).toEqual({ startMs: 1000, endMs: 5000 });
    st.setSelection({ startMs: 100, endMs: 110 });
    expect(useTimeline.getState().selection).toBeNull();
  });
});

describe("入點 / 出點（I / O）", () => {
  const reset = () => {
    useTimeline.setState({ selection: null, pendingIn: null, pendingOut: null, snap: { enabled: false, beats: false, seams: false, sentences: false, words: false } });
  };

  it("先 I 再 O 組成一段選取", () => {
    reset();
    // 只標了入點時**不會**產生選取 —— 1 ms 的佔位會被 setSelection 的下限丟掉，
    // 使用者按了 I 再按 O 就什麼都不會發生（這是實機測出來的 bug）
    expect(useTimeline.getState().markIn(5000)).toBe(false);
    expect(useTimeline.getState().selection).toBeNull();
    expect(useTimeline.getState().pendingIn).toBe(5000);
    expect(useTimeline.getState().markOut(9000)).toBe(true);
    expect(useTimeline.getState().selection).toEqual({ startMs: 5000, endMs: 9000 });
    expect(useTimeline.getState().pendingIn).toBeNull();
  });

  it("先 O 再 I 也可以", () => {
    reset();
    expect(useTimeline.getState().markOut(9000)).toBe(false);
    expect(useTimeline.getState().markIn(5000)).toBe(true);
    expect(useTimeline.getState().selection).toEqual({ startMs: 5000, endMs: 9000 });
  });

  it("已經有選取時，I / O 只換那一端", () => {
    reset();
    useTimeline.getState().setSelection({ startMs: 2000, endMs: 8000 });
    expect(useTimeline.getState().markIn(3000)).toBe(true);
    expect(useTimeline.getState().selection).toEqual({ startMs: 3000, endMs: 8000 });
    expect(useTimeline.getState().markOut(7000)).toBe(true);
    expect(useTimeline.getState().selection).toEqual({ startMs: 3000, endMs: 7000 });
  });

  it("出點在入點之前 → 改成重新標入點，不會做出反向選取", () => {
    reset();
    useTimeline.getState().markIn(9000);
    expect(useTimeline.getState().markOut(5000)).toBe(false);
    expect(useTimeline.getState().selection).toBeNull();
    expect(useTimeline.getState().pendingOut).toBe(5000);
  });

  it("清除選取也會清掉單邊的標記", () => {
    reset();
    useTimeline.getState().markIn(5000);
    useTimeline.getState().setSelection(null);
    expect(useTimeline.getState().pendingIn).toBeNull();
  });
});
