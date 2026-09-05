import { describe, expect, it } from "vitest";
import { ffmpegSourceLabel, shortFfmpegVersion } from "./ffmpegSource";

describe("shortFfmpegVersion", () => {
  it("內建的 BtbN LGPL build", () => {
    expect(shortFfmpegVersion("n8.1.2-50-g1a748fe2cd-20260904")).toBe("8.1.2");
  });

  it("gyan.dev 的 essentials build", () => {
    expect(shortFfmpegVersion("7.1-essentials_build-www.gyan.dev")).toBe("7.1");
  });

  it("發行版套件的乾淨版本號", () => {
    expect(shortFfmpegVersion("6.0")).toBe("6.0");
    expect(shortFfmpegVersion("n7.1")).toBe("7.1");
  });

  it("空值不會炸", () => {
    expect(shortFfmpegVersion(null)).toBe("");
    expect(shortFfmpegVersion(undefined)).toBe("");
    expect(shortFfmpegVersion("  ")).toBe("");
  });
});

describe("ffmpegSourceLabel", () => {
  it("四種來源各有中文標籤", () => {
    for (const s of ["bundled", "custom", "path", "common"]) {
      expect(ffmpegSourceLabel(s)).not.toBe(s);
      expect(ffmpegSourceLabel(s).length).toBeGreaterThan(0);
    }
  });

  it("沒見過的來源就原樣顯示（不要變成空字串）", () => {
    expect(ffmpegSourceLabel("flatpak")).toBe("flatpak");
    expect(ffmpegSourceLabel(null)).toBe("");
  });
});
