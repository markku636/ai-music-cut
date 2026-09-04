import { describe, expect, it } from "vitest";
import { cutIndexAt, editedTimeAt, nextCutStart, nextPlayable } from "./skip";

const cuts = [
  { startMs: 1000, endMs: 1500 },
  { startMs: 1500, endMs: 1600 },
  { startMs: 5000, endMs: 6000 },
];

describe("skip", () => {
  it("cutIndexAt / nextPlayable at boundaries", () => {
    expect(cutIndexAt(cuts, 999)).toBe(-1);
    expect(cutIndexAt(cuts, 1000)).toBe(0);
    expect(cutIndexAt(cuts, 1499)).toBe(0);
    expect(cutIndexAt(cuts, 1500)).toBe(1);
    expect(cutIndexAt(cuts, 1600)).toBe(-1);
    expect(nextPlayable(cuts, 1200)).toBe(1500);
    expect(nextPlayable(cuts, 1550)).toBe(1600);
    expect(nextPlayable(cuts, 3000)).toBe(3000);
    expect(nextPlayable([], 3000)).toBe(3000);
  });

  it("nextCutStart", () => {
    expect(nextCutStart(cuts, 0)).toBe(1000);
    expect(nextCutStart(cuts, 1000)).toBe(1500);
    expect(nextCutStart(cuts, 2000)).toBe(5000);
    expect(nextCutStart(cuts, 6000)).toBe(Number.POSITIVE_INFINITY);
  });

  it("editedTimeAt is continuous across cuts", () => {
    expect(editedTimeAt(cuts, 500)).toBe(500);
    expect(editedTimeAt(cuts, 1000)).toBe(1000);
    expect(editedTimeAt(cuts, 1300)).toBe(1000);
    expect(editedTimeAt(cuts, 1600)).toBe(1000);
    expect(editedTimeAt(cuts, 2600)).toBe(2000);
    expect(editedTimeAt(cuts, 7000)).toBe(5400);
  });
});
