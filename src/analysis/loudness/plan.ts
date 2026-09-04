// 逐單元增益規劃：把每段拉向目標響度（相對平衡），最終整體由 ffmpeg loudnorm 兩趟收尾。
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

/** 目標 − 量測 → clamp → 峰值守門 → 同保留段內 3-tap 平滑 → 階差限制。 */
export function planGains(units: MeasuredUnit[], opts: GainPlanOptions = DEFAULT_GAIN_OPTIONS): UnitGain[] {
  const raw = units.map((u) => {
    if (u.lufs == null || u.lufs < opts.silenceLufs) return 0;
    let g = Math.max(-opts.maxGainDb, Math.min(opts.maxGainDb, opts.targetLufs - u.lufs));
    g = Math.min(g, opts.peakCeilingDb - u.peakDb);
    return g;
  });
  // 平滑：同 keep 內的鄰居 [0.25, 0.5, 0.25]
  const smoothed = raw.map((g, i) => {
    const prev = i > 0 && units[i - 1].keepId === units[i].keepId ? raw[i - 1] : g;
    const next = i + 1 < raw.length && units[i + 1].keepId === units[i].keepId ? raw[i + 1] : g;
    return 0.25 * prev + 0.5 * g + 0.25 * next;
  });
  // 階差限制
  const out: UnitGain[] = [];
  let last = 0;
  for (let i = 0; i < smoothed.length; i++) {
    let g = smoothed[i];
    if (i > 0) g = last + Math.max(-opts.maxStepDb, Math.min(opts.maxStepDb, g - last));
    g = Math.min(g, opts.peakCeilingDb - units[i].peakDb); // 平滑後仍不可破峰
    out.push({ unitId: units[i].id, gainDb: Math.round(g * 100) / 100 });
    last = g;
  }
  return out;
}
