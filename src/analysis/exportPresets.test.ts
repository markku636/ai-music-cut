import { describe, expect, it } from "vitest";
import {
  allPresets,
  BUILTIN_PRESETS,
  matchPreset,
  parseUserPresets,
  presetId,
  removeUserPreset,
  sameShape,
  saveUserPreset,
  type ExportPreset,
  type PresetShape,
} from "./exportPresets";

const shape = (o: Partial<PresetShape> = {}): PresetShape => ({
  format: "mp3",
  targetLufs: -16,
  leveling: true,
  stems: false,
  ...o,
});

describe("BUILTIN_PRESETS", () => {
  it("id 與名稱都不重複", () => {
    expect(new Set(BUILTIN_PRESETS.map((p) => p.id)).size).toBe(BUILTIN_PRESETS.length);
    expect(new Set(BUILTIN_PRESETS.map((p) => p.label)).size).toBe(BUILTIN_PRESETS.length);
  });

  it("每一個都說得出為什麼是這些值", () => {
    expect(BUILTIN_PRESETS.every((p) => (p.note ?? "").length > 0)).toBe(true);
  });

  it("平台規範沒寫錯", () => {
    expect(BUILTIN_PRESETS.find((p) => p.id === "podcast")!.targetLufs).toBe(-16);
    expect(BUILTIN_PRESETS.find((p) => p.id === "music-platform")!.targetLufs).toBe(-14);
    expect(BUILTIN_PRESETS.find((p) => p.id === "broadcast")!.targetLufs).toBe(-23);
  });

  it("交件用的走 wav（不收失真壓縮）", () => {
    expect(BUILTIN_PRESETS.find((p) => p.id === "broadcast")!.format).toBe("wav");
    expect(BUILTIN_PRESETS.find((p) => p.id === "editorial")!.format).toBe("wav");
  });

  it("只有交給剪接那個預設會分軌", () => {
    expect(BUILTIN_PRESETS.filter((p) => p.stems).map((p) => p.id)).toEqual(["editorial"]);
  });
});

describe("matchPreset", () => {
  it("設定跟內建一致時認得出來", () => {
    expect(matchPreset(shape(), [])!.id).toBe("podcast");
  });

  it("差一個值就是自訂", () => {
    expect(matchPreset(shape({ targetLufs: -18 }), [])).toBeNull();
  });

  it("認得使用者的預設", () => {
    const user: ExportPreset[] = [{ id: "mine", label: "我的", ...shape({ targetLufs: -18 }) }];
    expect(matchPreset(shape({ targetLufs: -18 }), user)!.id).toBe("mine");
  });

  it("跟內建撞值時顯示內建的（比較不會混淆）", () => {
    const user: ExportPreset[] = [{ id: "mine", label: "我的", ...shape() }];
    expect(matchPreset(shape(), user)!.id).toBe("podcast");
  });
});

describe("sameShape", () => {
  it("四個值全部一樣才算一樣", () => {
    expect(sameShape(shape(), shape())).toBe(true);
    for (const diff of [{ format: "wav" as const }, { targetLufs: -14 }, { leveling: false }, { stems: true }]) {
      expect(sameShape(shape(), shape(diff))).toBe(false);
    }
  });
});

describe("presetId", () => {
  it("從名稱做出乾淨的 id", () => {
    expect(presetId("My Podcast!", [])).toBe("my-podcast");
    expect(presetId("我的 預設", [])).toBe("我的-預設");
  });

  it("撞名時加序號而不是蓋掉", () => {
    const existing: ExportPreset[] = [{ id: "mine", label: "x", ...shape() }];
    expect(presetId("mine", existing)).toBe("mine-2");
  });

  it("全是符號時退回 preset", () => {
    expect(presetId("!!!", [])).toBe("preset");
  });
});

describe("saveUserPreset", () => {
  it("加一個新的", () => {
    const out = saveUserPreset([], "我的", shape({ targetLufs: -18 }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ label: "我的", targetLufs: -18 });
  });

  it("同名的覆蓋而不是變成兩個", () => {
    const a = saveUserPreset([], "我的", shape());
    const b = saveUserPreset(a, "我的", shape({ targetLufs: -20 }));
    expect(b).toHaveLength(1);
    expect(b[0].targetLufs).toBe(-20);
    expect(b[0].id).toBe(a[0].id); // id 不變，之前選過它的地方不會失效
  });

  it("不能佔用內建的名稱（清單裡會有兩個一樣的名字）", () => {
    const out = saveUserPreset([], BUILTIN_PRESETS[0].label, shape({ targetLufs: -20 }));
    expect(out).toEqual([]);
  });

  it("空名稱不做事", () => {
    expect(saveUserPreset([], "   ", shape())).toEqual([]);
  });
});

describe("removeUserPreset", () => {
  it("刪得掉", () => {
    const a = saveUserPreset([], "我的", shape());
    expect(removeUserPreset(a, a[0].id)).toEqual([]);
  });
  it("刪不存在的不會炸", () => {
    expect(removeUserPreset([], "nope")).toEqual([]);
  });
});

describe("allPresets", () => {
  it("內建排前面", () => {
    const user: ExportPreset[] = [{ id: "mine", label: "我的", ...shape() }];
    expect(allPresets(user).slice(0, BUILTIN_PRESETS.length).map((p) => p.id)).toEqual(BUILTIN_PRESETS.map((p) => p.id));
    const all = allPresets(user);
    expect(all[all.length - 1].id).toBe("mine");
  });
});

describe("parseUserPresets", () => {
  it("不是陣列就回空的", () => {
    expect(parseUserPresets(null)).toEqual([]);
    expect(parseUserPresets({ a: 1 })).toEqual([]);
  });

  it("擋掉壞資料（手改過的設定檔不該讓對話框掛掉）", () => {
    const raw = [
      { id: "ok", label: "好的", format: "mp3", targetLufs: -16 },
      { id: "no-format", label: "x", format: "wma", targetLufs: -16 },
      { id: "nan", label: "x", format: "mp3", targetLufs: Number.NaN },
      { label: "沒有 id", format: "mp3", targetLufs: -16 },
      null,
      "字串",
    ];
    const out = parseUserPresets(raw);
    expect(out.map((p) => p.id)).toEqual(["ok"]);
  });

  it("布林值有預設（leveling 預設開、stems 預設關）", () => {
    const [p] = parseUserPresets([{ id: "a", label: "a", format: "wav", targetLufs: -23 }]);
    expect([p.leveling, p.stems]).toEqual([true, false]);
  });
});
