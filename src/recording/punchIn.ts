// 「重錄這句」的純決策：修掉 take 頭尾的靜音、判斷長度合不合、產生 mute + overlay 的一筆修改。
//
// 為什麼用 overlay + mute 而不是改 EDL：非破壞（原句還在、隨時還原）、一筆 undo、不動成品時鐘。
import type { AudioEffect } from "../analysis/effects";
import { effectId } from "../analysis/effects";
import { mapSrcToOut } from "../analysis/edl/map";
import type { KeepSegment } from "../analysis/edl/build";
import { overlayId, type Overlay } from "../analysis/overlays";
import { rmsU8ToDb, type LocalAnalysis } from "../analysis/peaks";

export interface TakeTrim {
  startMs: number;
  endMs: number;
}

/** take 裡「有聲音」的範圍：第一個與最後一個超過門檻的桶，各留 pad。 */
export function trimTake(a: LocalAnalysis, quietDb = -45, padMs = 80): TakeTrim {
  let first = -1;
  let last = -1;
  for (let i = 0; i < a.nBuckets; i++) {
    if (rmsU8ToDb(a.rmsU8[i]) > quietDb) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return { startMs: 0, endMs: a.durationMs };
  const ms = (b: number) => (b * 1000) / a.pps;
  return { startMs: Math.max(0, ms(first) - padMs), endMs: Math.min(a.durationMs, ms(last + 1) + padMs) };
}

export type FitDecision = "align" | "too_long" | "too_short";

/** take 相對原句槽的長度比：0.7–1.3 對齊；> 1.3 太長（不拉伸，讓使用者選）；< 0.7 太短（原速放、補白）。 */
export function fitDecision(takeMs: number, slotMs: number): FitDecision {
  if (slotMs <= 0 || takeMs <= 0) return "too_short";
  const r = takeMs / slotMs;
  if (r > 1.3) return "too_long";
  if (r < 0.7) return "too_short";
  return "align";
}

export interface RedubPlan {
  effect: AudioEffect;
  overlay: Overlay;
}

export interface RedubInput {
  /** 原句（來源時間）。 */
  slot: { startMs: number; endMs: number };
  /** 對齊後的 take（時間軸已經等於原檔）或原速的 take。 */
  takeMediaId: string;
  /** take 裡要用的範圍（對齊後 = slot；原速 = trim 後的範圍）。 */
  takeRange: { startMs: number; endMs: number };
  keeps: readonly KeepSegment[];
  /** 音量對齊：原句 − take（LUFS 差），夾 ±12。 */
  gainDb?: number;
}

/** mute 原句 + 把 take 疊在成品對應的位置（錨在來源時間，之後剪掉前面的字也跟得住）。 */
export function planRedub(input: RedubInput): RedubPlan {
  const { slot } = input;
  const effect: AudioEffect = { id: effectId("mute", slot.startMs, slot.endMs), kind: "mute", startMs: slot.startMs, endMs: slot.endMs, origin: "suggest" };
  const outStartMs = mapSrcToOut(input.keeps as KeepSegment[], slot.startMs);
  const overlay: Overlay = {
    id: overlayId("sfx", outStartMs),
    lane: "sfx",
    mediaId: input.takeMediaId,
    srcInMs: input.takeRange.startMs,
    srcOutMs: input.takeRange.endMs,
    outStartMs,
    gainDb: Math.max(-12, Math.min(12, Math.round((input.gainDb ?? 0) * 10) / 10)),
    fadeInMs: 10,
    fadeOutMs: 10,
    role: "redub",
  };
  return { effect, overlay };
}

/** 靜音自動停：語音之後安靜 ≥ silenceMs 就停；硬停 = 2 × 槽長 + 3 s。 */
export function autoStopMs(slotMs: number): { hardStopMs: number; silenceMs: number } {
  return { hardStopMs: Math.max(5000, 2 * slotMs + 3000), silenceMs: 1500 };
}
