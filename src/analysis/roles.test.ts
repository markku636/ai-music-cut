import { describe, expect, it } from "vitest";
import { BUILTIN_ROLES, overlayRole, roleLabel, rolesInUse, stemPath, stemPlan } from "./roles";
import type { OverlayLane } from "./overlays";

const ov = (lane: OverlayLane, role?: string) => ({ lane, role });

describe("overlayRole", () => {
  it("沒設角色時退回 lane（舊專案讀進來不會是空的）", () => {
    expect(overlayRole(ov("music"))).toBe("music");
    expect(overlayRole(ov("sfx"))).toBe("sfx");
  });

  it("設了就用設的", () => {
    expect(overlayRole(ov("music", "ad"))).toBe("ad");
  });

  it("空白或全空白的角色當成沒設", () => {
    expect(overlayRole(ov("music", "   "))).toBe("music");
    expect(overlayRole(ov("sfx", ""))).toBe("sfx");
  });
});

describe("rolesInUse", () => {
  it("沒有 overlay 就沒有角色", () => {
    expect(rolesInUse([])).toEqual([]);
  });

  it("去重", () => {
    expect(rolesInUse([ov("music"), ov("music"), ov("sfx")])).toEqual(["music", "sfx"]);
  });

  it("內建的照選單順序，自訂的排最後（字典序）", () => {
    const roles = rolesInUse([ov("music", "zebra"), ov("music", "ad"), ov("sfx"), ov("music", "alpha"), ov("music", "intro")]);
    expect(roles).toEqual(["sfx", "intro", "ad", "alpha", "zebra"]);
  });

  it("順序穩定：輸入順序不影響輸出", () => {
    const a = [ov("music", "ad"), ov("sfx"), ov("music", "zzz")];
    expect(rolesInUse(a)).toEqual(rolesInUse([...a].reverse()));
  });
});

describe("roleLabel", () => {
  it("內建的給中文名", () => {
    expect(roleLabel("ad")).toBe("廣告口播");
  });
  it("自訂的原樣顯示", () => {
    expect(roleLabel("我的旁白")).toBe("我的旁白");
  });
});

describe("stemPlan", () => {
  it("沒有 overlay 只出完整混音（不生全靜音的軌）", () => {
    expect(stemPlan([])).toEqual([{ id: "full", kind: "full", label: "完整混音" }]);
  });

  it("有角色時：完整混音 + 人聲 + 每個角色一軌", () => {
    const plan = stemPlan(["music", "ad"]);
    expect(plan.map((s) => s.id)).toEqual(["full", "voice", "music", "ad"]);
    expect(plan.find((s) => s.id === "ad")).toMatchObject({ kind: "role", role: "ad", label: "廣告口播" });
  });

  it("完整混音永遠排第一（後面的軌要沿用它的響度量測）", () => {
    expect(stemPlan(["sfx"])[0].kind).toBe("full");
  });
});

describe("stemPath", () => {
  it("完整混音就是原檔名", () => {
    expect(stemPath("D:/out/ep12.mp3", "full")).toBe("D:/out/ep12.mp3");
  });

  it("其他軌加後綴", () => {
    expect(stemPath("D:/out/ep12.mp3", "voice")).toBe("D:/out/ep12_voice.mp3");
    expect(stemPath("D:/out/ep12.mp3", "ad")).toBe("D:/out/ep12_ad.mp3");
  });

  it("沒有副檔名時直接接在後面", () => {
    expect(stemPath("D:/out/ep12", "voice")).toBe("D:/out/ep12_voice");
  });

  it("自訂角色裡的空白與路徑分隔符換成底線（不然會寫到別的目錄去）", () => {
    expect(stemPath("D:/out/ep12.mp3", "我的 旁白")).toBe("D:/out/ep12_我的_旁白.mp3");
    expect(stemPath("D:/out/ep12.mp3", "a/b")).toBe("D:/out/ep12_a_b.mp3");
    expect(stemPath("D:/out/ep12.mp3", "../evil")).toBe("D:/out/ep12_evil.mp3");
  });

  it("整個角色都是符號時退回 stem 而不是空字串", () => {
    expect(stemPath("D:/out/ep12.mp3", "///")).toBe("D:/out/ep12_stem.mp3");
  });

  it("路徑裡的點不會被當成副檔名分隔（只看最後一個）", () => {
    expect(stemPath("D:/my.folder/ep12.mp3", "voice")).toBe("D:/my.folder/ep12_voice.mp3");
  });
});

describe("BUILTIN_ROLES", () => {
  it("id 不重複", () => {
    expect(new Set(BUILTIN_ROLES.map((r) => r.id)).size).toBe(BUILTIN_ROLES.length);
  });
  it("music 與 sfx 一定在（它們同時是 lane 的預設角色）", () => {
    expect(BUILTIN_ROLES.map((r) => r.id)).toEqual(expect.arrayContaining(["music", "sfx"]));
  });
});
