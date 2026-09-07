import { describe, expect, it } from "vitest";
import { applyTemplate, buildTemplate, guessAnchor, parseTemplates, templateId, type ProjectTemplate } from "./template";
import type { Overlay } from "./overlays";

function ov(o: Partial<Overlay> & { outStartMs: number; srcOutMs: number }): Overlay {
  return {
    id: "x",
    lane: "music",
    mediaId: "m1",
    srcInMs: 0,
    fadeInMs: 2000,
    fadeOutMs: 2000,
    gainDb: -18,
    ...o,
  } as Overlay;
}

const DUR = 600_000; // 10 分鐘

describe("guessAnchor", () => {
  it("開頭的算 start", () => {
    expect(guessAnchor({ outStartMs: 0, srcInMs: 0, srcOutMs: 15_000 }, DUR)).toBe("start");
  });

  it("貼著結尾的算 end", () => {
    expect(guessAnchor({ outStartMs: DUR - 20_000, srcInMs: 0, srcOutMs: 20_000 }, DUR)).toBe("end");
  });

  it("在後半但沒貼著結尾的算 start（猜錯的代價不對稱）", () => {
    // 開場曲被當成片尾曲會整個跑掉；反過來只是位置差一點
    expect(guessAnchor({ outStartMs: DUR * 0.6, srcInMs: 0, srcOutMs: 10_000 }, DUR)).toBe("start");
  });

  it("時長 0 一律 start", () => {
    expect(guessAnchor({ outStartMs: 0, srcInMs: 0, srcOutMs: 100 }, 0)).toBe("start");
  });

  it("短節目也有最小容差（5% 可能只有幾百毫秒）", () => {
    // 30 秒的節目，片尾曲結束在 29 秒 → 差 1 秒，5% 只有 1.5 秒但下限是 2 秒
    expect(guessAnchor({ outStartMs: 24_000, srcInMs: 0, srcOutMs: 5000 }, 30_000)).toBe("end");
  });
});

describe("buildTemplate", () => {
  const base = {
    label: "我的節目",
    pathOf: (id: string) => (id === "m1" ? "D:/music/intro.mp3" : null),
    durationMs: DUR,
    targetLufs: -16,
    aggressiveness: 60,
    cleanup: null,
  };

  it("開場曲存成從頭的位移", () => {
    const t = buildTemplate({ ...base, overlays: [ov({ outStartMs: 0, srcOutMs: 15_000 })] });
    expect(t.overlays[0]).toMatchObject({ anchor: "start", offsetMs: 0, path: "D:/music/intro.mp3" });
  });

  it("片尾曲存成距離結尾的負位移（每一集長度不同）", () => {
    const t = buildTemplate({ ...base, overlays: [ov({ outStartMs: DUR - 20_000, srcOutMs: 20_000 })] });
    expect(t.overlays[0].anchor).toBe("end");
    expect(t.overlays[0].offsetMs).toBe(-20_000);
  });

  it("角色與音量設定都帶著", () => {
    const t = buildTemplate({ ...base, overlays: [ov({ outStartMs: 0, srcOutMs: 5000, role: "intro", gainDb: -12 })] });
    expect(t.overlays[0]).toMatchObject({ role: "intro", gainDb: -12, fadeInMs: 2000 });
  });

  it("找不到來源路徑的片段跳過（那個檔已經不在清單裡）", () => {
    const t = buildTemplate({ ...base, overlays: [ov({ outStartMs: 0, srcOutMs: 5000, mediaId: "gone" })] });
    expect(t.overlays).toEqual([]);
  });

  it("輸出目標與激進度也存起來", () => {
    const t = buildTemplate({ ...base, overlays: [] });
    expect(t).toMatchObject({ targetLufs: -16, aggressiveness: 60, label: "我的節目" });
  });

  it("**不存**剪輯決策 / 逐字稿（那是這一集的內容）", () => {
    const t = buildTemplate({ ...base, overlays: [] });
    expect(Object.keys(t).sort()).toEqual(["aggressiveness", "cleanup", "id", "label", "overlays", "targetLufs"]);
  });
});

