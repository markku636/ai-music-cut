// 呼吸感：剪完之後兩段語音之間該留多少空白。
//
// 使用者說「適當的保留空白斷點，讓 podcast 有呼吸感」。舊版是「全有或全無地還 150 ms」：
// 剪除區尾端剛好有 150 ms 靜音就整個還回去，差一點就一點都不還、改成插 room tone。
// 而且句中與句尾同一個數字 —— 但句子中間本來就不該有 0.4 秒的空白，
// 段落之間又不能只有 0.15 秒，兩種情況擠在同一個常數裡怎麼調都不對。
//
// 這裡改成：① 依「句中 / 句尾 / 段落」給不同的目標長度 ② 能還多少還多少（不是全有全無）
// ③ 目標長度隨激進度縮放（激進 = 節奏緊，保守 = 留白多）。
import type { Sentence, VadRegion, Word } from "../types";

/** 剪除區落在什麼位置。 */
export type BreathContext = "within" | "sentence" | "paragraph";

/** 句尾標點（判段落用）。Whisper 會把標點黏在字尾。 */
export const SENTENCE_END_RE = /[。．.!！?？…]+$/;

export interface BreathOptions {
  /** 句子中間：講者不換氣，留白要短。 */
  withinMs: number;
  /** 句尾：換一口氣。 */
  sentenceMs: number;
  /** 段落之間：明顯的停頓。 */
  paragraphMs: number;
  /** 找不到足夠靜音時可以插 room tone 補齊（純音訊可；影片不行）。 */
  allowGapInsert: boolean;
  /** 允許把停頓「加長」到目標（舊版只能縮短）。 */
  allowExtend: boolean;
  /**
   * 差多少以內就不插 room tone。
   * 少了 20 ms 卻硬塞一段合成雜訊，比直接交叉淡接還糟 —— room tone 是最後手段，
   * 不是「湊到剛好」的工具。
   */
  minGapMs: number;
  /**
   * 只在句尾 / 段落交界插 room tone。
   * 句子中間剪掉一個「這個」之後再塞 170 ms 合成靜音，等於把剛拿掉的猶豫又放回去 ——
   * 「呼吸感」要的是**斷點**的留白，不是句子內部的空隙。
   */
  gapAtBoundariesOnly: boolean;
}

export const DEFAULT_BREATH_OPTIONS: BreathOptions = {
  withinMs: 170,
  sentenceMs: 340,
  paragraphMs: 575,
  allowGapInsert: true,
  allowExtend: false,
  minGapMs: 60,
  gapAtBoundariesOnly: true,
};

/** 激進度 0–100 → 呼吸目標長度（越積極越緊湊）。 */
export function breathFor(aggressiveness: number, base: BreathOptions = DEFAULT_BREATH_OPTIONS): BreathOptions {
  const a = Math.max(0, Math.min(100, aggressiveness)) / 100;
  const lerp = (lo: number, hi: number) => lo + (hi - lo) * a;
  return {
    ...base,
    withinMs: lerp(220, 120),
    sentenceMs: lerp(420, 260),
    paragraphMs: lerp(700, 450),
  };
}

/**
 * 剪除區 [startMs,endMs] 接起來的是什麼樣的兩句。
 * 判斷依據是「剪除區裡面（或緊鄰）有沒有句子結束」，以及那句是不是以句號結尾。
 */
export function breathContextAt(sentences: Sentence[], words: Word[], startMs: number, endMs: number, tolMs = 120): BreathContext {
  let ctx: BreathContext = "within";
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i];
    if (s.endMs < startMs - tolMs) continue;
    if (s.endMs > endMs + tolMs) break;
    // 這一句在剪除區裡結束 → 至少是句尾
    ctx = "sentence";
    const lastId = s.wordIds[s.wordIds.length - 1];
    const text = words[lastId]?.text ?? "";
    // 有句號 / 問號 / 驚嘆號，而且後面還有下一句 → 視為段落交界
    if (SENTENCE_END_RE.test(text.trim()) && sentences[i + 1]) return "paragraph";
  }
  return ctx;
}

