// 區段效果（Wave Editor 式）。時間為來源時間軸（ms）。
//
// 兩類：
// - **增益包絡**（mute / gain / fade_in / fade_out / invert）：Rust 的 Cutter 逐 frame 相乘，
//   預聽端用 <audio>.volume 走同一套定義（純函式 effectGain）。
// - **範圍濾波**（denoise / declick / …）：輸出時在成品時間軸上另跑一趟 ffmpeg（R4 的 fx.rs），
//   即時播放聽不到 —— effectGain 對它們一律回 1。
export type GainEffectKind = "mute" | "gain" | "fade_in" | "fade_out" | "invert";
export type RangeEffectKind = "denoise" | "declick" | "declip" | "hum" | "dc" | "eq" | "compressor" | "echo" | "reverb" | "reverse" | "pitch";
export type EffectKind = GainEffectKind | RangeEffectKind;

export type FadeShape = "linear" | "equal_power" | "exponential";
export const FADE_SHAPES: readonly FadeShape[] = ["linear", "equal_power", "exponential"];

export const GAIN_KINDS: readonly GainEffectKind[] = ["mute", "gain", "fade_in", "fade_out", "invert"];
export const RANGE_KINDS: readonly RangeEffectKind[] = ["denoise", "declick", "declip", "hum", "dc", "eq", "compressor", "echo", "reverb", "reverse", "pitch"];
export const ALL_EFFECT_KINDS: readonly EffectKind[] = [...GAIN_KINDS, ...RANGE_KINDS];

/** 誰加的：只影響標籤與重算，不影響渲染。 */
export type EffectOrigin = "peak_normalize" | "match_loudness" | "suggest" | "qc";

export interface AudioEffect {
  id: string;
  kind: EffectKind;
  startMs: number;
  endMs: number;
  /** gain 專用（dB，可正可負）。 */
  db?: number;
  /** fade_in / fade_out 的曲線；省略 = linear。 */
  shape?: FadeShape;
  /** 範圍濾波的參數袋（鍵由各效果的 spec 定義；Rust 端才做型別）。 */
  params?: Record<string, number>;
  origin?: EffectOrigin;
}

/** 靜音 / 增益邊緣的平滑時間（避免爆音）。 */
export const EDGE_MS = 5;

export const EFFECT_LABEL: Record<EffectKind, string> = {
  mute: "靜音",
  gain: "增益",
  fade_in: "淡入",
  fade_out: "淡出",
  invert: "反相",
  denoise: "降噪",
  declick: "去爆音",
  declip: "去削波",
  hum: "去嗡聲",
  dc: "DC 偏移",
  eq: "等化",
  compressor: "壓縮",
  echo: "回音",
  reverb: "殘響",
  reverse: "反轉",
  pitch: "變調",
};

export const SHAPE_LABEL: Record<FadeShape, string> = {
  linear: "線性",
  equal_power: "等功率",
  exponential: "指數",
};

export function isGainEffect(e: Pick<AudioEffect, "kind">): boolean {
  return (GAIN_KINDS as readonly string[]).includes(e.kind);
}

export function isRangeEffect(e: Pick<AudioEffect, "kind">): boolean {
  return (RANGE_KINDS as readonly string[]).includes(e.kind);
}

const sign = (n: number) => (n >= 0 ? "+" : "");

/** 時間軸色塊上的短標籤。 */
export function effectLabel(e: AudioEffect): string {
  const p = e.params ?? {};
  switch (e.kind) {
    case "gain":
      return `${sign(e.db ?? 0)}${(e.db ?? 0).toFixed(Number.isInteger(e.db ?? 0) ? 0 : 1)} dB`;
    case "fade_in":
    case "fade_out":
      return e.shape && e.shape !== "linear" ? `${EFFECT_LABEL[e.kind]}（${SHAPE_LABEL[e.shape]}）` : EFFECT_LABEL[e.kind];
    case "denoise":
      return p.nrDb != null ? `降噪 ${p.nrDb} dB` : EFFECT_LABEL.denoise;
    case "hum":
      return p.baseHz != null ? `去嗡聲 ${p.baseHz} Hz` : EFFECT_LABEL.hum;
    case "pitch":
      return p.semitones != null ? `變調 ${sign(p.semitones)}${p.semitones}` : EFFECT_LABEL.pitch;
    default:
      return EFFECT_LABEL[e.kind];
  }
}

/** 32-bit FNV-1a，短雜湊給 id 用（同範圍、不同參數的兩個降噪不能撞 id）。 */
function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function effectId(kind: EffectKind, startMs: number, endMs: number, db?: number, params?: Record<string, number>): string {
  const base = `${kind}:${Math.round(startMs)}-${Math.round(endMs)}${db != null ? `:${db}` : ""}`;
  if (!params) return base;
  const keys = Object.keys(params).sort();
  if (!keys.length) return base;
  return `${base}:h${fnv(keys.map((k) => `${k}=${params[k]}`).join("&"))}`;
}

/**
 * 淡入淡出曲線。p ∈ [0,1] 是在淡化區間裡的位置。
 * - linear：p
 * - equal_power：sin / cos（接音樂時兩邊功率和恆定）
 * - exponential：60 dB 對數線性（10^(−3·(1−p))），像混音台推桿；p=0 是 −60 dB 不是 0
 * 與 Rust render.rs 的 fade_curve 共用同一張樣本表（測試釘死）。
 */
export function fadeCurve(shape: FadeShape | undefined, p: number, dir: "in" | "out"): number {
  const q = Math.max(0, Math.min(1, p));
  switch (shape) {
    case "equal_power":
      return dir === "in" ? Math.sin((q * Math.PI) / 2) : Math.cos((q * Math.PI) / 2);
    case "exponential":
      return dir === "in" ? Math.pow(10, -3 * (1 - q)) : Math.pow(10, -3 * q);
    default:
      return dir === "in" ? q : 1 - q;
  }
}

/** 邊緣平滑：區段內距離邊界 < EDGE_MS 時線性過渡（0 → 1）。 */
function edgeWeight(ms: number, startMs: number, endMs: number): number {
  const edge = Math.min(EDGE_MS, (endMs - startMs) / 2);
  if (edge <= 0) return 1;
  const din = ms - startMs;
  const dout = endMs - ms;
  return Math.max(0, Math.min(1, Math.min(din, dout) / edge));
}

/**
 * 單一效果在時刻 ms 的線性倍率（不在範圍內回 1）。
 * 反相回負值：邊緣用同一條 5 ms 斜坡穿過 0（不會 click），兩個重疊的反相相乘 = +1。
 * 預聽端要取絕對值（<audio>.volume 不能是負的）。
 */
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
      return fadeCurve(e.shape, (ms - e.startMs) / len, "in");
    case "fade_out":
      return fadeCurve(e.shape, (ms - e.startMs) / len, "out");
    case "invert": {
      const w = edgeWeight(ms, e.startMs, e.endMs);
      return 1 - 2 * w;
    }
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
