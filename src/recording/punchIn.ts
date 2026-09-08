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

/**
 * take 裡「有聲音」的範圍：第一個與最後一個超過門檻的桶，各留 pad。
 * `quietDb` 沒給就用固定 −45 dBFS；RecordDialog 會把 gate.ts 量出來的門檻（依這支麥自己的底噪）傳進來。
 */
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
    // 錨在原句的來源時間：之後剪掉前面的字，原句移到哪 take 就跟到哪（outStartMs 只是快取）
    anchorSrcMs: slot.startMs,
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

// ---- 「有人在講話」的門檻：從這支麥自己的底噪量，不寫死 −40 ----
//
// 寫死一個 dB 值的問題跟 gate.ts 一樣：吵的麥（底噪 −38）每一包都算講話、永遠停不下來；
// 太小聲的麥（人聲峰值 −42）永遠沒「講過話」、只能等硬停。
// 做法：把每包的峰值（dBFS）留成一份排好序的小樣本，第 20 百分位當底噪
// （最安靜的兩成 = 倒數完還沒開口的那 300 ms 加上句間空檔），底噪 + 12 dB 當講話門檻。

/** 樣本不夠時先用的固定門檻（dBFS）。 */
export const FALLBACK_SPEECH_DB = -40;
/** 至少累積幾包才相信量到的底噪（4096 frame ≈ 85 ms 一包 → 12 包 ≈ 1 s）。 */
export const MIN_GATE_SAMPLES = 12;

export interface SpeechGate {
  /** 量到的底噪（第 20 百分位）；沒量到 = −120。 */
  floorDb: number;
  /** 超過這個峰值才算「有人在講話」。 */
  speechDb: number;
  measured: boolean;
}

/** 把一包峰值放進已排序（遞增）的樣本裡：就地二分插入，樣本一直保持有序。 */
export function pushSortedSample(sorted: number[], v: number): void {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  sorted.splice(lo, 0, v);
}

/** 已排序樣本的百分位（0–1，最近鄰）。空陣列 → −120。 */
export function percentileSorted(sorted: readonly number[], p: number): number {
  if (!sorted.length) return -120;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i];
}

/**
 * 從逐包峰值（已排序）估講話門檻：底噪 = 第 20 百分位，門檻 = 底噪 + 12 dB。
 * 樣本不到 minSamples → 退回固定 −40。門檻夾在 −55 … −20：
 * 極安靜的麥不要把呼吸聲當講話（停不下來），爛到底噪 −20 的麥也不要求人聲要貼到 0 dBFS。
 */
export function speechGateDb(sorted: readonly number[], minSamples = MIN_GATE_SAMPLES): SpeechGate {
  if (sorted.length < minSamples) return { floorDb: -120, speechDb: FALLBACK_SPEECH_DB, measured: false };
  const floorDb = percentileSorted(sorted, 0.2);
  return { floorDb, speechDb: Math.max(-55, Math.min(-20, floorDb + 12)), measured: true };
}
