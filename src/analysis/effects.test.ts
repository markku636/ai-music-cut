import { describe, expect, it } from "vitest";
import { effectGain, effectGainAt, effectLabel, type AudioEffect } from "./effects";

describe("effects envelope", () => {
  const mute: AudioEffect = { id: "m", kind: "mute", startMs: 1000, endMs: 2000 };
  it("mute：中間 0、邊緣 5 ms 平滑、範圍外 1", () => {
    expect(effectGain(mute, 1500)).toBe(0);
    expect(effectGain(mute, 999)).toBe(1);
    expect(effectGain(mute, 2000)).toBe(1);
    expect(effectGain(mute, 1002.5)).toBeCloseTo(0.5);
    expect(effectGain(mute, 1997.5)).toBeCloseTo(0.5);
  });
  it("gain：+6 dB ≈ ×2，−6 dB ≈ ×0.5", () => {
    expect(effectGain({ id: "g", kind: "gain", startMs: 0, endMs: 1000, db: 6 }, 500)).toBeCloseTo(1.995, 2);
    expect(effectGain({ id: "g", kind: "gain", startMs: 0, endMs: 1000, db: -6 }, 500)).toBeCloseTo(0.501, 2);
  });
  it("fade_in / fade_out 線性", () => {
    expect(effectGain({ id: "f", kind: "fade_in", startMs: 0, endMs: 1000 }, 250)).toBeCloseTo(0.25);
    expect(effectGain({ id: "f", kind: "fade_out", startMs: 0, endMs: 1000 }, 250)).toBeCloseTo(0.75);
  });
  it("多個效果相乘", () => {
    const fx: AudioEffect[] = [
      { id: "a", kind: "gain", startMs: 0, endMs: 1000, db: 6 },
      { id: "b", kind: "fade_out", startMs: 0, endMs: 1000 },
    ];
    expect(effectGainAt(fx, 500)).toBeCloseTo(1.995 * 0.5, 2);
  });
  it("label", () => {
    expect(effectLabel({ id: "g", kind: "gain", startMs: 0, endMs: 1, db: 3 })).toBe("+3 dB");
    expect(effectLabel({ id: "m", kind: "mute", startMs: 0, endMs: 1 })).toBe("靜音");
  });
});