/** VAD 之外（＝靜音）在 [a,b] 內佔多少比例。 */
export function silenceFractionOf(vad: VadRegion[], a: number, b: number): number {
  const len = b - a;
  if (len <= 0) return 1;
  let speech = 0;
  for (const r of vad) {
    const s = Math.max(a, r.startMs);
    const e = Math.min(b, r.endMs);
    if (e > s) speech += e - s;
  }
  return 1 - speech / len;
}

export interface BreathPlan {
  /** 調整後的剪除區。 */
  startMs: number;
  endMs: number;
  /** 實際還回去多少毫秒的原音。 */
  restoredMs: number;
  /** 還不夠、需要插多少 room tone（0 = 不用）。 */
  gapMs: number;
  context: BreathContext;
}

/** 在 [a,b] 內從 `from` 往 `dir` 方向找最長的連續靜音（回傳長度，最多 wantMs）。 */
function silentRun(vad: VadRegion[], from: number, wantMs: number, dir: 1 | -1, limitMs: number, stepMs = 10): number {
  const max = Math.min(wantMs, Math.max(0, limitMs));
  let ok = 0;
  for (let d = stepMs; d <= max; d += stepMs) {
    const a = dir > 0 ? from : from - d;
    const b = dir > 0 ? from + d : from;
    if (silenceFractionOf(vad, a, b) < 0.8) break;
    ok = d;
  }
  return ok;
}

/**
 * 決定這一刀要還多少呼吸。
 *
 * 順序刻意是「先還尾端」：尾端靠近下一段語音，還回去聽起來像講者在開口前換氣；
 * 還頭端則像前一句拖尾巴，比較不自然。兩邊都不夠才用 room tone 補。
 */
export function planBreath(
  vad: VadRegion[],
  sentences: Sentence[],
  words: Word[],
  removal: { startMs: number; endMs: number; speech: boolean },
  opts: BreathOptions,
): BreathPlan {
  const context = breathContextAt(sentences, words, removal.startMs, removal.endMs);
  if (!removal.speech) {
    // 剪的是純靜音 / 雜音，本來就沒有「接起來會不會太趕」的問題
    return { startMs: removal.startMs, endMs: removal.endMs, restoredMs: 0, gapMs: 0, context };
  }
  const want = context === "paragraph" ? opts.paragraphMs : context === "sentence" ? opts.sentenceMs : opts.withinMs;
  const span = removal.endMs - removal.startMs;
  if (span <= 0) return { startMs: removal.startMs, endMs: removal.endMs, restoredMs: 0, gapMs: 0, context };

  // 先還尾端（像換氣），再還頭端
  const tail = silentRun(vad, removal.endMs, want, -1, span);
  let end = removal.endMs - tail;
  let restored = tail;
  if (restored < want) {
    const head = silentRun(vad, removal.startMs, want - restored, 1, end - removal.startMs);
    if (head > 0) restored += head;
    const short = Math.max(0, want - restored);
    // 差得不多就算了，交給 crossfade —— 塞一小段 room tone 反而更假；
    // 句子中間也一律不插（見 gapAtBoundariesOnly）。
    const mayGap = opts.allowGapInsert && (!opts.gapAtBoundariesOnly || context !== "within");
    return {
      startMs: removal.startMs + head,
      endMs: end,
      restoredMs: restored,
      gapMs: mayGap && short >= opts.minGapMs ? short : 0,
      context,
    };
  }
  // 還得比想要的多（silentRun 以 step 為單位，可能超出一點）→ 夾回去
  if (restored > want) {
    end = removal.endMs - want;
    restored = want;
  }
  return { startMs: removal.startMs, endMs: end, restoredMs: restored, gapMs: 0, context };
}
