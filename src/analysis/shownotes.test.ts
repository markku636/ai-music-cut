import { describe, expect, it } from "vitest";
import { markersToChapters, normalizeShowNotes, notesPrompt, notesSource, parseStamp, stamp, toMarkdown } from "./shownotes";
import type { Edl } from "./edl/build";
import type { Marker, Transcript } from "./types";

/**
 * 用真實的 KeepSegment 欄位名（srcStartMs / outStartMs …）。
 * 自己捏一組 `startMs / endMs` 的話，模組寫錯欄位名時測試會跟著錯得一模一樣 —— 一路綠燈到上線。
 */
function edlOf(spans: { startMs: number; endMs: number }[]): Edl {
  let out = 0;
  const keeps = spans.map((k, i) => {
    const len = k.endMs - k.startMs;
    const seg = { id: i, srcStartMs: k.startMs, srcEndMs: k.endMs, outStartMs: out, outEndMs: out + len, gainDb: 0 };
    out += len;
    return seg;
  });
  return { keeps, joins: [], removals: [], stats: { outMs: out, srcMs: 0, cutCount: 0, removedMs: 0 } } as unknown as Edl;
}

function trOf(sentences: { startMs: number; text: string }[]): Transcript {
  const words = sentences.map((s, i) => ({ id: i, segId: 0, text: s.text, norm: s.text, startMs: s.startMs, endMs: s.startMs + 500, prob: 0.9 }));
  return {
    words,
    segments: [],
    sentences: sentences.map((s, i) => ({ id: i, wordIds: [i], startMs: s.startMs, endMs: s.startMs + 500, endsWithQuestion: false })),
    vad: [],
    durationMs: 60_000,
    language: "zh",
    model: "test",
  };
}

describe("stamp / parseStamp", () => {
  it("一小時以內不印小時位", () => {
    expect(stamp(0)).toBe("0:00");
    expect(stamp(65_000)).toBe("1:05");
    expect(stamp(600_000)).toBe("10:00");
  });

  it("超過一小時才印小時位，分鐘補零", () => {
    expect(stamp(3_725_000)).toBe("1:02:05");
  });

  it("parseStamp 吃得下三種寫法", () => {
    expect(parseStamp("90")).toBe(90_000);
    expect(parseStamp("1:05")).toBe(65_000);
    expect(parseStamp("1:02:05")).toBe(3_725_000);
    expect(parseStamp(" 12:30 ")).toBe(750_000);
  });

  it("看不懂就回 null，不要猜", () => {
    expect(parseStamp("")).toBeNull();
    expect(parseStamp("大概十分鐘")).toBeNull();
    expect(parseStamp("-1:00")).toBeNull();
    expect(parseStamp("1:2:3:4")).toBeNull();
  });

  it("stamp 與 parseStamp 對得起來", () => {
    for (const ms of [0, 1000, 65_000, 599_000, 3_725_000]) expect(parseStamp(stamp(ms))).toBe(ms);
  });
});

describe("notesSource", () => {
  // 剪掉 5–10 秒：來源 12 秒的句子在成品裡是 7 秒
  const edl = edlOf([
    { startMs: 0, endMs: 5000 },
    { startMs: 10_000, endMs: 30_000 },
  ]);

  it("時間換算成成品時間 —— 節目筆記給的是聽眾看到的時間", () => {
    const src = notesSource(trOf([{ startMs: 1000, text: "開場" }, { startMs: 12_000, text: "重點" }]), edl);
    expect(src.map((s) => [s.outMs, s.text])).toEqual([
      [1000, "開場"],
      [7000, "重點"],
    ]);
  });

  it("被剪掉的句子不會出現 —— 那些話成品裡根本沒有", () => {
    const src = notesSource(trOf([{ startMs: 1000, text: "留著" }, { startMs: 7000, text: "剪掉了" }, { startMs: 12_000, text: "也留著" }]), edl);
    expect(src.map((s) => s.text)).toEqual(["留著", "也留著"]);
  });

  it("沒有逐字稿或沒有 EDL 就回空", () => {
    expect(notesSource(null, edl)).toEqual([]);
    expect(notesSource(trOf([{ startMs: 0, text: "x" }]), null)).toEqual([]);
  });

  it("超過字數上限就停，不會把整份 40 分鐘的稿子塞進去", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ startMs: 10_000 + i * 50, text: "十個字十個字十個字" }));
    const src = notesSource(trOf(many), edl, { maxChars: 100 });
    expect(src.length).toBeLessThan(20);
  });
});

