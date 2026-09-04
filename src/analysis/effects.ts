// 區段效果（Wave Editor 式）：靜音 / 增益 / 淡入 / 淡出。時間為來源時間軸（ms）。
// 純函式：輸出端（Rust 以同樣的包絡逐 frame 相乘）與預聽端（<audio>.volume）共用同一套定義。

export type EffectKind = "mute" | "gain" | "fade_in" | "fade_out";

export interface AudioEffect {
  id: string;
  kind: EffectKind;
  startMs: number;
  endMs: number;
  /** gain 專用（dB，可正可負）。 */
  db?: number;
}

/** 靜音 / 增益邊緣的平滑時間（避免爆音）。 */
export const EDGE_MS = 5;

export const EFFECT_LABEL: Record<EffectKind, string> = {
  mute: "靜音",
  gain: "增益",
  fade_in: "淡入",
  fade_out: "淡出",
};

export function effectLabel(e: AudioEffect): string {
  if (e.kind === "gain") return `${(e.db ?? 0) >= 0 ? "+" : ""}${(e.db ?? 0).toFixed(0)} dB`;
  return EFFECT_LABEL[e.kind];
}

export function effectId(kind: EffectKind, startMs: number, endMs: number, db?: number): string {
  return `${kind}:${Math.round(startMs)}-${Math.round(endMs)}${db != null ? `:${db}` : ""}`;
}

/** 邊緣平滑：區段內距離邊界 < EDGE_MS 時線性過渡（0 → 1）。 */
function edgeWeight(ms: number, startMs: number, endMs: number): number {
  const edge = Math.min(EDGE_MS, (endMs - startMs) / 2);
  if (edge <= 0) return 1;
  const din = ms - startMs;
  const dout = endMs - ms;
  return Math.max(0, Math.min(1, Math.min(din, dout) / edge));
}

/** 單一效果在時刻 ms 的線性倍率（不在範圍內回 1）。 */
export function effectGain(e: AudioEffect, ms: number): number {
  if (ms < e.startMs || ms >= e.endMs) return 1;
  const len = Math.max(1, e.endMs - e.startMs);
  switch (e.kind) {
    case "mute": {
      const w = edgeWeight(ms, e.startMs, e.endMs);
      return 1 - w;
    }
    case "gain": {
      const lin = Math.pow(10, (e.db ?? 0) / 20);
      const w = edgeWeight(ms, e.startMs, e.endMs);
      return 1 + (lin - 1) * w;
    }
    case "fade_in":
      return (ms - e.startMs) / len;
    case "fade_out":
      return 1 - (ms - e.startMs) / len;
    default:
      return 1;
  }
}

/** 所有效果在時刻 ms 的合成倍率（相乘）。 */
export function effectGainAt(effects: readonly AudioEffect[], ms: number): number {
  let g = 1;
  for (const e of effects) g *= effectGain(e, ms);
  return g;
}

/** 與範圍重疊的效果。 */
export function effectsInRange(effects: readonly AudioEffect[], startMs: number, endMs: number): AudioEffect[] {
  return effects.filter((e) => e.startMs < endMs && e.endMs > startMs);
}
