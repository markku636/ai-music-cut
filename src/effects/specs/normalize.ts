import { Gauge, Maximize2 } from "lucide-react";
import { effectId, type AudioEffect } from "../../analysis/effects";
import { matchLoudnessGainDb, peakNormalizeGainDb } from "../../analysis/levels";
import type { EffectSpec } from "../spec";

function gainEffect(startMs: number, endMs: number, db: number, origin: AudioEffect["origin"]): AudioEffect {
  return { id: effectId("gain", startMs, endMs, db), kind: "gain", startMs, endMs, db, origin };
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/** 峰值正規化（GoldWave 的 Maximize）：零 Rust —— 從 analysis.bin 的 i8 峰值算出一個 gain 效果。 */
export const peakNormalizeSpec: EffectSpec = {
  id: "effect.normalize",
  title: "峰值正規化",
  simpleLabel: "音量拉滿",
  simpleHint: "把這段最大聲的地方拉到剛好不破音",
  icon: Maximize2,
  group: "effect",
  section: "音量",
  blurb: "把這段最大聲的地方拉到目標峰值（預設 −1 dBFS），其他跟著等比例放大或縮小。",
  params: [{ id: "target", label: "目標峰值", kind: "slider", min: -12, max: 0, step: 1, unit: "dBFS", default: -1, primary: true }],
  presets: [],
  scope: "selection",
  keywords: ["normalize", "maximize", "peak"],
  suggest: (ctx, range) => {
    const s = peakNormalizeGainDb(ctx.local, range.startMs, range.endMs, -1);
    return s ? { values: { target: -1 }, summary: s.summary, confidence: s.confidence } : null;
  },
  validate: (_v, ctx) => (ctx.local ? null : "還沒有波形分析，量不到峰值"),
  build: (v, range, ctx) => {
    const s = peakNormalizeGainDb(ctx.local, range.startMs, range.endMs, Number(v.target));
    const db = s ? round1(s.db) : 0;
    return { kind: "effects", effects: [gainEffect(range.startMs, range.endMs, db, "peak_normalize")], label: `峰值正規化 ${db >= 0 ? "+" : ""}${db} dB` };
  },
};

/** 響度對齊（GoldWave 的 Match Volume）：這段比整集大 / 小幾 LU，就補回來。 */
export const matchLoudnessSpec: EffectSpec = {
  id: "effect.match",
  title: "響度對齊",
  icon: Gauge,
  group: "effect",
  section: "音量",
  blurb: "量這段的響度，跟整集平均（或指定的 LUFS）比，差多少就補多少。",
  params: [
    {
      id: "ref",
      label: "對齊到",
      kind: "select",
      options: [
        { value: "episode", label: "整集平均" },
        { value: "-14", label: "−14 LUFS" },
        { value: "-16", label: "−16 LUFS" },
        { value: "-19", label: "−19 LUFS" },
        { value: "-23", label: "−23 LUFS" },
      ],
      default: "episode",
      primary: true,
    },
  ],
  presets: [],
  scope: "selection",
  keywords: ["match", "loudness", "lufs", "level"],
  suggest: (ctx, range) => {
    const s = matchLoudnessGainDb(ctx.local, range.startMs, range.endMs, "episode");
    return s ? { values: { ref: "episode" }, summary: s.summary, confidence: s.confidence } : null;
  },
  validate: (_v, ctx) => (ctx.local ? null : "還沒有波形分析，量不到響度"),
  build: (v, range, ctx) => {
    const ref = v.ref === "episode" ? "episode" : Number(v.ref);
    const s = matchLoudnessGainDb(ctx.local, range.startMs, range.endMs, ref);
    const db = s ? round1(s.db) : 0;
    return { kind: "effects", effects: [gainEffect(range.startMs, range.endMs, db, "match_loudness")], label: `響度對齊 ${db >= 0 ? "+" : ""}${db} dB` };
  },
};
