// 把候選分組，讓人可以「就是 ×47 一次決定」而不是按 47 次。
//
// 這是審核速度的關鍵：贅字候選高度重複，同一個「就是」在 30 分鐘節目裡出現幾十次，
// 逐筆審完全是浪費。分組之後只要判斷「這個詞在這個節目裡該不該剪」，
// 剩下的靠抽聽 3 筆確認沒有例外。
import type { Candidate, DecisionMap, Word } from "../analysis/types";
import { isActiveState } from "../analysis/types";

// id → 字的索引，**依 words 陣列快取**。
//
// 原本每次呼叫 candidateText / normForGroup 都現建一份 Map。單看一次是 O(字數)，
// 但 buildGroups 會對**每一筆候選**呼叫一次 —— 57 分鐘的節目是 4560 筆候選 × 11400 個字
// ＝ 五千兩百萬次插入，實測佔掉「接受一筆候選」那 3.8 秒裡的 73%。
//
// 只快取結構（哪個 id 對到哪個物件）。Map 裡存的是字的**參照**，所以修正辨識文字這種
// 就地改欄位的操作照樣讀得到新值；會讓索引失效的只有增刪字，用長度擋掉。
const indexCache = new WeakMap<Word[], { len: number; byId: Map<number, Word> }>();

function wordIndex(words: Word[]): Map<number, Word> {
  const hit = indexCache.get(words);
  if (hit && hit.len === words.length) return hit.byId;
  const byId = new Map(words.map((w) => [w.id, w]));
  indexCache.set(words, { len: words.length, byId });
  return byId;
}

/** 候選實際涵蓋的原文（拿來顯示與分組）。沒有字（長停頓 / 雜音）就回空字串。 */
export function candidateText(c: Candidate, words: Word[]): string {
  if (!c.wordIds.length) return "";
  const byId = wordIndex(words);
  return c.wordIds
    .map((id) => byId.get(id)?.text ?? "")
    .join("")
    .trim();
}

/** 分組用的正規化字串：去掉標點與空白、統一大小寫，讓「就是，」與「就是」同一組。 */
export function normForGroup(c: Candidate, words: Word[]): string {
  if (!c.wordIds.length) return "";
  const byId = wordIndex(words);
  return c.wordIds
    .map((id) => byId.get(id)?.norm ?? "")
    .join("")
    .trim();
}

/** 長停頓 / 雜音沒有文字，改用時長分桶（0.5 秒一階）當組別。 */
function durationBucket(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const lo = Math.floor(s * 2) / 2;
  return `${lo.toFixed(1)}–${(lo + 0.5).toFixed(1)}s`;
}

/**
 * 組別鍵。有文字的用「類型|正規化文字」，沒文字的用「類型|時長桶」。
 * 加上類型是刻意的：同樣是「就是」，被判成 filler 與被判成 stutter 該分開看。
 */
export function groupKeyOf(c: Candidate, words: Word[]): string {
  const n = normForGroup(c, words);
  return n ? `${c.kind}|${n}` : `${c.kind}|~${durationBucket(c.endMs - c.startMs)}`;
}

export interface CandidateGroup {
  key: string;
  kind: Candidate["kind"];
  /** 顯示用標籤：文字組就是那個詞，時長組是「1.5–2.0s」。 */
  label: string;
  members: Candidate[];
  /** 各狀態筆數。 */
  pending: number;
  active: number;
  rejected: number;
  totalMs: number;
  /** 組內平均分數（排序用）。 */
  avgScore: number;
}

/** 依組別鍵分組；組內保持時間順序，組間依「未決筆數 → 總筆數」排序（先處理最省時間的）。 */
export function buildGroups(candidates: Candidate[], words: Word[], decisions: DecisionMap): CandidateGroup[] {
  const map = new Map<string, CandidateGroup>();
  for (const c of candidates) {
    const key = groupKeyOf(c, words);
    let g = map.get(key);
    if (!g) {
      const text = candidateText(c, words);
      g = {
        key,
        kind: c.kind,
        label: text || durationBucket(c.endMs - c.startMs),
        members: [],
        pending: 0,
        active: 0,
        rejected: 0,
        totalMs: 0,
        avgScore: 0,
      };
      map.set(key, g);
    }
    g.members.push(c);
    g.totalMs += c.endMs - c.startMs;
    g.avgScore += c.score;
    const st = decisions[c.id]?.state ?? "pending";
    if (st === "pending") g.pending += 1;
    else if (st === "rejected") g.rejected += 1;
    else if (isActiveState(st)) g.active += 1;
  }
  const out = [...map.values()];
  for (const g of out) g.avgScore = g.members.length ? g.avgScore / g.members.length : 0;
  out.sort((a, b) => b.pending - a.pending || b.members.length - a.members.length || a.label.localeCompare(b.label));
  return out;
}

/**
 * 整組決定之前該抽聽哪幾筆。取首 / 中 / 尾，穩定不隨機 ——
 * 隨機抽樣會讓「再聽一次」跑出不同的東西，沒辦法確認自己剛剛聽到什麼。
 * 只從未決的挑；全部都決定過了就從全體挑。
 */
export function sampleForAudition(g: CandidateGroup, decisions: DecisionMap, n = 3): Candidate[] {
  const pool = g.members.filter((c) => (decisions[c.id]?.state ?? "pending") === "pending");
  const src = pool.length ? pool : g.members;
  if (src.length <= n) return src.slice();
  const out: Candidate[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.round((i * (src.length - 1)) / (n - 1));
    if (!out.includes(src[idx])) out.push(src[idx]);
  }
  return out;
}
