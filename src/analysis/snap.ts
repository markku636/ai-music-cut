// 統一吸附：拖曳、切刀、修剪、逐字稿選取都吸到同一組目標。
//
// 為什麼要收成一支：吸附原本只吸拍點（剪音樂用），但剪 podcast 時真正想吸的是
// **句界**與**既有接縫** —— 剪在句子中間會破音，而兩刀對不齊會留下一個 3 ms 的碎片。
// 分散在各處各吸各的，同一個拖曳動作在波形上與在逐字稿上會停在不同位置。
//
// 拍點刻意不展開成陣列：拍網格是週期性的（offset + k × period），30 分鐘的曲子
// 展開就是四千多個點，每次拖曳都掃一遍純屬浪費。用 beats.ts 的公式直接算最近拍。
import { snapToBeat, type BeatGrid } from "./beats";

export type SnapKind = "beat" | "seam" | "marker" | "sentence" | "word" | "playhead" | "bound";

export interface SnapTarget {
  ms: number;
  kind: SnapKind;
}

export interface SnapEnabled {
  beats: boolean;
  seams: boolean;
  sentences: boolean;
  words: boolean;
}

/** 標記一律當吸附目標：那是人自己放的點，沒有理由吸不到。 */

export const ALL_SNAP: SnapEnabled = { beats: true, seams: true, sentences: true, words: true };

export interface SnapContext {
  enabled: boolean;
  /** 明確的點（接縫 / 句界 / 字界 / 播放線 / 頭尾）。 */
  targets: SnapTarget[];
  /** 拍網格（週期性，不展開）。 */
  grid: BeatGrid | null;
  tolMs: number;
}

/** 同距離時誰贏：接縫優先於句界，句界優先於字界 —— 越「結構性」的邊界越該吸。 */
const PRIORITY: Record<SnapKind, number> = { marker: 0, seam: 1, sentence: 2, playhead: 3, bound: 4, word: 5, beat: 6 };

export interface SnapResult {
  ms: number;
  kind: SnapKind | null;
}

/** 吸附一個時間值。沒吸到任何目標就原樣回傳（kind = null）。 */
export function snapValue(ms: number, ctx: SnapContext): SnapResult {
  if (!ctx.enabled || ctx.tolMs <= 0) return { ms, kind: null };
  let best: SnapTarget | null = null;
  let bestDist = Infinity;
  for (const t of ctx.targets) {
    const d = Math.abs(t.ms - ms);
    if (d > ctx.tolMs) continue;
    if (d < bestDist - 0.001 || (Math.abs(d - bestDist) <= 0.001 && best && PRIORITY[t.kind] < PRIORITY[best.kind])) {
      best = t;
      bestDist = d;
    }
  }
  if (ctx.grid) {
    const b = snapToBeat(ctx.grid, ms, ctx.tolMs);
    const d = Math.abs(b - ms);
    // snapToBeat 吸不到時原樣回傳，所以 d === 0 有兩種意思：正好在拍上、或根本沒吸到。
    // 兩種情況的結果都一樣（ms 不動），只有標示的 kind 有差，不值得為此再算一次。
    if (b !== ms && d <= ctx.tolMs && (d < bestDist - 0.001 || (Math.abs(d - bestDist) <= 0.001 && best && PRIORITY.beat < PRIORITY[best.kind]))) {
      best = { ms: b, kind: "beat" };
      bestDist = d;
    }
  }
  return best ? { ms: best.ms, kind: best.kind } : { ms, kind: null };
}

export interface SnapSources {
  /** EDL 接縫（來源時間，剪除區的頭尾與切點）。 */
  seams?: number[];
  /** 標記 / 章節（來源時間）。 */
  markers?: number[];
  sentences?: { startMs: number; endMs: number }[];
  words?: { startMs: number; endMs: number }[];
  playheadMs?: number | null;
  durationMs?: number;
}

/** 依開關收集明確目標。呼叫端只在來源變動時算一次，拖曳過程中重複使用。 */
export function collectTargets(src: SnapSources, on: SnapEnabled): SnapTarget[] {
  const out: SnapTarget[] = [];
  if (on.seams) for (const ms of src.seams ?? []) out.push({ ms, kind: "seam" });
  for (const ms of src.markers ?? []) out.push({ ms, kind: "marker" });
  if (on.sentences) {
    for (const s of src.sentences ?? []) {
      out.push({ ms: s.startMs, kind: "sentence" });
      out.push({ ms: s.endMs, kind: "sentence" });
    }
  }
  if (on.words) {
    for (const w of src.words ?? []) {
      out.push({ ms: w.startMs, kind: "word" });
      out.push({ ms: w.endMs, kind: "word" });
    }
  }
  if (src.playheadMs != null) out.push({ ms: src.playheadMs, kind: "playhead" });
  out.push({ ms: 0, kind: "bound" });
  if (src.durationMs) out.push({ ms: src.durationMs, kind: "bound" });
  return out;
}

/** 吸附容差：縮放越大吸得越準（畫面上永遠是同樣的幾個像素）。 */
export const SNAP_PX = 8;
export const MAX_SNAP_TOL_MS = 140;

export function toleranceMs(pxPerSec: number): number {
  if (!Number.isFinite(pxPerSec) || pxPerSec <= 0) return MAX_SNAP_TOL_MS;
  return Math.max(4, Math.min(MAX_SNAP_TOL_MS, (SNAP_PX / pxPerSec) * 1000));
}

export const SNAP_KIND_LABEL: Record<SnapKind, string> = {
  beat: "拍點",
  seam: "接縫",
  marker: "標記",
  sentence: "句界",
  word: "字界",
  playhead: "播放線",
  bound: "頭尾",
};
