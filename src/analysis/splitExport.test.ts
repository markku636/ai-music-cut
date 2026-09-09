import { describe, expect, it } from "vitest";
import { fileNameFor, safeFileName, splitByChapters, totalOutMs } from "./splitExport";
import type { Edl, KeepSegment } from "./edl/build";
import type { Marker } from "./types";

function chapter(id: string, ms: number, title: string): Marker {
  return { id, ms, kind: "chapter", title };
}

function edlOf(keeps: KeepSegment[]): Edl {
  return { keeps, joins: [], stats: { srcMs: 0, outMs: 0, cutMs: 0, ratio: 0 } } as unknown as Edl;
}

/** 完整保留：來源時間 = 成品時間。 */
const FULL = edlOf([{ id: 0, srcStartMs: 0, srcEndMs: 600_000, outStartMs: 0, outEndMs: 600_000, gainDb: 0 }]);

const OPTS = { baseName: "ep12", ext: "mp3", durationMs: 600_000, leadTitle: "開場" };

describe("safeFileName", () => {
  it("拿掉路徑分隔符 —— 不然會寫到別的目錄去", () => {
    expect(safeFileName("a/b")).toBe("a b");
    expect(safeFileName("a\\b")).toBe("a b");
  });

  it("拿掉 Windows 不接受的字元", () => {
    expect(safeFileName('第一段: 這樣? "好"嗎|真的*')).toBe("第一段 這樣 好 嗎 真的");
  });

  it("連字號是內容，不要動", () => {
    expect(safeFileName("AI-Native 開發")).toBe("AI-Native 開發");
  });

  it("結尾的點與空白拿掉（Windows 會悄悄吃掉，兩個檔案就撞名）", () => {
    expect(safeFileName("結尾有點...")).toBe("結尾有點");
    expect(safeFileName("結尾有空白   ")).toBe("結尾有空白");
  });

  it("Windows 保留裝置名不能當檔名", () => {
    expect(safeFileName("CON")).toBe("");
    expect(safeFileName("com1")).toBe("");
    expect(safeFileName("console")).toBe("console");
  });

  it("整串都是壞字元時回空字串（呼叫端要有退路）", () => {
    expect(safeFileName("///")).toBe("");
    expect(safeFileName("   ")).toBe("");
  });

  it("太長的截斷", () => {
    expect(safeFileName("字".repeat(200)).length).toBeLessThanOrEqual(60);
  });
});

describe("fileNameFor", () => {
  it("原檔名-編號-標題.副檔名", () => {
    expect(fileNameFor("ep12", 1, "開場", "mp3")).toBe("ep12-01-開場.mp3");
  });

  it("編號補零到兩位（不然檔案總管會把 10 排在 2 前面）", () => {
    expect(fileNameFor("ep12", 9, "a", "wav")).toBe("ep12-09-a.wav");
    expect(fileNameFor("ep12", 10, "a", "wav")).toBe("ep12-10-a.wav");
  });

  it("標題不能用時退回只有編號", () => {
    expect(fileNameFor("ep12", 3, "///", "mp3")).toBe("ep12-03.mp3");
  });

  it("原檔名也不能用時退回 output", () => {
    expect(fileNameFor("???", 1, "", "mp3")).toBe("output-01.mp3");
  });

  it("撞名的加流水號（大小寫不分 —— Windows 檔案系統就是這樣）", () => {
    const used = new Set<string>();
    expect(fileNameFor("ep", 1, "Intro", "mp3", used)).toBe("ep-01-Intro.mp3");
    expect(fileNameFor("ep", 1, "intro", "mp3", used)).toBe("ep-01-intro-2.mp3");
  });
});