describe("applyTemplate", () => {
  const tpl: ProjectTemplate = {
    id: "t",
    label: "我的節目",
    targetLufs: -16,
    aggressiveness: 50,
    overlays: [
      { path: "D:/a/intro.mp3", lane: "music", role: "intro", srcInMs: 0, srcOutMs: 15_000, anchor: "start", offsetMs: 0, gainDb: -18, fadeInMs: 2000, fadeOutMs: 2000 },
      { path: "D:/a/outro.mp3", lane: "music", role: "outro", srcInMs: 0, srcOutMs: 20_000, anchor: "end", offsetMs: -20_000, gainDb: -18, fadeInMs: 2000, fadeOutMs: 2000 },
    ],
  };
  const found = (p: string) => (p === "D:/a/intro.mp3" ? "m-intro" : p === "D:/a/outro.mp3" ? "m-outro" : null);

  it("開場放在 0，片尾貼齊這一集的結尾", () => {
    const r = applyTemplate(tpl, 300_000, found);
    expect(r.overlays[0].outStartMs).toBe(0);
    expect(r.overlays[1].outStartMs).toBe(280_000);
  });

  it("換一集長度不同，片尾跟著移動（這就是錨點的重點）", () => {
    expect(applyTemplate(tpl, 900_000, found).overlays[1].outStartMs).toBe(880_000);
  });

  it("節目比片尾曲還短時不會產生負的起點", () => {
    const r = applyTemplate(tpl, 10_000, found);
    expect(r.overlays[1].outStartMs).toBeGreaterThanOrEqual(0);
    expect(r.overlays[1].outStartMs).toBeLessThan(10_000);
  });

  it("找不到來源檔的回報數量而不是靜靜少一段", () => {
    const r = applyTemplate(tpl, 300_000, (p) => (p.includes("intro") ? "m-intro" : null));
    expect(r.overlays).toHaveLength(1);
    expect(r.missing).toBe(1);
  });

  it("角色與音量都套過去", () => {
    const r = applyTemplate(tpl, 300_000, found);
    expect(r.overlays[0]).toMatchObject({ role: "intro", gainDb: -18, lane: "music" });
  });

  it("**不帶閃避控制點**：那是針對上一集的人聲算的", () => {
    const withPoints: ProjectTemplate = { ...tpl, overlays: [{ ...tpl.overlays[0], points: [{ ms: 0, db: -8 }] }] };
    expect(applyTemplate(withPoints, 300_000, found).overlays[0].points).toEqual([]);
  });

  it("每一段拿到不同的 id", () => {
    const r = applyTemplate(tpl, 300_000, found);
    expect(new Set(r.overlays.map((o) => o.id)).size).toBe(r.overlays.length);
  });
});

describe("templateId", () => {
  it("從名稱做出乾淨的 id", () => {
    expect(templateId("My Show!")).toBe("my-show");
    expect(templateId("我的 節目")).toBe("我的-節目");
  });
  it("全是符號時退回 template", () => {
    expect(templateId("###")).toBe("template");
  });
});

describe("parseTemplates", () => {
  it("不是陣列回空的", () => {
    expect(parseTemplates(null)).toEqual([]);
  });

  it("擋掉壞資料", () => {
    const out = parseTemplates([
      { id: "ok", label: "好", overlays: [] },
      { id: "no-overlays", label: "x" },
      { label: "沒有 id", overlays: [] },
      "字串",
    ]);
    expect(out.map((t) => t.id)).toEqual(["ok"]);
  });

  it("錨點不合法的片段被濾掉", () => {
    const out = parseTemplates([{ id: "a", label: "a", overlays: [{ path: "x", anchor: "middle" }, { path: "y", anchor: "end" }] }]);
    expect(out[0].overlays).toHaveLength(1);
  });

  it("數值缺漏時有預設", () => {
    const [t] = parseTemplates([{ id: "a", label: "a", overlays: [] }]);
    expect([t.targetLufs, t.aggressiveness]).toEqual([-16, 50]);
  });
});
