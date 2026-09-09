import { describe, expect, it } from "vitest";
import { bundleStem, includedItems, planBundle, reconcileBundleItems, renderChapterList, renderManifest, type BundleItem, type BundleItemKind } from "./bundle";
import type { PreflightFinding } from "./preflight";
import { checkCompliance, explainMiss } from "./loudness/compliance";

const BASE = {
  mediaName: "ep12.wav",
  audioFormat: "mp3",
  captionFormat: "srt" as const,
  hasTranscript: true,
  hasShowNotes: true,
  chapterCount: 3,
};

describe("bundleStem", () => {
  it("預設用原始檔名去掉副檔名", () => {
    expect(bundleStem(BASE)).toBe("ep12");
  });

  it("使用者指定的優先", () => {
    expect(bundleStem({ ...BASE, stem: "第 12 集" })).toBe("第 12 集");
  });

  it("洗掉不能當檔名的字元（標題是使用者打的）", () => {
    expect(bundleStem({ ...BASE, stem: "第12集: AI/podcast" })).toBe("第12集 AI podcast");
  });

  it("整串都不能用時退回 episode", () => {
    expect(bundleStem({ ...BASE, mediaName: "", stem: "///" })).toBe("episode");
  });
});

describe("planBundle", () => {
  it("齊全時六個檔案，名字前綴一致", () => {
    const items = planBundle(BASE);
    expect(items.map((i) => i.fileName)).toEqual([
      "ep12.mp3",
      "ep12.srt",
      "ep12-transcript.md",
      "ep12-shownotes.md",
      "ep12-chapters.txt",
      "ep12-README.md",
    ]);
    expect(includedItems(items)).toHaveLength(6);
  });

  it("**沒帶到的也要列出來並附原因**（少一個檔案又什麼都沒說最難發現）", () => {
    const items = planBundle({ ...BASE, hasTranscript: false });
    const cap = items.find((i) => i.kind === "captions")!;
    expect(cap.skipped).toContain("逐字稿");
    expect(includedItems(items).map((i) => i.kind)).toEqual(["audio", "notes", "chapters", "manifest"]);
  });

  it("沒有節目筆記 / 沒有章節各自標出來", () => {
    const items = planBundle({ ...BASE, hasShowNotes: false, chapterCount: 0 });
    expect(items.find((i) => i.kind === "notes")!.skipped).toBeTruthy();
    expect(items.find((i) => i.kind === "chapters")!.skipped).toBeTruthy();
  });

  it("音檔與清單一定在（那兩個不依賴任何東西）", () => {
    const items = planBundle({ ...BASE, hasTranscript: false, hasShowNotes: false, chapterCount: 0 });
    expect(items.find((i) => i.kind === "audio")!.skipped).toBeUndefined();
    expect(items.find((i) => i.kind === "manifest")!.skipped).toBeUndefined();
  });

  it("字幕格式換了副檔名跟著換", () => {
    expect(planBundle({ ...BASE, captionFormat: "vtt" }).find((i) => i.kind === "captions")!.fileName).toBe("ep12.vtt");
  });
});

describe("renderManifest", () => {
  const findings: PreflightFinding[] = [
    { id: "a", severity: "warning", title: "還有 12 筆待決", action: "review" } as PreflightFinding,
  ];
  const M = {
    stem: "ep12",
    mediaName: "ep12.wav",
    items: planBundle(BASE),
    outMs: 1_845_000,
    srcMs: 2_100_000,
    targetLufs: -16,
    measuredLufs: -16.2,
    chapters: [
      { outMs: 0, title: "開場" },
      { outMs: 620_000, title: "主題" },
    ],
    speakers: [
      { label: "主持人", share: 0.62 },
      { label: "來賓", share: 0.38 },
    ],
    findings,
    generatedAt: new Date("2026-09-07T03:00:00Z"),
  };

  it("長度寫成品也寫剪掉多少", () => {
    const md = renderManifest(M);
    expect(md).toContain("30:45");
    expect(md).toContain("35:00");
    expect(md).toContain("4:15");
  });

  it("量到的響度寫進去", () => {
    expect(renderManifest(M)).toContain("-16 LUFS，輸出後量到 -16.2 LUFS");
  });

  it("沒量到響度時不要硬寫一個數字", () => {
    expect(renderManifest({ ...M, measuredLufs: null })).not.toContain("輸出後量到");
  });

  it("沒帶到的檔案用刪除線標出來並寫原因", () => {
    const md = renderManifest({ ...M, items: planBundle({ ...BASE, hasShowNotes: false }) });
    expect(md).toMatch(/~~`ep12-shownotes\.md`~~ —— 沒有：/);
  });

  it("交付前檢查列進去", () => {
    expect(renderManifest(M)).toContain("還有 12 筆待決");
  });

  it("沒有問題時明講「沒有發現問題」（空白會讓人以為沒檢查）", () => {
    expect(renderManifest({ ...M, findings: [] })).toContain("沒有發現問題");
  });

  it("沒有講者 / 章節時不留空段落", () => {
    const md = renderManifest({ ...M, speakers: [], chapters: [] });
    expect(md).not.toContain("## 講者");
    expect(md).not.toContain("## 章節");
  });
});

