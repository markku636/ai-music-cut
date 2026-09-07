import { describe, expect, it } from "vitest";
import {
  describeMix,
  EMPTY_MIX,
  isAudible,
  isDefault,
  mainGainFactor,
  pruneMix,
  toggleMute,
  toggleSolo,
  VOICE_ROLE,
  type RoleMix,
} from "./roleMix";

const mix = (muted: string[] = [], solo: string[] = []): RoleMix => ({ muted, solo });

describe("isAudible", () => {
  it("預設全部發聲", () => {
    expect(isAudible("music", EMPTY_MIX)).toBe(true);
    expect(isAudible(VOICE_ROLE, EMPTY_MIX)).toBe(true);
  });

  it("靜音的不發聲", () => {
    expect(isAudible("music", mix(["music"]))).toBe(false);
    expect(isAudible("ad", mix(["music"]))).toBe(true);
  });

  it("有獨奏時只有獨奏的發聲", () => {
    const m = mix([], ["music"]);
    expect(isAudible("music", m)).toBe(true);
    expect(isAudible("ad", m)).toBe(false);
    expect(isAudible(VOICE_ROLE, m)).toBe(false);
  });

  it("獨奏蓋過靜音（DAW 的標準規則）", () => {
    // 自己被靜音又被獨奏時，獨奏贏
    expect(isAudible("music", mix(["music"], ["music"]))).toBe(true);
    // 別人被獨奏時，沒被靜音的也不發聲
    expect(isAudible("ad", mix([], ["music"]))).toBe(false);
  });

  it("多個獨奏會一起發聲", () => {
    const m = mix([], ["music", "ad"]);
    expect([isAudible("music", m), isAudible("ad", m), isAudible("sfx", m)]).toEqual([true, true, false]);
  });
});

describe("mainGainFactor", () => {
  it("預設 1", () => {
    expect(mainGainFactor(EMPTY_MIX)).toBe(1);
  });
  it("人聲被靜音時 0", () => {
    expect(mainGainFactor(mix([VOICE_ROLE]))).toBe(0);
  });
  it("獨奏別的角色時人聲也是 0", () => {
    expect(mainGainFactor(mix([], ["music"]))).toBe(0);
  });
  it("獨奏人聲時 1", () => {
    expect(mainGainFactor(mix([], [VOICE_ROLE]))).toBe(1);
  });
});

describe("toggle", () => {
  it("靜音可以開關", () => {
    const a = toggleMute(EMPTY_MIX, "music");
    expect(a.muted).toEqual(["music"]);
    expect(toggleMute(a, "music").muted).toEqual([]);
  });

  it("獨奏可以開關", () => {
    const a = toggleSolo(EMPTY_MIX, "ad");
    expect(a.solo).toEqual(["ad"]);
    expect(toggleSolo(a, "ad").solo).toEqual([]);
  });

  it("排序穩定（順序不影響結果）", () => {
    const a = toggleMute(toggleMute(EMPTY_MIX, "sfx"), "ad");
    const b = toggleMute(toggleMute(EMPTY_MIX, "ad"), "sfx");
    expect(a.muted).toEqual(b.muted);
  });

  it("不會改到原本的物件", () => {
    const before = EMPTY_MIX;
    toggleMute(before, "music");
    expect(before.muted).toEqual([]);
  });
});

describe("isDefault", () => {
  it("沒動過就是 default", () => {
    expect(isDefault(EMPTY_MIX)).toBe(true);
    expect(isDefault(mix(["music"]))).toBe(false);
    expect(isDefault(mix([], ["ad"]))).toBe(false);
  });
});

describe("pruneMix", () => {
  it("丟掉已經不存在的角色", () => {
    // 刪掉最後一段廣告之後 solo 還留著 "ad"，畫面上什麼都沒獨奏卻整個安靜
    expect(pruneMix(mix(["gone"], ["ad"]), ["music"])).toEqual({ muted: [], solo: [] });
  });

  it("人聲永遠留著（它不在 overlay 的角色清單裡）", () => {
    expect(pruneMix(mix([VOICE_ROLE]), [])).toEqual({ muted: [VOICE_ROLE], solo: [] });
  });

  it("沒有變動時回同一個物件（省掉一次重繪）", () => {
    const m = mix(["music"], ["ad"]);
    expect(pruneMix(m, ["music", "ad"])).toBe(m);
  });
});

describe("describeMix", () => {
  const label = (r: string) => ({ voice: "人聲", music: "配樂", ad: "廣告口播" })[r] ?? r;

  it("預設不用講", () => {
    expect(describeMix(EMPTY_MIX, ["music"], label)).toBeNull();
  });

  it("獨奏時說只聽什麼", () => {
    expect(describeMix(mix([], ["music"]), ["music", "ad"], label)).toBe("只聽：配樂");
  });

  it("靜音一部分時也說得出來", () => {
    expect(describeMix(mix(["ad"]), ["music", "ad"], label)).toBe("只聽：人聲、配樂");
  });

  it("全部靜音講清楚（不然會以為壞了）", () => {
    expect(describeMix(mix(["voice", "music"]), ["music"], label)).toBe("全部靜音");
  });

  it("每個都聽得到就不用講（等於預設）", () => {
    expect(describeMix(mix([], ["voice", "music"]), ["music"], label)).toBeNull();
  });
});
