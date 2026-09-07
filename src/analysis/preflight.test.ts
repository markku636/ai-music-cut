import { describe, expect, it } from "vitest";
import { CUT_RATIO_NOTE, hasBlocker, preflight, summarize, type PreflightContext } from "./preflight";

const ctx = (o: Partial<PreflightContext> = {}): PreflightContext => ({
  pending: 0,
  conflicts: 0,
  openTodos: 0,
  chapters: 1,
  srcMs: 3_420_000,
  outMs: 3_000_000,
  overlays: 0,
  musicWithoutDuck: 0,
  stems: false,
  hasTranscript: true,
  ...o,
});

const ids = (c: Partial<PreflightContext>) => preflight(ctx(c)).map((f) => f.id);

describe("乾淨的專案不該有雜訊", () => {
  it("什麼都沒問題時回空陣列", () => {
    expect(preflight(ctx())).toEqual([]);
  });

  it("剛好在剪除比例門檻上不提", () => {
    const src = 1_000_000;
    expect(ids({ srcMs: src, outMs: src * (1 - CUT_RATIO_NOTE) })).toEqual([]);
  });
});

describe("會產出壞檔案的才擋", () => {
  it("成品長度 0 是 blocker", () => {
    const f = preflight(ctx({ outMs: 0 }));
    expect(f[0]).toMatchObject({ id: "empty", severity: "blocker" });
    expect(hasBlocker(f)).toBe(true);
  });

  it("其他情況一律不擋（剪輯的人常常就是要輸出半成品去聽）", () => {
    expect(hasBlocker(preflight(ctx({ pending: 50, conflicts: 10, openTodos: 5, chapters: 0 })))).toBe(false);
  });
});

describe("警告", () => {
  it("有分歧時講清楚輸出會照哪邊走", () => {
    const f = preflight(ctx({ conflicts: 3 }))[0];
    expect(f).toMatchObject({ id: "conflicts", severity: "warning", action: "conflicts" });
    expect(f.title).toContain("3");
    expect(f.detail).toContain("剪輯");
  });

  it("待決的說明「不決定就是不剪」", () => {
    const f = preflight(ctx({ pending: 12 })).find((x) => x.id === "pending")!;
    expect(f.title).toContain("12");
    expect(f.detail).toContain("不剪");
  });

  it("未完成的待辦", () => {
    expect(ids({ openTodos: 2 })).toContain("todos");
  });

  it("分歧排在待決前面（那個更需要人裁決）", () => {
    expect(ids({ conflicts: 1, pending: 1 })).toEqual(["conflicts", "pending"]);
  });
});

describe("提醒", () => {
  it("勾了分軌但沒有配樂", () => {
    expect(ids({ stems: true, overlays: 0 })).toContain("stems-empty");
  });

  it("有配樂時勾分軌不提", () => {
    expect(ids({ stems: true, overlays: 2 })).not.toContain("stems-empty");
  });

  it("配樂沒閃避", () => {
    const f = preflight(ctx({ overlays: 2, musicWithoutDuck: 2 })).find((x) => x.id === "duck")!;
    expect(f.severity).toBe("note");
    expect(f.action).toBe("duck");
  });

  it("沒有章節（有逐字稿才提）", () => {
    expect(ids({ chapters: 0 })).toContain("chapters");
    expect(ids({ chapters: 0, hasTranscript: false })).not.toContain("chapters");
  });

  it("剪掉的比例只講事實不下判斷", () => {
    const f = preflight(ctx({ srcMs: 1000, outMs: 500 })).find((x) => x.id === "cut-ratio")!;
    expect(f.title).toBe("剪掉了 50%");
    expect(f.detail).toContain("只是告訴你數字");
  });
});

describe("排序", () => {
  it("擋下的、警告、提醒依序排", () => {
    const f = preflight(ctx({ outMs: 0, pending: 1, chapters: 0, srcMs: 1000 }));
    const sev = f.map((x) => x.severity);
    expect(sev).toEqual([...sev].sort((a, b) => ["blocker", "warning", "note"].indexOf(a) - ["blocker", "warning", "note"].indexOf(b)));
  });
});

describe("每一條都要能指向下一步", () => {
  it("所有結果都有 action", () => {
    const f = preflight(ctx({ outMs: 0, pending: 1, conflicts: 1, openTodos: 1, chapters: 0, stems: true, musicWithoutDuck: 1, srcMs: 1000 }));
    expect(f.length).toBeGreaterThan(5);
    expect(f.every((x) => !!x.action)).toBe(true);
  });

  it("每一條都有標題", () => {
    const f = preflight(ctx({ pending: 1, conflicts: 1, openTodos: 1, chapters: 0 }));
    expect(f.every((x) => x.title.length > 0)).toBe(true);
  });
});

