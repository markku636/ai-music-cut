import { describe, expect, it } from "vitest";
import { stemPath, STEM_LABEL } from "./stems";

describe("stemPath", () => {
  it("在副檔名前面插入軌名", () => {
    expect(stemPath("D:/a/ep12_cut.mp3", "voice")).toBe("D:/a/ep12_cut_voice.mp3");
    expect(stemPath("D:/a/ep12_cut.mp3", "music")).toBe("D:/a/ep12_cut_music.mp3");
  });

  it("完整混音就是原本的路徑", () => {
    expect(stemPath("D:/a/ep12_cut.mp3", "full")).toBe("D:/a/ep12_cut.mp3");
  });

  it("沒有副檔名時接在後面", () => {
    expect(stemPath("D:/a/ep12", "voice")).toBe("D:/a/ep12_voice");
  });

  it("路徑裡有點也不會切錯（只看最後一個點）", () => {
    expect(stemPath("D:/my.podcast/ep12.mp3", "music")).toBe("D:/my.podcast/ep12_music.mp3");
  });

  it("三種軌都有顯示名", () => {
    expect(Object.keys(STEM_LABEL).sort()).toEqual(["full", "music", "voice"]);
  });
});