describe("notesPrompt", () => {
  it("每行是成品時間戳加句子", () => {
    const p = notesPrompt([{ outMs: 0, text: "你好" }, { outMs: 65_000, text: "再見" }], { durationMs: 120_000 });
    expect(p).toContain("[0:00] 你好");
    expect(p).toContain("[1:05] 再見");
    expect(p).toContain("2:00"); // 節目長度
  });
});

describe("notesPrompt 的語言指示", () => {
  it("有語言指示時會出現在 prompt 裡", () => {
    const p = notesPrompt([{ outMs: 0, text: "hello" }], { durationMs: 60_000, languageLine: "Write in English." });
    expect(p).toContain("Write in English.");
  });

  it("指示放在逐字稿之前（夾在規則中間容易被忽略）", () => {
    const p = notesPrompt([{ outMs: 0, text: "hello" }], { durationMs: 60_000, languageLine: "日本語で書いてください。" });
    // 用小節標題（開頭那句話也有「逐字稿」兩個字，indexOf 會抓到那個）
    expect(p.indexOf("日本語")).toBeLessThan(p.lastIndexOf("逐字稿："));
  });

  it("沒給指示時不會留下空行殘骸", () => {
    const p = notesPrompt([{ outMs: 0, text: "hello" }], { durationMs: 60_000 });
    expect(p).not.toContain("都用同一種語言");
  });

  it("prompt 本文不再寫死繁體中文", () => {
    const p = notesPrompt([{ outMs: 0, text: "hello" }], { durationMs: 60_000 });
    expect(p).not.toContain("繁體中文");
  });
});

describe("normalizeShowNotes", () => {
  const DUR = 600_000;

  it("正常的回應照收", () => {
    const n = normalizeShowNotes(
      { summary: "摘要", chapters: [{ at: "0:00", title: "開場" }, { at: "5:00", title: "重點" }], quotes: [{ at: "2:00", text: "一句話" }], keywords: ["a", "b"] },
      DUR,
    );
    expect(n.chapters.map((c) => c.outMs)).toEqual([0, 300_000]);
    expect(n.quotes).toHaveLength(1);
    expect(n.keywords).toEqual(["a", "b"]);
  });

  it("時間戳看不懂的章節直接丟掉，不要猜一個位置", () => {
    const n = normalizeShowNotes({ chapters: [{ at: "0:00", title: "好" }, { at: "大概中間", title: "壞" }] }, DUR);
    expect(n.chapters.map((c) => c.title)).toEqual(["好"]);
  });

  it("超出節目長度的丟掉 —— 按下去會跳到空氣", () => {
    const n = normalizeShowNotes({ chapters: [{ at: "0:00", title: "好" }, { at: "99:00", title: "太後面" }] }, DUR);
    expect(n.chapters.map((c) => c.title)).toEqual(["好"]);
  });

  it("章節必須遞增：亂序或重複的丟掉", () => {
    const n = normalizeShowNotes(
      { chapters: [{ at: "0:00", title: "一" }, { at: "5:00", title: "二" }, { at: "3:00", title: "倒退" }, { at: "5:00", title: "重複" }, { at: "7:00", title: "三" }] },
      DUR,
    );
    expect(n.chapters.map((c) => c.title)).toEqual(["一", "二", "三"]);
  });

  it("第一個章節補到 0 —— 開頭不該有一段沒有章節的空窗", () => {
    const n = normalizeShowNotes({ chapters: [{ at: "0:03", title: "開場" }, { at: "5:00", title: "重點" }] }, DUR);
    expect(n.chapters[0].outMs).toBe(0);
    expect(n.chapters[1].outMs).toBe(300_000);
  });

  it("沒有標題的章節不要", () => {
    expect(normalizeShowNotes({ chapters: [{ at: "0:00", title: "  " }] }, DUR).chapters).toEqual([]);
  });

  it("完全不成形的回應也不會炸", () => {
    const n = normalizeShowNotes({}, DUR);
    expect(n).toEqual({ summary: "", chapters: [], quotes: [], keywords: [] });
    expect(normalizeShowNotes({ chapters: "不是陣列", quotes: 42 } as never, DUR).chapters).toEqual([]);
  });
});

