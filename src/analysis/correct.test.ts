import { describe, expect, it } from "vitest";
import { correctAll, correctWord, occurrences } from "./correct";
import { normalizeTranscript, type ServerTranscript } from "./normalize";

function make(words: [string, number, number][]): ServerTranscript {
  return {
    duration_sec: 10,
    segments: [
      {
        id: 0,
        start: words[0][1] / 1000,
        end: words[words.length - 1][2] / 1000,
        text: words.map((w) => w[0]).join(""),
        words: words.map(([w, a, b]) => ({ start: a / 1000, end: b / 1000, word: w, probability: 0.9 })),
      },
    ],
    vad: [{ start: 0, end: 10 }],
  };
}

const t = normalizeTranscript(
  make([
    ["淘瑞", 0, 500],
    ["很", 500, 700],
    ["好用", 700, 1200],
    ["，", 1200, 1250],
    ["淘瑞", 1300, 1800],
  ]),
);

describe("correctWord", () => {
  it("改得掉文字", () => {
    const r = correctWord(t, 0, "Tauri");
    expect(r.changed).toBe(true);
    expect(r.before).toBe("淘瑞");
    expect(r.transcript.words[0].text).toBe("Tauri");
  });

  it("norm 跟著重算（不然搜尋還是找不到）", () => {
    expect(correctWord(t, 0, "Tauri").transcript.words[0].norm).toBe("tauri");
  });

  it("**不動時間軸**：改文字不代表那段聲音變了", () => {
    const r = correctWord(t, 0, "Tauri");
    expect(r.transcript.words[0].startMs).toBe(t.words[0].startMs);
    expect(r.transcript.words[0].endMs).toBe(t.words[0].endMs);
    expect(r.transcript.durationMs).toBe(t.durationMs);
  });

  it("segment 的整句文字也跟著（節目筆記讀的是它）", () => {
    expect(correctWord(t, 0, "Tauri").transcript.segments[0].text).toContain("Tauri");
  });

  it("其他字不受影響", () => {
    const r = correctWord(t, 0, "Tauri");
    expect(r.transcript.words[1].text).toBe(t.words[1].text);
    expect(r.transcript.words[4].text).toBe("淘瑞"); // 只改指定的那一個
  });

  it("空字串不接受（要拿掉字請用剪的）", () => {
    expect(correctWord(t, 0, "   ").changed).toBe(false);
    expect(correctWord(t, 0, "").transcript).toBe(t);
  });

  it("改成一樣的不算改（不要製造一筆空的 undo）", () => {
    expect(correctWord(t, 0, "淘瑞").changed).toBe(false);
  });

  it("找不到的字 id 不會炸", () => {
    expect(correctWord(t, 999, "x").changed).toBe(false);
  });

  it("不改到原本的逐字稿", () => {
    correctWord(t, 0, "Tauri");
    expect(t.words[0].text).toBe("淘瑞");
  });
});

describe("correctAll", () => {
  it("一次改掉所有一樣的字", () => {
    const r = correctAll(t, 0, "Tauri");
    expect(r.count).toBe(2);
    expect(r.transcript.words[0].text).toBe("Tauri");
    expect(r.transcript.words[4].text).toBe("Tauri");
  });

  it("不一樣的字不動", () => {
    const r = correctAll(t, 0, "Tauri");
    expect(r.transcript.words[1].text).toBe("很");
  });

  it("改成一樣的不做事", () => {
    expect(correctAll(t, 0, "淘瑞").count).toBe(0);
  });

  it("空字串不做事", () => {
    expect(correctAll(t, 0, " ").changed).toBe(false);
  });

  it("找不到的 id 不會炸", () => {
    expect(correctAll(t, 999, "x").count).toBe(0);
  });
});

describe("occurrences", () => {
  it("數得出出現幾次", () => {
    expect(occurrences(t, 0)).toBe(2);
    expect(occurrences(t, 1)).toBe(1);
  });

  it("找不到的 id 回 0", () => {
    expect(occurrences(t, 999)).toBe(0);
  });
});
