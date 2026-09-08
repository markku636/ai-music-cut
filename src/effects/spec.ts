import type { LucideIcon } from "lucide-react";
import type { CleanupSpec } from "../analysis/cleanup";
import type { AudioEffect } from "../analysis/effects";
import type { LocalAnalysis } from "../analysis/peaks";
import type { Transcript } from "../analysis/types";
import type { TimeSelection } from "../store/timeline";

/**
 * 效果規格（EffectSpec）：一個效果只寫一支 spec，對話框、右鍵、命令面板、簡易面板都從它長出來。
 *
 * GoldWave 的模型：選一段 → 效果選單 → 對話框（1–3 個參數、預設、試聽）→ 套用。
 * 這裡把「對話框長什麼樣」抽成資料：params（≤3 個主參數）、presets、suggest（一鍵建議值）、
 * build（參數 → 要加進 store 的東西）。
 */

export type ParamValue = number | string | boolean;
export type ParamValues = Record<string, ParamValue>;

export interface ParamSpec {
  id: string;
  /** zh key */
  label: string;
  kind: "slider" | "select" | "toggle";
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { value: string; label: string }[];
  default: ParamValue;
  /** 標籤下一行的說明（zh key）。 */
  hint?: string;
  /** 依目前的值給一句評語（例如「減太多會出現水聲」）；回傳 zh key。 */
  describe?: (v: ParamValue, all: ParamValues) => string | undefined;
  /** 收進「進階」；非 advanced 的最多 3 個。 */
  advanced?: boolean;
  /** 簡易模式唯一的那根滑桿。 */
  primary?: boolean;
  /** 值是量出來的（底噪、電源頻率…）：套 preset 時沒明確列到就留著目前的值，不退回預設。 */
  measured?: boolean;
}

export interface EffectPreset {
  id: string;
  /** zh key（可帶 {db} 之類的參數）。 */
  label: string;
  labelParams?: Readonly<Record<string, string | number>>;
  values: Partial<ParamValues>;
  hint?: string;
}

export interface EffectContext {
  mediaId: string;
  local: LocalAnalysis | null;
  transcript: Transcript | null;
  selection: TimeSelection | null;
  durationMs: number;
}

export interface Suggestion {
  values: Partial<ParamValues>;
  /** 一句話解釋為什麼建議這樣（zh key 或已翻譯的字串）。 */
  summary: string;
  confidence: "measured" | "heuristic" | "default";
}

export type EffectApplication =
  | { kind: "effects"; effects: AudioEffect[]; label: string }
  | { kind: "cleanup"; spec: CleanupSpec; label: string }
  | { kind: "custom"; label: string; apply: () => void | Promise<void> };

export interface EffectSpec {
  /** "effect.gain" | "repair.denoise"… 也是指令 id 的前綴。 */
  id: string;
  /** zh key */
  title: string;
  /** 簡易模式的白話標籤 / 一句說明（zh key）。 */
  simpleLabel?: string;
  simpleHint?: string;
  icon: LucideIcon;
  group: "effect" | "repair";
  section?: string;
  /** 對話框最上面那一句人話（zh key）。 */
  blurb: string;
  params: ParamSpec[];
  presets: EffectPreset[];
  /** selection：一定要有選取；file：整檔；either：有選取就選取、沒有就整檔。 */
  scope: "selection" | "file" | "either";
  suggest?: (ctx: EffectContext, range: TimeSelection) => Suggestion | null;
  /**
   * 要真的去量（解碼、算頻譜）才給得出的建議：對話框開啟後跑，結果蓋過 suggest。
   * 沒有 quick 指令會用它（quick 是同步的）；量不到就回 null。
   */
  analyze?: (ctx: EffectContext, range: TimeSelection) => Promise<Suggestion | null>;
  /** 回傳錯誤訊息（zh key）；null = 可以套用。 */
  validate?: (v: ParamValues, ctx: EffectContext) => string | null;
  build: (v: ParamValues, range: TimeSelection, ctx: EffectContext) => EffectApplication;
  /** 覆蓋預設的 A/B 試聽（預設走 runRender preview）。 */
  preview?: (v: ParamValues, range: TimeSelection, ctx: EffectContext) => Promise<{ dry: string; wet: string }>;
  keywords?: string[];
  /** 簡易面板格位（有才出現）。 */
  simpleOrder?: number;
}

export function clampValue(p: ParamSpec, v: ParamValue): ParamValue {
  if (p.kind === "slider") {
    let n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) n = Number(p.default);
    if (p.min != null) n = Math.max(p.min, n);
    if (p.max != null) n = Math.min(p.max, n);
    if (p.step) n = Math.round(n / p.step) * p.step;
    return n;
  }
  if (p.kind === "toggle") return !!v;
  if (p.kind === "select") return p.options?.some((o) => o.value === v) ? v : p.default;
  return v;
}

/** 預設值 → preset → 覆蓋，逐項 clamp。 */
export function resolveValues(spec: EffectSpec, preset?: EffectPreset | null, overrides?: Partial<ParamValues> | null): ParamValues {
  const out: ParamValues = {};
  for (const p of spec.params) {
    let v: ParamValue = p.default;
    if (preset && p.id in preset.values) v = preset.values[p.id] as ParamValue;
    if (overrides && p.id in overrides && overrides[p.id] != null) v = overrides[p.id] as ParamValue;
    out[p.id] = clampValue(p, v);
  }
  return out;
}

/**
 * 套 preset，但保住量出來的值：`measured`（spec 標的，或對話框追蹤到「這個值是 suggest / analyze 給的」）的參數，
 * preset 沒有明確列出來就留目前的值，不退回 spec 預設 —— 不然點一下「中」，底噪就從量到的 −63 變回 −50。
 * preset 有列的 key 一律以 preset 為準。
 */
export function applyPresetKeepMeasured(spec: EffectSpec, preset: EffectPreset, current: ParamValues, measured: ReadonlySet<string> = new Set()): ParamValues {
  const out = resolveValues(spec, preset, null);
  for (const p of spec.params) {
    if (!(p.measured || measured.has(p.id))) continue;
    if (p.id in preset.values) continue;
    if (current[p.id] != null) out[p.id] = clampValue(p, current[p.id]);
  }
  return out;
}

/** 對話框主區要畫的參數：非 advanced（最多 3 個）；簡易模式只留 primary（沒標就取第一個）。 */
export function mainParams(spec: EffectSpec, simple: boolean): ParamSpec[] {
  const main = spec.params.filter((p) => !p.advanced).slice(0, 3);
  if (!simple) return main;
  const primary = spec.params.find((p) => p.primary) ?? main[0];
  return primary ? [primary] : [];
}

export function advancedParams(spec: EffectSpec): ParamSpec[] {
  return spec.params.filter((p) => p.advanced);
}

/** 目前的值等於哪個 preset（全部 key 相等才算）。 */
export function matchingPreset(spec: EffectSpec, v: ParamValues): EffectPreset | null {
  for (const p of spec.presets) {
    const keys = Object.keys(p.values);
    if (keys.length && keys.every((k) => v[k] === p.values[k])) return p;
  }
  return null;
}