describe("summarize", () => {
  it("分級計數", () => {
    const f = preflight(ctx({ outMs: 0, pending: 1, chapters: 0, srcMs: 1000 }));
    const s = summarize(f);
    expect(s.blockers).toBe(1);
    expect(s.warnings).toBe(1);
    expect(s.notes).toBeGreaterThanOrEqual(1);
  });

  it("空的就全是 0", () => {
    expect(summarize([])).toEqual({ blockers: 0, warnings: 0, notes: 0 });
  });
});

describe("邊界", () => {
  it("srcMs 是 0 時不會除以零", () => {
    expect(() => preflight(ctx({ srcMs: 0, outMs: 0 }))).not.toThrow();
    expect(ids({ srcMs: 0, outMs: 0 })).not.toContain("cut-ratio");
  });

  it("成品比來源長（片尾曲拉長）不會回負的比例", () => {
    expect(ids({ srcMs: 1000, outMs: 1500 })).not.toContain("cut-ratio");
  });
});

const CLEAN_QC = { clipping: 0, clippingMs: 0, levelJumps: 0, maxJumpLu: 0, dcPercent: 0, deadAir: 0, longestDeadAirMs: 0 };

describe("聲音體檢（逐字稿看不出來的）", () => {
  it("沒有本機分析 → 一條都不報（「沒檢查」不等於「很乾淨」）", () => {
    expect(ids({ qc: undefined })).toEqual([]);
  });

  it("掃過而且很乾淨 → 也是一條都不報", () => {
    expect(ids({ qc: CLEAN_QC })).toEqual([]);
  });

  it("削波是警告，不是提醒", () => {
    const f = preflight(ctx({ qc: { ...CLEAN_QC, clipping: 3, clippingMs: 240 } }));
    const clip = f.find((x) => x.id === "qc-clipping")!;
    expect(clip.severity).toBe("warning");
    expect(clip.title).toContain("3");
    expect(clip.title).toContain("240");
  });

  it("音量突變會帶上最大幅度", () => {
    const f = preflight(ctx({ qc: { ...CLEAN_QC, levelJumps: 2, maxJumpLu: 11.53 } }));
    const jump = f.find((x) => x.id === "qc-jump")!;
    expect(jump.severity).toBe("warning");
    expect(jump.title).toContain("11.5");
  });

  it("直流偏移只是提醒（聽不出來，但值得知道）", () => {
    const f = preflight(ctx({ qc: { ...CLEAN_QC, dcPercent: -4.2 } }));
    const dc = f.find((x) => x.id === "qc-dc")!;
    expect(dc.severity).toBe("note");
    // 負偏移也要顯示成正的百分比（方向對使用者沒有意義）
    expect(dc.title).toContain("4.2");
  });

  it("長空白是提醒，帶上最長那一段的秒數", () => {
    const f = preflight(ctx({ qc: { ...CLEAN_QC, deadAir: 2, longestDeadAirMs: 6400 } }));
    const dead = f.find((x) => x.id === "qc-dead-air")!;
    expect(dead.severity).toBe("note");
    expect(dead.title).toContain("6.4");
  });

  it("聲音的問題要能點過去聽", () => {
    const f = preflight(ctx({
      qc: { ...CLEAN_QC, clipping: 1, clippingMs: 40, levelJumps: 1, maxJumpLu: 9, deadAir: 1, longestDeadAirMs: 5000 },
      qcAt: { clipping: 12_000, levelJump: 34_000, deadAir: 56_000 },
    }));
    expect(f.find((x) => x.id === "qc-clipping")!.atMs).toBe(12_000);
    expect(f.find((x) => x.id === "qc-jump")!.atMs).toBe(34_000);
    expect(f.find((x) => x.id === "qc-dead-air")!.atMs).toBe(56_000);
    for (const id of ["qc-clipping", "qc-jump", "qc-dead-air"]) {
      expect(f.find((x) => x.id === id)!.action).toBe("listen");
    }
  });

  it("聲音的毛病不會擋住輸出（剪的人常常就是要先輸出來聽）", () => {
    const f = preflight(ctx({ qc: { ...CLEAN_QC, clipping: 99, clippingMs: 99_000 } }));
    expect(hasBlocker(f)).toBe(false);
  });

  it("警告排在提醒前面", () => {
    const f = preflight(ctx({
      qc: { ...CLEAN_QC, clipping: 1, clippingMs: 40, dcPercent: 5, deadAir: 1, longestDeadAirMs: 5000 },
    }));
    const sev = f.map((x) => x.severity);
    expect(sev.indexOf("warning")).toBeLessThan(sev.indexOf("note"));
  });
});
