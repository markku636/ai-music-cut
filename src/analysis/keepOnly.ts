// 「只保留符合的」—— 逐字稿搜尋的反向操作。
//
// 搜尋現在只能「把命中的全部剪掉」（拿掉整集的口頭禪）。但做精華版 / 主題摘要時
// 要的是相反的：找出所有提到某個主題的地方，其他全部拿掉。Descript 的常用招數。
//
// **關鍵：保留的是「含有命中的整個句子」，不是命中的那幾個字。**
// 只留命中的字會剪出一串沒頭沒尾的碎片，放出來根本聽不懂 ——
// 那不是精華版，那是雜訊。所以命中先擴張到它所在的句子再算補集。
//
// 這一支只算「該剪掉哪些區間」；怎麼套用是 store 的事（走既有的 addManualCuts，
// 所以一次 undo 就能全部還原）。

import type { Sentence, Transcript } from "./types";

export interface KeepOnlyOptions {
  /**
   * 兩段保留之間短於這個值就併起來（連同中間那一小段一起留著）。
   * 不併的話會在兩句之間留下一個 300 ms 的洞，聽起來像跳針。
   */
  mergeGapMs?: number;
  /** 每段保留的前後各留一點，句子的頭尾才不會被切掉氣音。 */
  padMs?: number;
}

export const DEFAULT_KEEP_ONLY: Required<KeepOnlyOptions> = { mergeGapMs: 700, padMs: 120 };

export interface Span {
  startMs: number;
  endMs: number;
}

/** 命中的句子 id → 要保留的區間（已合併、已加邊距、已排序）。 */
export function keepSpans(sentences: Sentence[], sentenceIds: Iterable<number>, durationMs: number, opts: KeepOnlyOptions = {}): Span[] {
  const { mergeGapMs, padMs } = { ...DEFAULT_KEEP_ONLY, ...opts };
  const wanted = new Set(sentenceIds);
  const raw = sentences
    .filter((s) => wanted.has(s.id))
    .map((s) => ({
      startMs: Math.max(0, s.startMs - padMs),
      endMs: Math.min(durationMs, s.endMs + padMs),
    }))
    .sort((a, b) => a.startMs - b.startMs);

  const out: Span[] = [];
  for (const s of raw) {
    const last = out[out.length - 1];
    if (last && s.startMs - last.endMs <= mergeGapMs) last.endMs = Math.max(last.endMs, s.endMs);
    else out.push({ ...s });
  }
  return out;
}

/** 保留區間的補集＝要剪掉的區間。 */
export function complement(keeps: Span[], durationMs: number): Span[] {
  if (durationMs <= 0) return [];
  const out: Span[] = [];
  let cursor = 0;
  for (const k of keeps) {
    if (k.startMs > cursor) out.push({ startMs: cursor, endMs: Math.min(k.startMs, durationMs) });
    cursor = Math.max(cursor, k.endMs);
  }
  if (cursor < durationMs) out.push({ startMs: cursor, endMs: durationMs });
  return out.filter((s) => s.endMs > s.startMs);
}

export interface KeepOnlyPlan {
  /** 會保留的區間。 */
  keeps: Span[];
  /** 要標成剪除的區間。 */
  cuts: Span[];
  /** 保留的總長。 */
  keptMs: number;
  /** 命中幾個句子。 */
  sentences: number;
  /** 沒有東西要剪（命中涵蓋整集）。 */
  noop: boolean;
}

/**
 * 從搜尋命中算出「只保留符合的」計畫。
 *
 * `hits` 只需要 sentenceId —— 保留的粒度是句子，不是字。
 */
export function planKeepOnly(
  transcript: Transcript | null,
  hits: { sentenceId: number }[],
  durationMs: number,
  opts: KeepOnlyOptions = {},
): KeepOnlyPlan {
  const empty: KeepOnlyPlan = { keeps: [], cuts: [], keptMs: 0, sentences: 0, noop: true };
  if (!transcript || hits.length === 0 || durationMs <= 0) return empty;
  const ids = new Set(hits.map((h) => h.sentenceId).filter((id) => id >= 0));
  if (ids.size === 0) return empty;

  const keeps = keepSpans(transcript.sentences, ids, durationMs, opts);
  const cuts = complement(keeps, durationMs);
  const keptMs = keeps.reduce((n, s) => n + (s.endMs - s.startMs), 0);
  return { keeps, cuts, keptMs, sentences: ids.size, noop: cuts.length === 0 };
}

/** 每一段要剪掉的區間對應到哪些字（addManualCuts 需要）。 */
export function wordIdsIn(transcript: Transcript, span: Span): number[] {
  const out: number[] = [];
  for (const w of transcript.words) {
    if (w.endMs <= span.startMs) continue;
    if (w.startMs >= span.endMs) break;
    out.push(w.id);
  }
  return out;
}