describe("splitByChapters", () => {
  it("章節之間各成一段，最後一段到結尾", () => {
    const parts = splitByChapters(
      [chapter("a", 0, "開頭"), chapter("b", 200_000, "第二段"), chapter("c", 400_000, "第三段")],
      FULL,
      OPTS,
    );
    expect(parts.map((p) => [p.startMs, p.endMs])).toEqual([
      [0, 200_000],
      [200_000, 400_000],
      [400_000, 600_000],
    ]);
  });

  it("第一個章節不在 0 時**補一段開頭**（不然那段話會安靜地不見）", () => {
    const parts = splitByChapters([chapter("b", 120_000, "正片")], FULL, OPTS);
    expect(parts[0]).toMatchObject({ title: "開場", startMs: 0, endMs: 120_000 });
    expect(parts[1]).toMatchObject({ title: "正片", startMs: 120_000, endMs: 600_000 });
  });

  it("長度是**成品**長度，不是來源長度（中間剪掉的不算）", () => {
    // 來源 0–600k，但只保留 0–100k 與 500k–600k
    const edl = edlOf([
      { id: 0, srcStartMs: 0, srcEndMs: 100_000, outStartMs: 0, outEndMs: 100_000, gainDb: 0 },
      { id: 1, srcStartMs: 500_000, srcEndMs: 600_000, outStartMs: 100_000, outEndMs: 200_000, gainDb: 0 },
    ]);
    const parts = splitByChapters([chapter("a", 0, "一"), chapter("b", 300_000, "二")], edl, OPTS);
    expect(parts[0].outMs).toBe(100_000);
    expect(parts[1].outMs).toBe(100_000);
    expect(totalOutMs(parts)).toBe(200_000);
  });

  it("整段都被剪掉的段落丟掉，而且編號要重新連續", () => {
    const edl = edlOf([{ id: 0, srcStartMs: 0, srcEndMs: 100_000, outStartMs: 0, outEndMs: 100_000, gainDb: 0 }]);
    const parts = splitByChapters(
      [chapter("a", 0, "留著"), chapter("b", 200_000, "整段被剪"), chapter("c", 400_000, "也被剪")],
      edl,
      OPTS,
    );
    expect(parts).toHaveLength(1);
    expect(parts[0].index).toBe(1);
    expect(parts[0].fileName).toBe("ep12-01-留著.mp3");
  });

  it("沒有排序的標記也處理得了", () => {
    const parts = splitByChapters([chapter("b", 400_000, "後"), chapter("a", 0, "前")], FULL, OPTS);
    expect(parts.map((p) => p.title)).toEqual(["前", "後"]);
  });

  it("同一個時間點兩個章節只留一個（後面那個沒有長度）", () => {
    const parts = splitByChapters([chapter("a", 0, "一"), chapter("b", 0, "二")], FULL, OPTS);
    expect(parts).toHaveLength(1);
    expect(parts[0].title).toBe("一");
  });

  it("沒有章節標記時回空的（不要無聲無息輸出一整包）", () => {
    expect(splitByChapters([{ id: "m", ms: 1000, kind: "standard", title: "普通標記" }], FULL, OPTS)).toEqual([]);
    expect(splitByChapters([], FULL, OPTS)).toEqual([]);
  });

  it("標記超出長度會被夾住", () => {
    const parts = splitByChapters([chapter("a", 0, "一"), chapter("b", 999_999_999, "二")], FULL, OPTS);
    expect(parts).toHaveLength(1);
    expect(parts[0].endMs).toBe(600_000);
  });

  it("時長 0 時回空的", () => {
    expect(splitByChapters([chapter("a", 0, "一")], FULL, { ...OPTS, durationMs: 0 })).toEqual([]);
  });

  it("沒有 EDL 時用來源長度（還沒分析也要看得到會切成幾段）", () => {
    const parts = splitByChapters([chapter("a", 0, "一"), chapter("b", 300_000, "二")], null, OPTS);
    expect(parts.map((p) => p.outMs)).toEqual([300_000, 300_000]);
  });

  it("兩個同名章節的檔名不會撞在一起", () => {
    const parts = splitByChapters(
      [chapter("a", 0, "廣告"), chapter("b", 200_000, "內容"), chapter("c", 400_000, "廣告")],
      FULL,
      OPTS,
    );
    expect(new Set(parts.map((p) => p.fileName)).size).toBe(3);
  });
});

describe("splitByChapters：亂序的 EDL（剪下貼上 / 搬移）", () => {
  it("段落長度不會算成負的，也就不會被當成太短丟掉", () => {
    // 成品順序＝來源 10–20 秒在前、0–10 秒在後
    const edl = edlOf([
      { id: 0, srcStartMs: 10_000, srcEndMs: 20_000, outStartMs: 0, outEndMs: 10_000, gainDb: 0 },
      { id: 1, srcStartMs: 0, srcEndMs: 10_000, outStartMs: 10_000, outEndMs: 20_000, gainDb: 0 },
    ]);
    const parts = splitByChapters([chapter("a", 0, "上半"), chapter("b", 10_000, "下半")], edl, { ...OPTS, durationMs: 20_000 });
    expect(parts.map((p) => p.title)).toEqual(["上半", "下半"]);
    for (const p of parts) expect(p.outMs).toBeGreaterThan(0);
    expect(parts.map((p) => p.outMs)).toEqual([10_000, 10_000]);
  });

  it("貼上：同一段來源被算兩次 —— 成品裡真的有兩份", () => {
    const edl = edlOf([
      { id: 0, srcStartMs: 0, srcEndMs: 10_000, outStartMs: 0, outEndMs: 10_000, gainDb: 0 },
      { id: 1, srcStartMs: 2000, srcEndMs: 6000, outStartMs: 10_000, outEndMs: 14_000, gainDb: 0 },
    ]);
    const parts = splitByChapters([chapter("a", 0, "全部")], edl, { ...OPTS, durationMs: 10_000 });
    expect(parts[0].outMs).toBe(14_000);
  });
});