describe("toMarkdown", () => {
  it("章節與節錄都帶時間戳", () => {
    const md = toMarkdown(
      { summary: "這集在講 X。", chapters: [{ outMs: 0, title: "開場" }, { outMs: 65_000, title: "重點" }], quotes: [{ outMs: 30_000, text: "金句" }], keywords: ["a", "b"] },
      { title: "第 12 集" },
    );
    expect(md).toContain("# 第 12 集");
    expect(md).toContain("- `0:00` 開場");
    expect(md).toContain("- `1:05` 重點");
    expect(md).toContain("> 金句");
    expect(md).toContain("a、b");
  });

  it("空的區塊不會留下空標題", () => {
    const md = toMarkdown({ summary: "只有摘要", chapters: [], quotes: [], keywords: [] });
    expect(md).not.toContain("## 章節");
    expect(md).not.toContain("## 節錄");
    expect(md.trim()).toBe("只有摘要");
  });
});

describe("markersToChapters", () => {
  const edl = edlOf([
    { startMs: 0, endMs: 5000 },
    { startMs: 10_000, endMs: 30_000 },
  ]);
  const marker = (ms: number, kind: Marker["kind"], title: string): Marker => ({ id: `m${ms}`, ms, kind, title });

  it("只取章節標記，換算成成品時間並排序", () => {
    const got = markersToChapters([marker(12_000, "chapter", "後面"), marker(1000, "chapter", "前面"), marker(2000, "todo", "待辦")], edl);
    expect(got).toEqual([
      { outMs: 1000, title: "前面" },
      { outMs: 7000, title: "後面" },
    ]);
  });

  it("沒有標題的章節標記不要（節目筆記裡是空行）", () => {
    expect(markersToChapters([marker(1000, "chapter", "")], edl)).toEqual([]);
  });
});

describe("notesSource：亂序的 EDL（剪下貼上 / 搬移）", () => {
  it("時間戳依成品順序給 —— 照來源順序給的話 claude 讀到的是一集不存在的節目", () => {
    // 成品順序＝來源 10–14 秒那段在前，0–4 秒那段在後
    const edl = edlOf([{ startMs: 10_000, endMs: 14_000 }, { startMs: 0, endMs: 4000 }]);
    const src = notesSource(trOf([{ startMs: 1000, text: "開場" }, { startMs: 12_000, text: "重點" }]), edl);
    expect(src).toEqual([
      { outMs: 2000, text: "重點" },
      { outMs: 5000, text: "開場" },
    ]);
    // 時間戳必須遞增，不然 notesPrompt 那句「時間戳是成品裡的位置」就是騙人的
    for (let i = 1; i < src.length; i++) expect(src[i].outMs).toBeGreaterThan(src[i - 1].outMs);
  });

  it("貼上：同一句在成品出現兩次，素材也要出現兩次", () => {
    const edl = edlOf([
      { startMs: 0, endMs: 4000 },
      { startMs: 10_000, endMs: 14_000 },
      { startMs: 10_000, endMs: 14_000 },
    ]);
    const src = notesSource(trOf([{ startMs: 1000, text: "開場" }, { startMs: 12_000, text: "重點" }]), edl);
    expect(src).toEqual([
      { outMs: 1000, text: "開場" },
      { outMs: 6000, text: "重點" },
      { outMs: 10_000, text: "重點" },
    ]);
  });
});
