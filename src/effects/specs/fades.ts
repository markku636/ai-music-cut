import { FlipVertical2, TrendingUp } from "lucide-react";
import { effectId, type AudioEffect, type FadeShape } from "../../analysis/effects";
import type { EffectSpec } from "../spec";

/** 淡入淡出（自訂長度與曲線）。一鍵版是 effect.fadeBoth（300 ms、等功率）。 */
export const fadesSpec: EffectSpec = {
  id: "effect.fades",
  title: "淡入淡出（自訂長度與曲線）",
  icon: TrendingUp,
  group: "effect",
  section: "淡入淡出",
  blurb: "選取的開頭慢慢變大聲、結尾慢慢變小聲。等功率適合接音樂，指數比較像老式混音台的推桿。",
  params: [
    { id: "inMs", label: "淡入長度", kind: "slider", min: 0, max: 5000, step: 50, unit: "ms", default: 300, primary: true },
    { id: "outMs", label: "淡出長度", kind: "slider", min: 0, max: 5000, step: 50, unit: "ms", default: 300 },
    {
      id: "shape",
      label: "曲線",
      kind: "select",
      options: [
        { value: "equal_power", label: "等功率" },
        { value: "linear", label: "線性" },
        { value: "exponential", label: "指數" },
      ],
      default: "equal_power",
    },
  ],
  presets: [
    { id: "short", label: "短（0.3 秒）", values: { inMs: 300, outMs: 300 } },
    { id: "medium", label: "中（1 秒）", values: { inMs: 1000, outMs: 1000 } },
    { id: "long", label: "長（3 秒）", values: { inMs: 3000, outMs: 3000 } },
  ],
  scope: "selection",
  keywords: ["fade", "fade in", "fade out"],
  validate: (v, _ctx) => (Number(v.inMs) <= 0 && Number(v.outMs) <= 0 ? "淡入與淡出至少要有一個大於 0" : null),
  build: (v, range) => {
    const len = range.endMs - range.startMs;
    const shape = String(v.shape) as FadeShape;
    const inMs = Math.min(Number(v.inMs), len);
    const outMs = Math.min(Number(v.outMs), len);
    const effects: AudioEffect[] = [];
    if (inMs >= 20) effects.push({ id: effectId("fade_in", range.startMs, range.startMs + inMs, undefined, { shape: shape === "linear" ? 0 : shape === "equal_power" ? 1 : 2 }), kind: "fade_in", startMs: range.startMs, endMs: range.startMs + inMs, shape });
    if (outMs >= 20) effects.push({ id: effectId("fade_out", range.endMs - outMs, range.endMs, undefined, { shape: shape === "linear" ? 0 : shape === "equal_power" ? 1 : 2 }), kind: "fade_out", startMs: range.endMs - outMs, endMs: range.endMs, shape });
    return { kind: "effects", effects, label: "淡入淡出" };
  },
};

/** 反相（GoldWave 的 Invert）：波形上下翻過來。沒有參數 → 註冊表直接給一顆指令，不開對話框。 */
export const invertSpec: EffectSpec = {
  id: "effect.invert",
  title: "反相",
  icon: FlipVertical2,
  group: "effect",
  section: "音量",
  blurb: "把波形上下翻過來（相位反轉）。單獨聽不出差別；兩支麥克風相位相反、疊起來變小聲時用它救。",
  params: [],
  presets: [],
  scope: "selection",
  keywords: ["invert", "phase", "polarity"],
  build: (_v, range) => ({
    kind: "effects",
    effects: [{ id: effectId("invert", range.startMs, range.endMs), kind: "invert", startMs: range.startMs, endMs: range.endMs }],
    label: "反相",
  }),
};
