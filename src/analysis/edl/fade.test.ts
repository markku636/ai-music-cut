import { describe, expect, it } from "vitest";
import { MIDPOINT_PROBE, type EnergyProbe } from "./build";
import { chooseJoin, DEFAULT_FADE_POLICY, QUIET_DB } from "./fade";

/** 指定每個時間點的響度，其餘照 MIDPOINT_PROBE。 */
function probeWith(db: (from: number, to: number) => number): EnergyProbe {
  return { ...MIDPOINT_PROBE, rmsDbAt: db };
}

const P = DEFAULT_FADE_POLICY;

describe("chooseJoin", () => {
  it("gap 一律回 gap，並帶淡出 / 淡入長度", () => {
    const j = chooseJoin(MIDPOINT_PROBE, 1000, 1500, P, 150);
    expect(j).toMatchObject({ kind: "gap", ms: 150, fadeOutMs: P.gapFadeOutMs, fadeInMs: P.gapFadeInMs });
  });

  it("兩側都安靜 → 短交叉（長交叉會吃掉下一個字的字頭）", () => {
    const j = chooseJoin(probeWith(() => -60), 1000, 1500, P, 0);
    expect(j).toMatchObject({ kind: "crossfade", ms: P.quietXfMs });
  });

  it("語音接語音 → 長交叉（要糊掉轉折）", () => {
    const j = chooseJoin(probeWith(() => -18), 1000, 1500, P, 0);
    expect(j.ms).toBe(P.speechXfMs);
  });

  it("一側有聲一側安靜 → 中等", () => {
    const j = chooseJoin(probeWith((from) => (from < 1000 ? -60 : -18)), 1000, 1500, P, 0);
    expect(j.ms).toBe(P.mixedXfMs);
  });

  it("剛好在門檻上算安靜", () => {
    const j = chooseJoin(probeWith(() => QUIET_DB), 1000, 1500, P, 0);
    expect(j.ms).toBe(P.quietXfMs);
  });

  it("沒有 rmsDbAt 的 probe（例如測試用的 MIDPOINT_PROBE）一律當語音接語音 —— 最保守", () => {
    expect(chooseJoin(MIDPOINT_PROBE, 1000, 1500, P, 0).ms).toBe(P.speechXfMs);
  });

  it("不會超過上限（再長就會吃掉字頭）", () => {
    const loud = probeWith(() => 0);
    const j = chooseJoin(loud, 1000, 1500, { ...P, speechXfMs: 999 }, 0);
    expect(j.ms).toBe(P.maxXfMs);
  });
});
