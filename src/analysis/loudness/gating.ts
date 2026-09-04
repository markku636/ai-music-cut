// BS.1770 閘門積分響度：由 100 ms momentary 視窗（400 ms 積分）近似。絕對閘 −70 LUFS、相對閘 −10 LU。
import type { LoudnessWindow } from "../types";

export const ABS_GATE = -70;
export const REL_GATE_LU = 10;

function pow(lufs: number): number {
  return Math.pow(10, lufs / 10);
}

/** 由一組 momentary 值算閘門後的積分響度；沒有超過絕對閘的視窗回 null。 */
export function integratedFromBlocks(blocks: number[]): number | null {
  const abs = blocks.filter((v) => Number.isFinite(v) && v > ABS_GATE);
  if (!abs.length) return null;
  const mean = abs.reduce((s, v) => s + pow(v), 0) / abs.length;
  const rel = 10 * Math.log10(mean) - REL_GATE_LU;
  const gated = abs.filter((v) => v > rel);
  if (!gated.length) return null;
  const m2 = gated.reduce((s, v) => s + pow(v), 0) / gated.length;
  return 10 * Math.log10(m2);
}

/** [fromMs,toMs] 的積分響度（LUFS）；資料不足回 null。 */
export function integratedLufs(windows: LoudnessWindow[], hopMs: number, fromMs: number, toMs: number): number | null {
  if (!windows.length || toMs <= fromMs) return null;
  const a = Math.max(0, Math.floor(fromMs / hopMs));
  const b = Math.min(windows.length - 1, Math.floor((toMs - 1) / hopMs));
  const blocks: number[] = [];
  for (let i = a; i <= b; i++) blocks.push(windows[i].momentary);
  return integratedFromBlocks(blocks);
}
