// 領域詞（hotwords）：讓 ASR 認得專有名詞 —— 人名、產品名、術語、公司名。
//
// **跟贅字詞表是相反的兩件事**，很容易搞混：
// - 領域詞 = 「請聽對這幾個字」，餵給辨識器，影響的是逐字稿的內容。
// - 贅字詞表（fillerStats / lexicon）= 「這幾個字要剪掉」，影響的是候選。
// 一個在辨識之前，一個在辨識之後。
//
// 儲存格式沿用設定裡原本的逗號分隔字串（faster-whisper 吃這個形狀），
// 這裡只負責在「字串」與「一個一個的詞」之間來回，讓 UI 可以用晶片的方式編輯。

import { isAnyFiller } from "./lexicon";

/** 頭尾的標點。逐字稿的字常帶著標點（「level。」），當詞用要去掉。 */
const EDGE_PUNCT_RE = /^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu;

/** 分隔符：半形逗號、全形逗號、頓號、分號、換行。貼一整段進來也要拆得開。 */
const SEP_RE = /[,，、;；\n\r]+/;

/**
 * 字串 → 詞陣列。去空白、去重（保留第一次出現的順序與寫法）。
 * 大小寫**不**正規化：專有名詞的大小寫是有意義的（TypeScript ≠ typescript）。
 */
export function parseHotwords(raw: string | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of (raw ?? "").split(SEP_RE)) {
    const w = part.trim();
    if (!w) continue;
    // 去重時忽略大小寫，但留下的是第一次出現的那個寫法
    const key = w.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

/** 詞陣列 → 存進設定的字串。 */
export function serializeHotwords(words: string[]): string {
  return parseHotwords(words.join(",")).join(",");
}

/** 加一個詞（已存在就原樣回傳，不會有重複）。 */
export function addHotword(words: string[], raw: string): string[] {
  return parseHotwords([...words, raw].join(","));
}

export function removeHotword(words: string[], word: string): string[] {
  const key = word.toLowerCase();
  return words.filter((w) => w.toLowerCase() !== key);
}

/**
 * 辨識器對 hotwords 的長度是有實務上限的（太長會被截掉或直接拖慢辨識）。
 * 這不是硬性規格，是給使用者的提醒 —— 所以只回「多長」跟「要不要警告」，不擋。
 */
export const HOTWORDS_SOFT_LIMIT = 800;

export interface HotwordsStats {
  count: number;
  chars: number;
  overLimit: boolean;
}

export function hotwordsStats(words: string[]): HotwordsStats {
  const chars = serializeHotwords(words).length;
  return { count: words.length, chars, overLimit: chars > HOTWORDS_SOFT_LIMIT };
}

export interface HotwordSuggestion {
  /** 顯示用的原文（取信心最低那次的寫法）。 */
  text: string;
  /** 出現幾次。 */
  count: number;
  /** 這個詞的最低辨識信心（0–1）。 */
  minProb: number;
}

/** 建議來源的字。只取 `prob`，所以逐字稿與測試都餵得進來。 */
export interface ProbeWord {
  text: string;
  norm: string;
  prob: number;
}

/**
 * 從逐字稿挑出「辨識器沒把握的字」當領域詞候選。
 *
 * 這才是領域詞真正的用途：使用者不會憑空想得起來要加哪些字，
 * 但看到「你的節目裡『Tauri』被聽成三種不同的東西、信心 0.2」就知道要加了。
 *
 * 只收：信心低於門檻、長度 ≥ 2（單字的低信心多半是語助詞而不是專有名詞）、
 * 不在既有清單裡。依「出現次數 × 有多不確定」排序。
 */
export function suggestHotwords(
  words: ProbeWord[],
  existing: string[],
  opts: { maxProb?: number; limit?: number; minLen?: number } = {},
): HotwordSuggestion[] {
  const maxProb = opts.maxProb ?? 0.5;
  const limit = opts.limit ?? 12;
  const minLen = opts.minLen ?? 2;
  const have = new Set(existing.map((w) => w.toLowerCase()));
  const by = new Map<string, HotwordSuggestion>();
  for (const w of words) {
    if (!w.norm || w.prob >= maxProb) continue;
    if ([...w.norm].length < minLen) continue;
    if (have.has(w.norm.toLowerCase())) continue;
    // 贅字永遠不是領域詞。「我覺得」信心低是因為它講得含糊，不是因為辨識器不認得它 ——
    // 把它加進 hotwords 只會叫辨識器更用力去聽一個等一下要剪掉的詞。
    if (isAnyFiller(w.norm)) continue;
    const display = (w.text.trim() || w.norm).replace(EDGE_PUNCT_RE, "") || w.norm;
    const cur = by.get(w.norm);
    if (!cur) by.set(w.norm, { text: display, count: 1, minProb: w.prob });
    else {
      cur.count += 1;
      if (w.prob < cur.minProb) {
        cur.minProb = w.prob;
        cur.text = display;
      }
    }
  }
  return [...by.values()]
    .sort((a, b) => b.count * (1 - b.minProb) - a.count * (1 - a.minProb) || a.minProb - b.minProb || a.text.localeCompare(b.text))
    .slice(0, limit);
}
