// 本集贅字統計：把贅字候選按「是哪個詞」歸類。
//
// 為什麼要按詞歸類而不是逐筆審：一集 57 分鐘的節目會有上千筆贅字候選，
// 逐筆點是逐筆點不完的。但它們其實只有二三十個「詞」——
// 「然後」四百次、「就是」兩百次、「對」一百次。以詞為單位一次決定一整群，
// 才是這件事真正的操作粒度。
import { fillerRuleFor, isBuiltinFiller, type FillerMode } from "./lexicon";
import { isActiveState, type Candidate, type DecisionMap, type Word } from "./types";

export interface FillerGroup {
  /** 正規化後的詞（詞表以這個為鍵）。 */
  norm: string;
  /** 顯示用的原文（取第一次出現的樣子，保留原本的大小寫與字形）。 */
  text: string;
  /** 這個詞的所有候選 id。 */
  ids: string[];
  count: number;
  /** 目前會被剪掉的（auto / accepted）。 */
  cut: number;
  pending: number;
  rejected: number;
  /** 全部剪掉可以省下的毫秒數。 */
  totalMs: number;
  /** 已經被剪掉的那些佔多少毫秒。 */
  cutMs: number;
  /** 使用者詞表裡對這個詞的裁決（沒動過就是 null）。 */
  rule: FillerMode | null;
  /** 內建詞表本來就認得這個詞嗎。 */
  builtin: boolean;
}

/** 頭尾的標點 / 空白。歸類是用 norm，這只影響顯示。 */
const EDGE_PUNCT_RE = /^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu;

function textOf(c: Candidate, words: Word[]): { norm: string; text: string } {
  const ws = c.wordIds.map((id) => words[id]).filter(Boolean);
  return {
    norm: ws.map((w) => w.norm).join(""),
    // 逐字稿的字常常帶著標點（「對。」「這個,」）。同一個詞在不同位置標點不同，
    // 列出來會像兩個不同的東西 —— 但它們歸的是同一類，所以顯示也要一致。
    text: ws.map((w) => w.text.trim()).join("").replace(EDGE_PUNCT_RE, ""),
  };
}

/**
 * 依詞歸類贅字候選，次數多的排前面。
 * 只收 kind==="filler" 的；口吃、停頓那些有自己的規則，混在一起管會誤導。
 */
export function groupFillers(candidates: Candidate[], decisions: DecisionMap, words: Word[]): FillerGroup[] {
  const by = new Map<string, FillerGroup>();
  for (const c of candidates) {
    if (c.kind !== "filler") continue;
    const { norm, text } = textOf(c, words);
    if (!norm) continue;
    let g = by.get(norm);
    if (!g) {
      g = {
        norm,
        text: text || norm,
        ids: [],
        count: 0,
        cut: 0,
        pending: 0,
        rejected: 0,
        totalMs: 0,
        cutMs: 0,
        rule: fillerRuleFor(norm),
        builtin: isBuiltinFiller(norm),
      };
      by.set(norm, g);
    }
    const state = decisions[c.id]?.state;
    const ms = Math.max(0, c.endMs - c.startMs);
    g.ids.push(c.id);
    g.count += 1;
    g.totalMs += ms;
    if (isActiveState(state)) {
      g.cut += 1;
      g.cutMs += ms;
    } else if (state === "rejected") g.rejected += 1;
    else g.pending += 1;
  }
  // 次數相同的用總時長排，再不然用詞本身 —— 排序必須穩定，
  // 不然每次重繪列的順序都在跳，沒有人按得到想按的那一列。
  return [...by.values()].sort((a, b) => b.count - a.count || b.totalMs - a.totalMs || a.norm.localeCompare(b.norm));
}

export interface FillerTotals {
  words: number;
  count: number;
  cut: number;
  pending: number;
  totalMs: number;
  cutMs: number;
}

export function fillerTotals(groups: FillerGroup[]): FillerTotals {
  return groups.reduce<FillerTotals>(
    (a, g) => ({
      words: a.words + 1,
      count: a.count + g.count,
      cut: a.cut + g.cut,
      pending: a.pending + g.pending,
      totalMs: a.totalMs + g.totalMs,
      cutMs: a.cutMs + g.cutMs,
    }),
    { words: 0, count: 0, cut: 0, pending: 0, totalMs: 0, cutMs: 0 },
  );
}
