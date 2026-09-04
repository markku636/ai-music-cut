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
