import { describe, expect, it } from "vitest";
import {
  addHotword,
  hotwordsStats,
  HOTWORDS_SOFT_LIMIT,
  parseHotwords,
  removeHotword,
  serializeHotwords,
  suggestHotwords,
  type ProbeWord,
} from "./hotwords";

function w(text: string, prob: number, norm = text.toLowerCase()): ProbeWord {
  return { text, norm, prob };
}

describe("parseHotwords", () => {
  it("拆得開各種分隔符（含全形與貼進來的多行）", () => {
    expect(parseHotwords("Tauri, wavesurfer，ffmpeg、Rust;Zustand\nVite")).toEqual([
      "Tauri",
      "wavesurfer",
      "ffmpeg",
      "Rust",
      "Zustand",
      "Vite",
    ]);
  });

  it("去空白與空項", () => {
    expect(parseHotwords("  Tauri ,, , Rust  ")).toEqual(["Tauri", "Rust"]);
  });

  it("去重時忽略大小寫，但留第一次出現的寫法", () => {
    expect(parseHotwords("Tauri,tauri,TAURI")).toEqual(["Tauri"]);
  });

  it("不把大小寫正規化掉（專有名詞的大小寫是有意義的）", () => {
    expect(parseHotwords("TypeScript")).toEqual(["TypeScript"]);
  });

  it("空值不會炸", () => {
    expect(parseHotwords("")).toEqual([]);
    expect(parseHotwords(null)).toEqual([]);
    expect(parseHotwords(undefined)).toEqual([]);
  });
});

describe("serialize / add / remove", () => {
  it("往返之後還是同一串", () => {
    const s = "Tauri,Rust,ffmpeg";
    expect(serializeHotwords(parseHotwords(s))).toBe(s);
  });

  it("加已經有的詞不會變成兩個", () => {
    expect(addHotword(["Tauri"], "tauri")).toEqual(["Tauri"]);
  });

  it("一次加一整串貼上的內容", () => {
    expect(addHotword(["Tauri"], "Rust、Vite")).toEqual(["Tauri", "Rust", "Vite"]);
  });

  it("移除忽略大小寫", () => {
    expect(removeHotword(["Tauri", "Rust"], "TAURI")).toEqual(["Rust"]);
  });
});

describe("hotwordsStats", () => {
  it("算詞數與字元數", () => {
    const s = hotwordsStats(["Tauri", "Rust"]);
    expect(s.count).toBe(2);
    expect(s.chars).toBe("Tauri,Rust".length);
    expect(s.overLimit).toBe(false);
  });

  it("超過軟上限時標出來（提醒，不是擋）", () => {
    const many = Array.from({ length: 200 }, (_, i) => `word${i}`);
    const s = hotwordsStats(many);
    expect(s.chars).toBeGreaterThan(HOTWORDS_SOFT_LIMIT);
    expect(s.overLimit).toBe(true);
  });
});

describe("suggestHotwords", () => {
  const words: ProbeWord[] = [
    w("Tauri", 0.2),
    w("Tauri", 0.3),
    w("Tauri", 0.25),
    w("wavesurfer", 0.4),
    w("的", 0.1), // 單字，多半是語助詞不是專有名詞
    w("今天", 0.95), // 高信心
    w("ffmpeg", 0.45),
  ];

  it("只挑辨識器沒把握的字", () => {
    const s = suggestHotwords(words, []);
    expect(s.map((x) => x.text)).not.toContain("今天");
  });

  it("跳過單字（低信心的單字多半是語助詞）", () => {
    expect(suggestHotwords(words, []).map((x) => x.text)).not.toContain("的");
  });

  it("同一個詞合併，次數累加、留最低信心那次的寫法", () => {
    const hit = suggestHotwords(words, []).find((x) => x.text === "Tauri")!;
    expect(hit.count).toBe(3);
    expect(hit.minProb).toBeCloseTo(0.2);
  });

  it("出現多又不確定的排前面", () => {
    expect(suggestHotwords(words, [])[0].text).toBe("Tauri");
  });

  it("已經在清單裡的不再建議", () => {
    expect(suggestHotwords(words, ["tauri"]).map((x) => x.text)).not.toContain("Tauri");
  });

  it("limit 生效", () => {
    expect(suggestHotwords(words, [], { limit: 1 })).toHaveLength(1);
  });

  it("沒有低信心的字時回空陣列", () => {
    expect(suggestHotwords([w("今天", 0.99), w("很好", 0.98)], [])).toEqual([]);
  });
});

describe("suggestHotwords：不該推薦的東西", () => {
  it("贅字不會被當成領域詞", () => {
    // 「我覺得」信心低是因為講得含糊，不是辨識器不認得它 ——
    // 加進 hotwords 只會叫辨識器更用力去聽一個等一下要剪掉的詞
    const s = suggestHotwords([w("我覺得", 0.11), w("嗯嗯", 0.2), w("Tauri", 0.2)], []);
    expect(s.map((x) => x.text)).toEqual(["Tauri"]);
  });

  it("建議的詞會去掉頭尾標點", () => {
    expect(suggestHotwords([w("level。", 0.31, "level")], [])[0].text).toBe("level");
  });

  it("整個詞都是標點時退回 norm，不會變空字串", () => {
    expect(suggestHotwords([w("——", 0.2, "ab")], [])[0].text).toBe("ab");
  });
});
