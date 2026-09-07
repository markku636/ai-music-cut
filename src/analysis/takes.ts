// 替代 take（Final Cut 的 Audition，⌘Y）。
//
// 一個人錄旁白或 podcast，講壞了最常見的反應**不是**說「等一下重講」——
// 那個 redo.ts 已經處理了。最常見的是：停半秒，然後**把同一句再講一次**，
// 什麼都沒說。錄完一集下來，同一句話有兩三個版本散在裡面。
//
// 剪的時候要做的事很機械：找到那幾次嘗試、聽一遍、留一個、其餘剪掉。
// Final Cut 把這件事叫 Audition —— 把幾個版本疊在同一個位置，按鍵循環試聽，挑一個。
// 這裡是同一個概念，只是在單軌錄音裡「疊」的方式是**時間上相鄰的幾句**。
//
// **只找、只建議，不自己剪。** 跟 redo 一樣：剪錯一句是內容不見了，
// 少剪一句只是留了個瑕疵，代價完全不對稱。

import type { Sentence, Word } from "./types";

export interface Take {
  /** 在這一組裡是第幾次嘗試（0 起算）。 */
  index: number;
  sentenceId: number;
  startMs: number;
  endMs: number;
  /** 原文（顯示用）。 */
  text: string;
}

export interface TakeGroup {
  id: string;
  attempts: Take[];
  /**
   * 預設要留哪一次。**最後一次** —— 會再講一遍就是因為前面那次不滿意。
   * 這只是預設值，不是判斷；使用者聽過再決定。
   */
  defaultKeep: number;
}

export interface TakeOptions {
  /** 兩次嘗試之間最多隔多久（毫秒）。隔太久多半是真的又提到同一件事。 */
  maxGapMs: number;
  /** 往後最多比幾句。重錄通常就在下一兩句，比太遠只會撈到不相干的重複。 */
  maxLookahead: number;
  /** 正規化後至少要這麼長才算數。「對」「好」「是啊」重複出現是講話的常態，不是重錄。 */
  minChars: number;
  /** 相似度門檻（0–1）。 */
  minSimilarity: number;
}

export const DEFAULT_TAKES: TakeOptions = {
  maxGapMs: 20_000,
  maxLookahead: 3,
  minChars: 6,
  minSimilarity: 0.7,
};

/** 編輯距離（兩列滾動，句子很短所以夠用）。 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/**
 * 相似度 0–1。用**字元**而不是詞：中文沒有空白分詞，而重錄常常只差一兩個字
 * （「這個功能很好用」→「這個功能非常好用」），詞層級會把它們判成兩句不同的話。
 */
export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  return 1 - editDistance(a, b) / max;
}

/** 這一句正規化後的字（沒有標點與空白）。 */
function normOf(s: Sentence, words: readonly Word[]): string {
  return s.wordIds.map((id) => words[id]?.norm ?? "").join("");
}

/**
 * 找出「同一句話講了好幾次」的地方。
 *
 * 只比**時間上相鄰**的幾句：同一個詞在整集裡重複出現是正常的（那是主題），
 * 只有連在一起的重複才是重錄。
 */
export function findTakes(
  sentences: readonly Sentence[],
  words: readonly Word[],
  opts: TakeOptions = DEFAULT_TAKES,
): TakeGroup[] {
  const norms = sentences.map((s) => normOf(s, words));
  const texts = sentences.map((s) => s.wordIds.map((id) => words[id]?.text ?? "").join(""));
  // 用「這一句屬於哪一組」串起連鎖：A~B、B~C 就是同一組三次嘗試
  const groupOf = new Array<number>(sentences.length).fill(-1);
  let nextGroup = 0;

  for (let i = 0; i < sentences.length; i++) {
    const a = norms[i];
    if ([...a].length < opts.minChars) continue;
    for (let k = 1; k <= opts.maxLookahead && i + k < sentences.length; k++) {
      const j = i + k;
      const b = norms[j];
      if ([...b].length < opts.minChars) continue;
      if (sentences[j].startMs - sentences[i].endMs > opts.maxGapMs) break;
      if (similarity(a, b) < opts.minSimilarity) continue;
      if (groupOf[i] < 0 && groupOf[j] < 0) {
        groupOf[i] = groupOf[j] = nextGroup++;
      } else if (groupOf[i] < 0) {
        groupOf[i] = groupOf[j];
      } else if (groupOf[j] < 0) {
        groupOf[j] = groupOf[i];
      } else if (groupOf[i] !== groupOf[j]) {
        // 兩條鎖鏈接起來：把後面那組併進前面那組
        const from = groupOf[j];
        const to = groupOf[i];
        for (let x = 0; x < groupOf.length; x++) if (groupOf[x] === from) groupOf[x] = to;
      }
      break; // 一句只跟**最近的**那次配對，避免一句同時被拉進兩組
    }
  }

  const byGroup = new Map<number, number[]>();
  for (let i = 0; i < groupOf.length; i++) {
    if (groupOf[i] < 0) continue;
    const list = byGroup.get(groupOf[i]) ?? [];
    list.push(i);
    byGroup.set(groupOf[i], list);
  }

  const out: TakeGroup[] = [];
  for (const idxs of byGroup.values()) {
    if (idxs.length < 2) continue;
    idxs.sort((x, y) => x - y);
    const attempts: Take[] = idxs.map((si, n) => ({
      index: n,
      sentenceId: sentences[si].id,
      startMs: sentences[si].startMs,
      endMs: sentences[si].endMs,
      text: texts[si],
    }));
    out.push({
      id: `take:${attempts[0].startMs}-${attempts[attempts.length - 1].endMs}`,
      attempts,
      defaultKeep: attempts.length - 1,
    });
  }
  return out.sort((a, b) => a.attempts[0].startMs - b.attempts[0].startMs);
}

/**
 * 留下第 keepIndex 次嘗試的話，要剪掉哪些區間。
 *
 * keepIndex 超出範圍時回**空陣列**而不是把整組剪光 —— 那是最糟的失敗模式。
 */
export function cutsForKeeping(group: TakeGroup, keepIndex: number): { startMs: number; endMs: number }[] {
  if (!Number.isInteger(keepIndex) || keepIndex < 0 || keepIndex >= group.attempts.length) return [];
  return group.attempts.filter((a) => a.index !== keepIndex).map((a) => ({ startMs: a.startMs, endMs: a.endMs }));
}

/** 這一組全部剪掉之後可以省多少毫秒（留一個、剪其餘）。 */
export function savedMsOf(group: TakeGroup, keepIndex: number): number {
  return cutsForKeeping(group, keepIndex).reduce((n, r) => n + (r.endMs - r.startMs), 0);
}
