import type { Transcript } from "./types";

/**
 * 逐字稿文字搜尋 —— 把「剪掉整集的口頭禪」從 23 個手勢變成 1 個。
 *
 * 逐字稿的字已經帶了 `Word.norm`（NFKC + 小寫 + 去標點空白），把它們接成一條字串
 * 就能直接用 indexOf 掃。真正的工作在那份「字元位置 → 字索引」的對照表：
 * 命中是字元區間，但要剪掉的是字，得換算回去。
 *
 * 這樣掃出來的命中天生跨字也跨句 —— ASR 把「那個」拆成兩個 token、或是把
 * 「呃，那個」的逗號黏在字尾，都不影響比對，因為標點在 norm 裡本來就沒了。
 */

export interface TextHit {
  /** 字索引，兩端都含。 */
  startIdx: number;
  endIdx: number;
  startMs: number;
  endMs: number;
  wordIds: number[];
  /** 起點所在的句子 id；找不到是 -1。 */
  sentenceId: number;
  /** 原字（含標點），給人看的。 */
  text: string;
}

export interface FindTextOptions {
  /** 上限，避免有人搜一個字把整份逐字稿都撈出來。預設 500。 */
  limit?: number;
}

/** 查詢字串的正規化：與 `Word.norm` 同一套（NFKC + 小寫 + 去標點空白）。 */
export function normalizeQuery(q: string): string {
  return q
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

/**
 * 找出 query 在逐字稿裡的所有命中。
 *
 * 命中之間不重疊：掃到一個就從它的尾巴後面繼續，所以「那那那」搜「那那」只算一個。
 * 這是刻意的 —— 命中是要拿去剪的，重疊的區間剪起來會互相吃掉。
 */
export function findText(t: Transcript | null, query: string, opts: FindTextOptions = {}): TextHit[] {
  const needle = normalizeQuery(query);
  // 只打了標點或空白 → 正規化後是空字串，indexOf("") 每個位置都命中，等於整份逐字稿
  if (!t || !needle) return [];

  const limit = opts.limit ?? 500;
  const words = t.words;

  // 接字串，同時記下每個字元屬於哪個字
  let hay = "";
  const owner: number[] = [];
  for (let i = 0; i < words.length; i++) {
    const n = words[i].norm;
    if (!n) continue; // 純標點的 token 不占字元，但仍可能夾在命中中間（下面用索引區間涵蓋）
    hay += n;
    for (let k = 0; k < n.length; k++) owner.push(i);
  }

  const sentenceOf = new Map<number, number>();
  for (const s of t.sentences) for (const id of s.wordIds) sentenceOf.set(id, s.id);

  const hits: TextHit[] = [];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at < 0 || hits.length >= limit) break;
    const startIdx = owner[at];
    const endIdx = owner[at + needle.length - 1];
    from = at + needle.length;
    if (startIdx == null || endIdx == null) break;

    const span = words.slice(startIdx, endIdx + 1);
    hits.push({
      startIdx,
      endIdx,
      startMs: span[0].startMs,
      endMs: span[span.length - 1].endMs,
      wordIds: span.map((w) => w.id),
      sentenceId: sentenceOf.get(span[0].id) ?? -1,
      text: span.map((w) => w.text).join(""),
    });
  }
  return hits;
}

/** 常見口頭禪詞表：面板一打開就有東西可以按，不用使用者自己想。 */
const FILLERS = ["呃", "嗯", "啊那個", "那個那個", "那個", "就是說", "就是", "然後", "對啊", "你知道", "um", "uh", "erm", "like", "you know", "i mean"];

/**
 * 掃出這份逐字稿裡真的存在的口頭禪。
 *
 * 只回出現 2 次以上的 —— 出現一次的不叫口頭禪，叫講話。
 * 長的詞優先（「那個那個」排在「那個」前面），且被長詞吃掉的短詞會扣掉重複的次數，
 * 否則「那個那個 ×5」會讓「那個」看起來有 10 次，使用者按了短的反而剪掉更多。
 */
export function fillerCandidates(t: Transcript | null, minCount = 2): { query: string; count: number }[] {
  if (!t) return [];
  const out: { query: string; count: number }[] = [];
  const taken: { a: number; b: number }[] = [];
  const sorted = [...FILLERS].sort((a, b) => normalizeQuery(b).length - normalizeQuery(a).length);
  for (const q of sorted) {
    const hits = findText(t, q).filter((h) => !taken.some((r) => h.startIdx <= r.b && h.endIdx >= r.a));
    if (hits.length >= minCount) {
      out.push({ query: q, count: hits.length });
      for (const h of hits) taken.push({ a: h.startIdx, b: h.endIdx });
    }
  }
  return out.sort((a, b) => b.count - a.count);
}

/** 命中總時長（ms）—— 用來預告「剪掉之後會短多少」。 */
export function totalMs(hits: TextHit[]): number {
  return hits.reduce((sum, h) => sum + (h.endMs - h.startMs), 0);
}
