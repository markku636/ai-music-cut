import { describe, expect, it } from "vitest";
import type { QcFinding } from "../audioQc";
import { alreadyRepaired, declipRanges, repairsForQc } from "./repairs";

const f = (kind: QcFinding["kind"], startMs: number, endMs: number, value = 1): QcFinding => ({ kind, startMs, endMs, value });

describe("repairsForQc", () => {
  it("削波 → 去削波，前後各 100 ms，重疊合併，夾在檔案長度內", () => {
    const r = declipRanges([f("clipping", 50, 120), f("clipping", 250, 300), f("clipping", 5000, 5100), f("clipping", 59_950, 60_000)], 60_000);
    expect(r).toEqual([
      { startMs: 0, endMs: 400 },
      { startMs: 4900, endMs: 5200 },
      { startMs: 59_850, endMs: 60_000 },
    ]);
  });
  it("產出的效果帶 origin=qc、params、唯一 id", () => {
    const plans = repairsForQc([f("clipping", 1000, 1050), f("dc_offset", 0, 60_000, 3)], 60_000);
    expect(plans.map((p) => p.kind)).toEqual(["clipping", "dc_offset"]);
    expect(plans[0].effects[0]).toMatchObject({ kind: "declip", startMs: 900, endMs: 1150, origin: "qc", params: { threshold: 10 } });
    expect(plans[1].effects[0]).toMatchObject({ kind: "dc", startMs: 0, endMs: 60_000 });
    expect(new Set(plans.flatMap((p) => p.effects.map((e) => e.id))).size).toBe(2);
  });
  it("音量突變 / 長空白不產生修復", () => {
    expect(repairsForQc([f("level_jump", 0, 1, 9), f("dead_air", 0, 5000, 5000)], 60_000)).toEqual([]);
  });
  it("alreadyRepaired：全部區段都被蓋到才算修過", () => {
    const plans = repairsForQc([f("clipping", 1000, 1050), f("clipping", 8000, 8020), f("dc_offset", 0, 1, 2)], 60_000);
    const clip = plans[0];
    expect(alreadyRepaired("clipping", clip, [])).toBe(false);
    expect(alreadyRepaired("clipping", clip, [clip.effects[0]])).toBe(false);
    expect(alreadyRepaired("clipping", clip, clip.effects)).toBe(true);
    expect(alreadyRepaired("dc_offset", plans[1], [{ id: "x", kind: "dc", startMs: 0, endMs: 60_000 }])).toBe(true);
    expect(alreadyRepaired("clipping", undefined, [])).toBe(false);
  });
});
