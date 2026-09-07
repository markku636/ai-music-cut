import { describe, expect, it } from "vitest";
import { buildChapters, MIN_CHAPTER_MS, sanitizeTitle, toFfmetadata } from "./chapters";
import type { Edl } from "./edl/build";
import type { Marker } from "./types";

function mk(ms: number, title: string, kind: Marker["kind"] = "chapter"): Marker {
  return { id: `mk:${ms}`, ms, kind, title };
}

/** 剪掉 [2000, 5000) 的假 EDL：來源 0–2000 → 成品 0–2000，來源 5000–10000 → 成品 2000–7000。 */
const edl: Edl = {
  keeps: [
    { id: 0, srcStartMs: 0, srcEndMs: 2000, outStartMs: 0, outEndMs: 2000, gainDb: 0 },
    { id: 1, srcStartMs: 5000, srcEndMs: 10000, outStartMs: 2000, outEndMs: 7000, gainDb: 0 },
  ],
  joins: [],
  stats: { removedMs: 3000, keptMs: 7000, outMs: 7000, cutCount: 1, byKind: {} },
  downgrades: [],
  removals: [{ startMs: 2000, endMs: 5000, candidateIds: ["c"], speech: true, userRange: false }],
  rearranged: false
};

describe("buildChapters", () => {
  it("時間換算到成品時間軸（剪掉多少就往前移多少）", () => {
    const cs = buildChapters([mk(0, "開場"), mk(6000, "主題二")], edl, { outDurationMs: 7000 });
    expect(cs).toEqual([
      { startMs: 0, endMs: 3000, title: "開場" },
      { startMs: 3000, endMs: 7000, title: "主題二" },
    ]);
  });

  it("落在剪掉的區間 → 挪到下一段保留段的開頭", () => {
    const cs = buildChapters([mk(0, "開場"), mk(3500, "被剪掉那裡")], edl, { outDurationMs: 7000 });
    expect(cs[1].startMs).toBe(2000);
  });

  it("第一章一定從 0 開始（播放器假設章節覆蓋整個檔案）", () => {
    const cs = buildChapters([mk(6000, "主題二")], edl, { outDurationMs: 7000 });
    expect(cs[0].startMs).toBe(0);
    expect(cs).toHaveLength(2);
  });

  it("末章補到成品結尾", () => {
    const cs = buildChapters([mk(0, "a"), mk(6000, "b")], edl, { outDurationMs: 7000 });
    expect(cs[cs.length - 1].endMs).toBe(7000);
  });

  it("章節連續、不重疊、START < END", () => {
    const cs = buildChapters([mk(0, "a"), mk(5500, "b"), mk(8000, "c")], edl, { outDurationMs: 7000 });
    for (let i = 0; i < cs.length; i++) {
      expect(cs[i].endMs).toBeGreaterThan(cs[i].startMs);
      if (i + 1 < cs.length) expect(cs[i].endMs).toBe(cs[i + 1].startMs);
    }
  });

  it("靠太近的章節併成一個", () => {
    const cs = buildChapters([mk(0, "a"), mk(0 + MIN_CHAPTER_MS / 2, "b")], null, { outDurationMs: 10000 });
    expect(cs).toHaveLength(1);
    expect(cs[0].title).toBe("a");
  });

  it("只吃 chapter 類型的標記", () => {
    const cs = buildChapters([mk(0, "章"), mk(3000, "只是標記", "standard"), mk(4000, "待辦", "todo")], null, { outDurationMs: 10000 });
    expect(cs).toHaveLength(1);
  });

  it("沒有章節標記就回空（不要無中生有一個章節）", () => {
    expect(buildChapters([mk(0, "x", "standard")], null, { outDurationMs: 10000 })).toEqual([]);
    expect(buildChapters([], null, { outDurationMs: 10000 })).toEqual([]);
  });

  it("沒有標題的章節補序號", () => {
    const cs = buildChapters([mk(3000, "後面那段")], null, { outDurationMs: 10000, fallbackTitle: "章節" });
    expect(cs[0].title).toBe("章節 1");
    expect(cs[1].title).toBe("後面那段");
  });

  it("超出成品長度的標記丟掉", () => {
    const cs = buildChapters([mk(0, "a"), mk(99999, "太後面")], null, { outDurationMs: 10000 });
    expect(cs).toHaveLength(1);
  });
});

describe("sanitizeTitle", () => {
  it("換行會切斷 ffmetadata 的 key=value，一律拿掉", () => {
    expect(sanitizeTitle("第一段\n第二段")).toBe("第一段 第二段");
  });
  it("太長就截斷", () => {
    expect(sanitizeTitle("字".repeat(100)).length).toBeLessThanOrEqual(60);
  });
});

describe("toFfmetadata", () => {
  it("產生 ffmpeg 讀得懂的格式", () => {
    const txt = toFfmetadata([{ startMs: 0, endMs: 3000, title: "開場" }]);
    expect(txt.startsWith(";FFMETADATA1")).toBe(true);
    expect(txt).toContain("[CHAPTER]");
    expect(txt).toContain("TIMEBASE=1/1000");
    expect(txt).toContain("START=0");
    expect(txt).toContain("END=3000");
    expect(txt).toContain("title=開場");
  });

  it("跳脫 ffmetadata 的特殊字元", () => {
    const txt = toFfmetadata([{ startMs: 0, endMs: 1000, title: "a=b;c#d" }]);
    expect(txt).toContain("title=a\\=b\\;c\\#d");
  });
});