describe("renderChapterList", () => {
  it("每行一個「時間 標題」", () => {
    expect(renderChapterList([{ outMs: 0, title: "開場" }, { outMs: 65_000, title: "主題" }])).toBe("0:00 開場\n1:05 主題\n");
  });

  it("第一個不在 0:00 時補一行 —— YouTube 的規矩，不補整份章節都不生效", () => {
    expect(renderChapterList([{ outMs: 30_000, title: "主題" }])).toBe("0:00 開頭\n0:30 主題\n");
  });

  it("超過一小時寫成 h:mm:ss", () => {
    expect(renderChapterList([{ outMs: 3_675_000, title: "後段" }])).toContain("1:01:15 後段");
  });

  it("沒有章節時回空字串而不是一行 0:00", () => {
    expect(renderChapterList([])).toBe("\n");
  });
});

describe("renderManifest：響度驗收", () => {
  const base = {
    stem: "ep12",
    mediaName: "ep12.wav",
    items: planBundle(BASE),
    outMs: 1_845_000,
    srcMs: 2_100_000,
    targetLufs: -16,
    chapters: [],
    speakers: [],
    findings: [] as PreflightFinding[],
    generatedAt: new Date("2026-09-07T03:00:00Z"),
  };

  it("達標時寫「都達標」", () => {
    const md = renderManifest({
      ...base,
      measuredLufs: -16.1,
      compliance: checkCompliance({ outputLufs: -16.1, outputTp: -1.6, targetLufs: -16 }),
      miss: explainMiss({ outputLufs: -16.1, outputTp: -1.6, targetLufs: -16 }),
    });
    expect(md).toContain("## 響度驗收");
    expect(md).toContain("都達標");
  });

  it("**沒打到目標時把原因寫進去**（只留一個數字，三個月後看不出那是不是問題）", () => {
    const md = renderManifest({
      ...base,
      measuredLufs: -17.3,
      compliance: checkCompliance({ outputLufs: -17.3, outputTp: -1.5, targetLufs: -16 }),
      miss: explainMiss({ outputLufs: -17.3, outputTp: -1.5, targetLufs: -16 }),
    });
    expect(md).toContain("被真實峰值上限擋住了");
    expect(md).toContain("-17.3 LUFS");
  });

  it("沒量到響度時整段不出現（不要留一個空標題）", () => {
    expect(renderManifest({ ...base, measuredLufs: null, compliance: null, miss: null })).not.toContain("## 響度驗收");
  });
});

describe("reconcileBundleItems", () => {
  const item = (kind: BundleItemKind, fileName: string, skipped?: string): BundleItem => ({ kind, fileName, skipped });

  it("每一項都有著落時回空陣列", () => {
    const items = [item("audio", "a.mp3"), item("captions", "a.srt")];
    expect(reconcileBundleItems(items, [items[0]], [{ fileName: "a.srt" }], "沒有產生")).toEqual([]);
  });

  it("被跳過的不算漏（清單上本來就會寫原因）", () => {
    const items = [item("audio", "a.mp3"), item("notes", "a.md", "還沒產生節目筆記")];
    expect(reconcileBundleItems(items, [items[0]], [], "沒有產生")).toEqual([]);
  });

  it("既沒跳過也沒被嘗試的要補記成失敗 —— 不然清單會列一個不存在的檔案", () => {
    const items = [item("audio", "a.mp3"), item("captions", "a.srt"), item("transcript", "a.md")];
    expect(reconcileBundleItems(items, [items[0]], [], "沒有產生（缺少必要資料）")).toEqual([
      { fileName: "a.srt", error: "沒有產生（缺少必要資料）" },
      { fileName: "a.md", error: "沒有產生（缺少必要資料）" },
    ]);
  });

  it("已經記成失敗的不會被記第二次", () => {
    const items = [item("audio", "a.mp3")];
    expect(reconcileBundleItems(items, [], [{ fileName: "a.mp3" }], "沒有產生")).toEqual([]);
  });
});

describe("reconcileBundleItems：清單自己", () => {
  it("清單最後才寫，對帳時還沒寫出來 —— 不能把它記成失敗", () => {
    const items: BundleItem[] = [
      { kind: "audio", fileName: "a.mp3" },
      { kind: "manifest", fileName: "a-README.md" },
    ];
    // 對帳發生在清單寫出來之前，所以 written 裡只有音檔
    expect(reconcileBundleItems(items, [items[0]], [], "沒有產生")).toEqual([]);
  });
});
