import { describe, expect, it } from "vitest";
import { cutsForKeeping, DEFAULT_TAKES, editDistance, findTakes, savedMsOf, similarity } from "./takes";
import { normText } from "./normalize";
import type { Sentence, Word } from "./types";

/** 把幾句話造成 sentences + words；每個字 200 ms，句與句之間隔 gapMs。 */
function build(lines: string[], gapMs = 500): { sentences: Sentence[]; words: Word[] } {
  const words: Word[] = [];
  const sentences: Sentence[] = [];
  let t = 0;
  lines.forEach((line, si) => {
    const chars = [...line];
    const ids: number[] = [];
    for (const ch of chars) {
      const id = words.length;
      words.push({ id, segId: si, text: ch, norm: normText(ch), startMs: t, endMs: t + 180, prob: 0.9 });
      ids.push(id);
      t += 200;
    }
    sentences.push({
      id: si,
      wordIds: ids,
      startMs: words[ids[0]].startMs,
      endMs: words[ids[ids.length - 1]].endMs,
      endsWithQuestion: false,
    });
    t += gapMs;
  });
  return { sentences, words };
}

describe("editDistance / similarity", () => {
  it("一樣就是 0 距離、相似度 1", () => {
    expect(editDistance("這個功能很好用", "這個功能很好用")).toBe(0);
    expect(similarity("這個功能很好用", "這個功能很好用")).toBe(1);
  });

  it("空字串", () => {
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("abc", "")).toBe(3);
    expect(similarity("", "")).toBe(1);
  });

  it("差一個字", () => {
    expect(editDistance("這個功能很好用", "這個功能非好用")).toBe(1);
    expect(similarity("這個功能很好用", "這個功能非好用")).toBeCloseTo(6 / 7, 3);
  });

  it("完全不同的兩句相似度很低", () => {
    expect(similarity("今天天氣真好", "我等一下要去買東西")).toBeLessThan(0.3);
  });
});

describe("findTakes", () => {
  it("沒有重複就沒有 take", () => {
    const { sentences, words } = build(["今天要談的是錄音設備", "我們先從麥克風開始講起"]);
    expect(findTakes(sentences, words)).toEqual([]);
  });

  it("同一句講兩次會被抓成一組", () => {
    const { sentences, words } = build(["這個功能真的非常好用", "這個功能真的很好用"]);
    const g = findTakes(sentences, words);
    expect(g).toHaveLength(1);
    expect(g[0].attempts).toHaveLength(2);
    expect(g[0].attempts.map((a) => a.sentenceId)).toEqual([0, 1]);
  });

  it("預設留最後一次（會再講一遍就是因為前面不滿意）", () => {
    const { sentences, words } = build(["這個功能真的非常好用", "這個功能真的很好用"]);
    expect(findTakes(sentences, words)[0].defaultKeep).toBe(1);
  });

  it("講三次會串成同一組，不是兩組", () => {
    const { sentences, words } = build([
      "這個功能真的非常好用",
      "這個功能真的很好用",
      "這個功能真的蠻好用",
    ]);
    const g = findTakes(sentences, words);
    expect(g).toHaveLength(1);
    expect(g[0].attempts).toHaveLength(3);
    expect(g[0].defaultKeep).toBe(2);
  });

  it("短句重複不算（「對」「好」本來就會一直出現）", () => {
    const { sentences, words } = build(["對啊", "對啊", "對啊"]);
    expect(findTakes(sentences, words)).toEqual([]);
  });

  it("隔太久不算（那多半是又提到同一件事）", () => {
    const { sentences, words } = build(["這個功能真的非常好用", "這個功能真的很好用"], 30_000);
    expect(findTakes(sentences, words)).toEqual([]);
  });

  it("中間隔太多句不算重錄", () => {
    const { sentences, words } = build([
      "這個功能真的非常好用",
      "我等一下再解釋為什麼",
      "先講一下背景好了",
      "另外還有一件事情要說",
      "這個功能真的很好用",
    ]);
    expect(findTakes(sentences, words)).toEqual([]);
  });

  it("只是主題相同但講法不同，不算重錄", () => {
    const { sentences, words } = build(["這個功能真的非常好用", "那個東西我完全不推薦"]);
    expect(findTakes(sentences, words)).toEqual([]);
  });

  it("同一集裡兩處各自重錄 → 兩組", () => {
    const { sentences, words } = build([
      "這個功能真的非常好用",
      "這個功能真的很好用",
      "接下來要談的是價格問題",
      "我們今天先講到這裡好了",
      "我們今天就先講到這裡",
    ]);
    const g = findTakes(sentences, words);
    expect(g).toHaveLength(2);
    expect(g[0].attempts[0].startMs).toBeLessThan(g[1].attempts[0].startMs);
  });

  it("門檻可以調鬆", () => {
    const { sentences, words } = build(["這個功能很好用啊", "這個東西很好用喔"]);
    expect(findTakes(sentences, words)).toEqual([]);
    const loose = { ...DEFAULT_TAKES, minSimilarity: 0.5 };
    expect(findTakes(sentences, words, loose)).toHaveLength(1);
  });

  it("回傳依時間排序", () => {
    const { sentences, words } = build([
      "第一個段落要講的內容",
      "第一個段落要講的東西",
      "後面這段完全不一樣喔",
      "最後一個段落的內容是",
      "最後一個段落的東西是",
    ]);
    const g = findTakes(sentences, words);
    for (let i = 1; i < g.length; i++) {
      expect(g[i].attempts[0].startMs).toBeGreaterThan(g[i - 1].attempts[0].startMs);
    }
  });
});

describe("cutsForKeeping", () => {
  const group = {
    id: "g",
    defaultKeep: 2,
    attempts: [
      { index: 0, sentenceId: 0, startMs: 0, endMs: 1000, text: "a" },
      { index: 1, sentenceId: 1, startMs: 2000, endMs: 3200, text: "b" },
      { index: 2, sentenceId: 2, startMs: 4000, endMs: 5000, text: "c" },
    ],
  };

  it("留最後一次 → 剪掉前兩次", () => {
    expect(cutsForKeeping(group, 2)).toEqual([
      { startMs: 0, endMs: 1000 },
      { startMs: 2000, endMs: 3200 },
    ]);
  });

  it("留第一次 → 剪掉後兩次", () => {
    expect(cutsForKeeping(group, 0)).toEqual([
      { startMs: 2000, endMs: 3200 },
      { startMs: 4000, endMs: 5000 },
    ]);
  });

  it("索引超出範圍回空陣列，**不會**把整組剪光", () => {
    expect(cutsForKeeping(group, 3)).toEqual([]);
    expect(cutsForKeeping(group, -1)).toEqual([]);
    expect(cutsForKeeping(group, 1.5)).toEqual([]);
    expect(cutsForKeeping(group, NaN)).toEqual([]);
  });

  it("省下來的時間 = 被剪掉那幾段的總長", () => {
    expect(savedMsOf(group, 2)).toBe(1000 + 1200);
    expect(savedMsOf(group, 0)).toBe(1200 + 1000);
    expect(savedMsOf(group, 99)).toBe(0);
  });
});
