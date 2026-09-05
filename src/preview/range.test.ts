import { describe, expect, it } from "vitest";
import { LEAVE_TOLERANCE_MS, rangeTick, TAIL_RAMP_MS, tailGain } from "./range";

describe("rangeTick", () => {
  it("範圍內繼續播", () => {
    expect(rangeTick(1500, 1000, 4000, false)).toBe("play");
    expect(rangeTick(1000, 1000, 4000, false)).toBe("play");
  });

  it("到尾端就停（不循環）", () => {
    expect(rangeTick(4000, 1000, 4000, false)).toBe("stop");
    expect(rangeTick(4016, 1000, 4000, false)).toBe("stop");
  });

  it("到尾端且 loop → 回頭", () => {
    expect(rangeTick(4000, 1000, 4000, true)).toBe("loop");
  });

  it("使用者往回跳出這段就結束範圍模式，小幅度往回不算", () => {
    expect(rangeTick(1000 - LEAVE_TOLERANCE_MS - 1, 1000, 4000, true)).toBe("stop");
    expect(rangeTick(1000 - LEAVE_TOLERANCE_MS + 1, 1000, 4000, false)).toBe("play");
  });

  it("一幀 16.7 ms 的推進最多超出一幀，不會像 timeupdate 那樣超出 250 ms", () => {
    let cur = 3980;
    let frames = 0;
    while (rangeTick(cur, 1000, 4000, false) === "play" && frames < 100) {
      cur += 16.7;
      frames++;
    }
    expect(cur - 4000).toBeLessThan(17);
  });
});

describe("tailGain", () => {
  it("斜坡外維持 1", () => {
    expect(tailGain(3000, 4000, false)).toBe(1);
    expect(tailGain(4000 - TAIL_RAMP_MS, 4000, false)).toBe(1);
  });

  it("斜坡內線性降到 0", () => {
    expect(tailGain(4000 - TAIL_RAMP_MS / 2, 4000, false)).toBeCloseTo(0.5, 6);
    expect(tailGain(4000, 4000, false)).toBe(0);
    expect(tailGain(4100, 4000, false)).toBe(0);
  });

  it("loop 不做斜坡（每圈都淡一次會一頓一頓）", () => {
    expect(tailGain(3999, 4000, true)).toBe(1);
  });
});
