import { describe, expect, it } from "vitest";
import { parsePersisted } from "./ui";

describe("ui store：持久化還原", () => {
  it("第一次裝（沒存過）→ 簡易", () => {
    expect(parsePersisted(null).mode).toBe("simple");
  });
  it("升級前的舊 blob（沒有 mode）→ 專業，老用戶不會被丟進簡易", () => {
    expect(parsePersisted(JSON.stringify({ tab: "index", railOpen: false, railWidth: 400, density: "compact" })).mode).toBe("pro");
  });
  it("存過 simple 就是 simple；profile / hintsSeen 要驗型別", () => {
    const p = parsePersisted(JSON.stringify({ mode: "simple", profile: "music", hintsSeen: ["a", 3, null, "b"] }));
    expect(p.mode).toBe("simple");
    expect(p.profile).toBe("music");
    expect(p.hintsSeen).toEqual(["a", "b"]);
    expect(parsePersisted(JSON.stringify({ profile: "nope" })).profile).toBeNull();
  });
  it("壞掉的 JSON → 預設（專業）", () => {
    expect(parsePersisted("{not json").mode).toBe("pro");
  });
});
