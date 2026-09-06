import { describe, expect, it } from "vitest";
import { fillerCandidates, findText, normalizeQuery, totalMs } from "./textSearch";
import type { Transcript, Word } from "./types";

/** 用一串「原字」造逐字稿；每個字 200 ms，句子每 n 個字切一次。 */
function make(texts: string[], perSentence = 4): Transcript {
  const words: Word[] = texts.map((text, i) => ({
    id: i,
    segId: 0,
    text,
    norm: normalizeQuery(text),
    startMs: i * 200,
    endMs: i * 200 + 180,
    prob: 0.9,
  }));
  const sentences = [];
  for (let i = 0; i < words.length; i += perSentence) {
    const chunk = words.slice(i, i + perSentence);
    sentences.push({
      id: sentences.length,
      wordIds: chunk.map((w) => w.id),
      startMs: chunk[0].startMs,
      endMs: chunk[chunk.length - 1].endMs,
      endsWithQuestion: false,
    });
  }
  return { words, segments: [], sentences, vad: [], durationMs: words.length * 200, language: "zh", model: "test" };
}

describe("normalizeQuery", () => {
  it("去掉標點與空白、轉小寫、NFKC", () => {
    expect(normalizeQuery("那個，那個")).toBe("那個那個");
    expect(normalizeQuery("  Um... ")).toBe("um");
    expect(normalizeQuery("ＡＢ")).toBe("ab");
  });
});

describe("findText", () => {
  it("命中可以跨字 token —— ASR 把『那個』拆成兩個字也找得到", () => {
    const t = make(["我", "覺", "得", "那", "個", "很", "好"]);
    const hits = findText(t, "那個");
    expect(hits).toHaveLength(1);
    expect(hits[0].startIdx).toBe(3);
    expect(hits[0].endIdx).toBe(4);
    expect(hits[0].wordIds).toEqual([3, 4]);
    expect(hits[0].startMs).toBe(600);
    expect(hits[0].endMs).toBe(980);
  });

  it("標點黏在字尾不影響比對", () => {
    const t = make(["呃，", "那個", "好"]);
    expect(findText(t, "呃那個")).toHaveLength(1);
    expect(findText(t, "呃，那 個")).toHaveLength(1);
  });

  it("可以跨句 —— 命中不受句界限制", () => {
    const t = make(["結", "束", "了", "然", "後", "我", "們", "走"], 4);
    const hits = findText(t, "了然後");
    expect(hits).toHaveLength(1);
    // 起點在第 0 句、終點在第 1 句
    expect(hits[0].sentenceId).toBe(0);
    expect(hits[0].endIdx).toBe(4);
  });

  it("命中不重疊：『那那那』搜『那那』只算一個", () => {
    const t = make(["那", "那", "那"]);
    const hits = findText(t, "那那");
    expect(hits).toHaveLength(1);
    expect(hits[0].startIdx).toBe(0);
    expect(hits[0].endIdx).toBe(1);
  });

  it("多筆命中依序回傳", () => {
    const t = make(["呃", "好", "呃", "壞", "呃"]);
    const hits = findText(t, "呃");
    expect(hits.map((h) => h.startIdx)).toEqual([0, 2, 4]);
    expect(totalMs(hits)).toBe(180 * 3);
  });

  it("只打標點 / 空白時回空 —— 不可以把整份逐字稿當命中", () => {
    const t = make(["一", "二", "三"]);
    expect(findText(t, "，")).toEqual([]);
    expect(findText(t, "   ")).toEqual([]);
    expect(findText(t, "")).toEqual([]);
    expect(findText(null, "一")).toEqual([]);
  });

  it("純標點的 token 不會擋住命中", () => {
    const t = make(["那", "，", "個"]);
    const hits = findText(t, "那個");
    expect(hits).toHaveLength(1);
    // 中間那個逗號 token 也一起被涵蓋，剪起來才不會留下孤兒
    expect(hits[0].wordIds).toEqual([0, 1, 2]);
  });

  it("尊重 limit", () => {
    const t = make(Array.from({ length: 50 }, () => "呃"));
    expect(findText(t, "呃", { limit: 10 })).toHaveLength(10);
  });

  it("回傳的 text 是原字（含標點）給人看", () => {
    const t = make(["呃，", "那個"]);
    expect(findText(t, "呃那個")[0].text).toBe("呃，那個");
  });
});

describe("fillerCandidates", () => {
  it("只回出現兩次以上的", () => {
    const t = make(["呃", "好", "呃", "然", "後", "走"]);
    const got = fillerCandidates(t);
    expect(got.find((f) => f.query === "呃")?.count).toBe(2);
    // 「然後」只出現一次 → 不是口頭禪
    expect(got.find((f) => f.query === "然後")).toBeUndefined();
  });

  it("長詞優先，短詞不重複計已被長詞吃掉的那些", () => {
    // 「那個那個」兩組（= 4 個「那個」），另外還有 2 個單獨的「那個」
    const t = make(["那個", "那個", "行", "那個", "那個", "行", "那個", "停", "那個", "停"]);
    const got = fillerCandidates(t);
    expect(got.find((f) => f.query === "那個那個")?.count).toBe(2);
    // 短的只剩沒被吃掉的 2 個，不是 6
    expect(got.find((f) => f.query === "那個")?.count).toBe(2);
  });

  it("依次數由多到少排序", () => {
    const t = make(["呃", "呃", "呃", "嗯", "嗯"]);
    const got = fillerCandidates(t);
    expect(got[0].query).toBe("呃");
    expect(got[0].count).toBe(3);
  });

  it("沒有逐字稿時回空", () => {
    expect(fillerCandidates(null)).toEqual([]);
  });
});
