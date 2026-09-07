// 逐單元增益規劃：把每段拉向目標響度（相對平衡），最終整體由 ffmpeg loudnorm 兩趟收尾。
//
// **平滑與階差限制不可以跨過換人的地方。** 它們存在的理由是「同一個聲音不該忽大忽小」
// —— 那是聽得出來的抽動。但兩個不同的人本來就是兩個不同的音源：來賓比主持人小 6 dB
// 是要一次補起來的，慢慢爬上去只會讓每一次換人之後的頭幾秒都還在錯的音量上，而在一來
// 一往的對話裡，那就是整集的大部分。3-tap 平滑更糟：它會把前一個人的增益直接混 25%
// 進來，等於拿別人的音量來校正這個人。
import type { LocalAnalysis } from "../peaks";
import { integratedLufs } from "./gating";
import type { Unit } from "./units";

export interface MeasuredUnit extends Unit {
  lufs: number | null;
  /** 樣本峰值（dBFS；由 5 ms 桶 min/max 近似）。 */
  peakDb: number;
}

export interface GainPlanOptions {
  targetLufs: number;
  maxGainDb: number;
  /** 峰值上限（dBFS）：增益後不得超過。 */
  peakCeilingDb: number;
  /** 相鄰單元最大階差。 */
  maxStepDb: number;
  /** 低於此視為靜音 / room tone，不動。 */
  silenceLufs: number;
}

export const DEFAULT_GAIN_OPTIONS: GainPlanOptions = { targetLufs: -16, maxGainDb: 12, peakCeilingDb: -2, maxStepDb: 3, silenceLufs: -45 };

export function measureUnits(units: Unit[], a: LocalAnalysis): MeasuredUnit[] {
  const windows = Array.from({ length: a.nWin }, (_, i) => ({ tMs: i * a.hopMs, momentary: a.win[i * 3], shortTerm: a.win[i * 3 + 1], rmsDb: a.win[i * 3 + 2] }));
  return units.map((u) => {
    const lo = Math.max(0, Math.floor((u.startMs / 1000) * a.pps));
    const hi = Math.min(a.nBuckets - 1, Math.floor((u.endMs / 1000) * a.pps));
    let peak = 0;
    for (let i = lo; i <= hi; i++) peak = Math.max(peak, Math.abs(a.maxs[i]), Math.abs(a.mins[i]));
    const peakDb = peak > 0 ? 20 * Math.log10(peak / 127) : -120;
    return { ...u, lufs: integratedLufs(windows, a.hopMs, u.startMs, u.endMs), peakDb };
  });
}

export interface UnitGain {
  unitId: number;
  gainDb: number;
}

/**
 * 這兩個單元之間是不是「同一個連續的聲音」。
 *
 * 沒有講者標籤時退回原本的判斷（同一個保留段）—— 那是這個函式一直以來的行為，
 * 單軌素材不該因為多了這個參數而變得不一樣。
 */
function sameVoice(units: MeasuredUnit[], i: number, j: number, speakerOf?: (unitId: number) => string | null): boolean {
  if (i < 0 || j < 0 || i >= units.length || j >= units.length) return false;
  if (units[i].keepId !== units[j].keepId) return false;
  if (!speakerOf) return true;
  const a = speakerOf(units[i].id);
  const b = speakerOf(units[j].id);
  // 判不出講者的單元（兩個人同時講、或沒被標到）當成延續 —— 在不確定的地方
  // 寧可保守地平滑，也不要憑猜測製造一個音量跳點
  if (a == null || b == null) return true;
  return a === b;
}

/**
 * 目標 − 量測 → clamp → 峰值守門 → **同一個聲音之內** 3-tap 平滑 → 階差限制。
 *
 * `speakerOf` 給了就會在換人的地方讓平滑與階差限制斷開（見檔頭）。
 */
export function planGains(
  units: MeasuredUnit[],
  opts: GainPlanOptions = DEFAULT_GAIN_OPTIONS,
  speakerOf?: (unitId: number) => string | null,
): UnitGain[] {
  const raw = units.map((u) => {
    if (u.lufs == null || u.lufs < opts.silenceLufs) return 0;
    let g = Math.max(-opts.maxGainDb, Math.min(opts.maxGainDb, opts.targetLufs - u.lufs));
    g = Math.min(g, opts.peakCeilingDb - u.peakDb);
    return g;
  });
  // 平滑：同一個聲音之內的鄰居 [0.25, 0.5, 0.25]
  const smoothed = raw.map((g, i) => {
    const prev = sameVoice(units, i - 1, i, speakerOf) ? raw[i - 1] : g;
    const next = sameVoice(units, i + 1, i, speakerOf) ? raw[i + 1] : g;
    return 0.25 * prev + 0.5 * g + 0.25 * next;
  });
  // 階差限制
  const out: UnitGain[] = [];
  let last = 0;
  for (let i = 0; i < smoothed.length; i++) {
    let g = smoothed[i];
    // 換人的地方不限階差：那是換音源，一次補到位才對
    if (i > 0 && sameVoice(units, i - 1, i, speakerOf)) g = last + Math.max(-opts.maxStepDb, Math.min(opts.maxStepDb, g - last));
    g = Math.min(g, opts.peakCeilingDb - units[i].peakDb); // 平滑後仍不可破峰
    out.push({ unitId: units[i].id, gainDb: Math.round(g * 100) / 100 });
    last = g;
  }
  return out;
}
