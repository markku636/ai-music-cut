import { describe, expect, it } from "vitest";
import { baseName, isOpenablePath, kindOf, pushRecent, RECENT_MAX, removeRecent } from "./recent";

describe("recent", () => {
  it("baseName 兩種分隔線都認得", () => {
    expect(baseName("C:\\a\\b\\ep12.mp3")).toBe("ep12.mp3");
    expect(baseName("/x/y/ep12.aicut.json")).toBe("ep12.aicut.json");
  });
  it("kindOf / isOpenablePath", () => {
    expect(kindOf("a.aicut.json")).toBe("project");
    expect(kindOf("a.mp3")).toBe("audio");
    expect(isOpenablePath("a.txt")).toBe(false);
    expect(isOpenablePath("a.WAV")).toBe(true);
  });
  it("pushRecent：放最前、去重、封頂", () => {
    let l: string[] = [];
    for (let i = 0; i < RECENT_MAX + 3; i++) l = pushRecent(l, `f${i}`);
    expect(l).toHaveLength(RECENT_MAX);
    expect(l[0]).toBe(`f${RECENT_MAX + 2}`);
    const again = pushRecent(l, "f5");
    expect(again[0]).toBe("f5");
    expect(again.filter((x) => x === "f5")).toHaveLength(1);
  });
  it("removeRecent", () => {
    expect(removeRecent(["a", "b"], "a")).toEqual(["b"]);
  });
});
