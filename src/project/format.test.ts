import { describe, expect, it } from "vitest";
import { buildProjectFile, defaultProjectFileName, parseProjectFile, ProjectFormatError } from "./format";

const snap = {
  media: [{ id: "m1", path: "D:\\pod\\ep1.mp3", name: "ep1.mp3", fingerprint: "abc", probe: null }],
  activeMediaId: "m1",
  settings: { aggressiveness: 60, targetLufs: -16 },
  analysis: {},
};

describe("project format", () => {
  it("round-trips", () => {
    const f = buildProjectFile(snap, { name: "AI Podcast Cut", version: "0.1.0" }, null, new Date("2026-09-04T00:00:00Z"));
    const back = parseProjectFile(JSON.parse(JSON.stringify(f)));
    expect(back.media[0].path).toBe("D:\\pod\\ep1.mp3");
    expect(back.settings.aggressiveness).toBe(60);
    expect(back.createdAt).toBe("2026-09-04T00:00:00.000Z");
  });

  it("keeps createdAt from previous file", () => {
    const f = buildProjectFile(snap, { name: "x", version: "0" }, { createdAt: "2020-01-01T00:00:00.000Z" });
    expect(f.createdAt).toBe("2020-01-01T00:00:00.000Z");
  });

  it("rejects wrong versions and shapes", () => {
    expect(() => parseProjectFile({ schemaVersion: 2, media: [] })).toThrow(ProjectFormatError);
    expect(() => parseProjectFile("nope")).toThrow(ProjectFormatError);
    expect(() => parseProjectFile({ schemaVersion: 1 })).toThrow(ProjectFormatError);
  });

  it("clamps settings and tolerates missing fields", () => {
    const p = parseProjectFile({ schemaVersion: 1, media: [{ id: "a", path: "/x/y.wav" }], settings: { aggressiveness: 500 } });
    expect(p.media[0].name).toBe("y.wav");
    expect(p.settings.aggressiveness).toBe(100);
    expect(p.settings.targetLufs).toBe(-16);
    expect(p.activeMediaId).toBe("a");
  });

  it("never serializes anything that looks like a secret", () => {
    const f = buildProjectFile(snap, { name: "x", version: "0" });
    const json = JSON.stringify(f).toLowerCase();
    for (const bad of ["api_key", "apikey", "x-api-key", "secret", "password", "token"]) {
      expect(json).not.toContain(bad);
    }
  });

  it("derives default file name", () => {
    expect(defaultProjectFileName("ep1.mp3")).toBe("ep1.aicut.json");
    expect(defaultProjectFileName(null)).toBe("untitled.aicut.json");
  });
});
