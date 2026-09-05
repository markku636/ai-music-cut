import { beforeEach, describe, expect, it } from "vitest";
import { bindGainTarget, currentGain, releaseGainSource, setGainSource, __resetGains } from "./previewGain";

/** 只需要 volume 欄位，不必真的有 <audio>。 */
function fakeEl() {
  return { volume: 1 } as HTMLAudioElement;
}

describe("previewGain", () => {
  beforeEach(() => {
    __resetGains();
    bindGainTarget(null);
  });

  it("三個來源相乘，不是互相覆蓋", () => {
    setGainSource("effect", 0.5);
    setGainSource("range", 0.5);
    expect(currentGain()).toBeCloseTo(0.25, 6);
  });

  it("釋放一個來源不會把別人的衰減也還原掉", () => {
    setGainSource("effect", 0.4);
    setGainSource("range", 0);
    releaseGainSource("range");
    expect(currentGain()).toBeCloseTo(0.4, 6);
  });

  it("寫進綁定的元素", () => {
    const el = fakeEl();
    bindGainTarget(el);
    setGainSource("effect", 0.25);
    expect(el.volume).toBeCloseTo(0.25, 6);
    releaseGainSource("effect");
    expect(el.volume).toBeCloseTo(1, 6);
  });

  it("夾在 0–1（效果的正增益在預聽時只能到 1）", () => {
    setGainSource("effect", 4);
    expect(currentGain()).toBe(1);
    setGainSource("effect", -2);
    expect(currentGain()).toBe(0);
  });

  it("沒有綁定元素時設定不會爆，之後綁上立刻套用", () => {
    setGainSource("range", 0.5);
    const el = fakeEl();
    bindGainTarget(el);
    expect(el.volume).toBeCloseTo(0.5, 6);
  });
});
