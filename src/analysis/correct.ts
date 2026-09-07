// 修正辨識錯誤（Descript 的核心操作）。
//
// 辨識器把「Tauri」聽成「淘瑞」的時候，目前只能剪掉它或忍著。但那個字會一路
// 影響下去：逐字稿搜尋找不到、節目筆記照抄錯字、章節標題也錯 —— 而且都不會有人
// 告訴你哪裡錯了。
//
// **只改文字，不動時間軸。** 這一點很重要：字的起訖時間是辨識器對出來的，
// 改文字不代表那段聲音變了。所以剪輯決策、候選、EDL 全部不受影響 ——
// 修正逐字稿不會讓你的剪輯跑掉。
//
// 順帶一提，這跟領域詞是同一個問題的兩端：改對這一次是修正，加進領域詞是
// 讓下一次不用改。UI 上會把兩件事接起來。

import { normText } from "./normalize";
import type { Transcript, Word } from "./types";

export interface CorrectionResult {
  transcript: Transcript;
  /** 有沒有真的改到（一樣的文字不算）。 */
  changed: boolean;
  /** 改之前的文字，給 undo 標籤與「加進領域詞」用。 */
  before: string;
  /** 改了幾處。單一修正永遠是 0 或 1 —— 讓兩支函式回同一種形狀，呼叫端不用做特例。 */
  count: number;
}

/**
 * 改一個字的文字。
 *
 * 空字串**不接受** —— 想拿掉一個字請用剪的（那才會反映在聲音上）。
 * 讓逐字稿裡出現一個空白的字只會讓後面每一層都要處理這個特例。
 */
export function correctWord(t: Transcript, wordId: number, text: string): CorrectionResult {
  const idx = t.words.findIndex((w) => w.id === wordId);
  if (idx < 0) return { transcript: t, changed: false, before: "", count: 0 };
  const before = t.words[idx].text;
  const next = text.trim();
  if (!next || next === before.trim()) return { transcript: t, changed: false, before, count: 0 };

  const words: Word[] = t.words.slice();
  words[idx] = { ...words[idx], text: next, norm: normText(next) };

  // segment 的整句文字也要跟著 —— 節目筆記與匯出讀的是它，不是逐字重組
  const segments = t.segments.map((seg) =>
    seg.wordIds.includes(wordId) ? { ...seg, text: seg.wordIds.map((id) => words.find((w) => w.id === id)?.text ?? "").join("") } : seg,
  );

  return { transcript: { ...t, words, segments }, changed: true, before, count: 1 };
}

/**
 * 一次改掉整份逐字稿裡所有一樣的字（「淘瑞」出現 12 次，一個一個改是不合理的）。
 * 比對用 norm，所以帶不帶標點都會被換掉。
 */
export function correctAll(t: Transcript, wordId: number, text: string): CorrectionResult {
  const src = t.words.find((w) => w.id === wordId);
  if (!src) return { transcript: t, changed: false, before: "", count: 0 };
  const targetNorm = src.norm;
  const next = text.trim();
  if (!next || !targetNorm) return { transcript: t, changed: false, before: src.text, count: 0 };

  const nextNorm = normText(next);
  const ids = t.words.filter((w) => w.norm === targetNorm).map((w) => w.id);
  if (nextNorm === targetNorm) return { transcript: t, changed: false, before: src.text, count: 0 };

  let out = t;
  for (const id of ids) out = correctWord(out, id, next).transcript;
  return { transcript: out, changed: ids.length > 0, before: src.text, count: ids.length };
}

/** 這個字在整份逐字稿裡出現幾次（UI 用來顯示「全部改掉（12）」）。 */
export function occurrences(t: Transcript, wordId: number): number {
  const src = t.words.find((w) => w.id === wordId);
  if (!src || !src.norm) return 0;
  return t.words.reduce((n, w) => n + (w.norm === src.norm ? 1 : 0), 0);
}
