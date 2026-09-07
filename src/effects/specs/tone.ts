import { ArrowLeftRight, AudioLines, Gauge, Music2, Radio, SlidersHorizontal } from "lucide-react";
import { effectId, type AudioEffect, type RangeEffectKind } from "../../analysis/effects";
import { previewRangeEffects } from "../../pipeline/fxPreview";
import type { TimeSelection } from "../../store/timeline";
import type { EffectApplication, EffectSpec, ParamValues } from "../spec";

/**
 * 音色 / 動態 / 空間 / 時間類（GoldWave 的 Effects 選單）：EQ、壓縮、回音、殘響、反轉、變調。
 * 全部是範圍濾波（輸出時 Rust punch-in），A/B 走 fxPreview。
 * 回音 / 殘響的尾巴在區域結尾截斷（GoldWave 也是）；反轉 / 變調之後波形跟原本無關，驗收只比位置。
 */

function rangeEffect(kind: RangeEffectKind, range: TimeSelection, params: Record<string, number>, label: string): EffectApplication {
  const e: AudioEffect = { id: effectId(kind, range.startMs, range.endMs, undefined, params), kind, startMs: range.startMs, endMs: range.endMs, params };
  return { kind: "effects", effects: [e], label };
}

function previewOf(build: (v: ParamValues, range: TimeSelection) => EffectApplication): EffectSpec["preview"] {
  return (v, range, ctx) => {
    const app = build(v, range);
    return previewRangeEffects(ctx.mediaId, app.kind === "effects" ? app.effects : [], range);
  };
}

const sign = (n: number) => (n > 0 ? `+${n}` : String(n));

const eqBuild = (v: ParamValues, range: TimeSelection) =>
  rangeEffect("eq", range, { lowDb: Number(v.lowDb), midDb: Number(v.midDb), highDb: Number(v.highDb) }, `等化 ${sign(Number(v.lowDb))} / ${sign(Number(v.midDb))} / ${sign(Number(v.highDb))}`);

export const eqSpec: EffectSpec = {
  id: "effect.eq",
  title: "等化（三段）",
  simpleLabel: "音色",
  simpleHint: "讓聲音更清楚、更溫暖或更薄",
  icon: SlidersHorizontal,
  group: "effect",
  section: "音色",
  blurb: "三段等化：低（200 Hz 以下）、中（1 kHz 附近）、高（4 kHz 以上）。人聲不清楚通常是高頻少，悶是低頻多。",
  params: [
    { id: "lowDb", label: "低頻", kind: "slider", min: -12, max: 12, step: 1, unit: "dB", default: 0 },
    { id: "midDb", label: "中頻", kind: "slider", min: -12, max: 12, step: 1, unit: "dB", default: 0, primary: true },
    { id: "highDb", label: "高頻", kind: "slider", min: -12, max: 12, step: 1, unit: "dB", default: 0 },
  ],
  presets: [
    { id: "clarity", label: "人聲清晰", values: { lowDb: -2, midDb: 0, highDb: 3 } },
    { id: "warm", label: "溫暖", values: { lowDb: 3, midDb: 0, highDb: -1 } },
    { id: "phone", label: "電話", values: { lowDb: -12, midDb: 6, highDb: -12 } },
    { id: "demud", label: "去悶", values: { lowDb: -4, midDb: 2, highDb: 2 } },
  ],
  scope: "selection",
  keywords: ["eq", "equalizer", "bass", "treble", "tone"],
  build: eqBuild,
  preview: previewOf(eqBuild),
};

const compBuild = (v: ParamValues, range: TimeSelection) =>
  rangeEffect(
    "compressor",
    range,
    { thresholdDb: Number(v.thresholdDb), ratio: Number(v.ratio), attackMs: Number(v.attackMs), releaseMs: Number(v.releaseMs), makeupDb: Number(v.makeupDb) },
    `壓縮 ${v.ratio}:1`,
  );

export const compressorSpec: EffectSpec = {
  id: "effect.compressor",
  title: "壓縮",
  simpleLabel: "音量弄平",
  simpleHint: "大聲的壓下來、小聲的抬上去，聽起來比較穩",
  icon: Gauge,
  group: "effect",
  section: "動態",
  blurb: "把超過門檻的部分按比例壓下來，再整體補回一點音量。人聲忽大忽小、或要讓聲音「貼上來」時用。整集的音量平衡請用「音量弄整齊」，那是另一件事。",
  params: [
    { id: "thresholdDb", label: "門檻", kind: "slider", min: -40, max: 0, step: 1, unit: "dBFS", default: -18, primary: true },
    { id: "ratio", label: "比例", kind: "slider", min: 1, max: 12, step: 0.5, unit: ":1", default: 4 },
    { id: "makeupDb", label: "補償增益", kind: "slider", min: 0, max: 12, step: 1, unit: "dB", default: 3 },
    { id: "attackMs", label: "起動", kind: "slider", min: 1, max: 200, step: 1, unit: "ms", default: 10, advanced: true },
    { id: "releaseMs", label: "釋放", kind: "slider", min: 20, max: 1000, step: 10, unit: "ms", default: 120, advanced: true },
  ],
  presets: [
    { id: "voice", label: "人聲", values: { thresholdDb: -18, ratio: 3, makeupDb: 3, attackMs: 10, releaseMs: 120 } },
    { id: "broadcast", label: "廣播", values: { thresholdDb: -24, ratio: 6, makeupDb: 6, attackMs: 5, releaseMs: 80 } },
  ],
  scope: "selection",
  keywords: ["compressor", "compress", "dynamics"],
  build: compBuild,
  preview: previewOf(compBuild),
};

const echoBuild = (v: ParamValues, range: TimeSelection) => rangeEffect("echo", range, { delayMs: Number(v.delayMs), decay: Number(v.decay) }, `回音 ${v.delayMs} ms`);

export const echoSpec: EffectSpec = {
  id: "effect.echo",
  title: "回音",
  icon: Radio,
  group: "effect",
  section: "空間",
  blurb: "隔一段時間重複一次、越來越小聲。回音的尾巴在選取結尾就截斷，選取要留一點尾巴給它。",
  params: [
    { id: "delayMs", label: "間隔", kind: "slider", min: 50, max: 1000, step: 10, unit: "ms", default: 250, primary: true },
    { id: "decay", label: "衰減", kind: "slider", min: 0.1, max: 0.9, step: 0.05, default: 0.4 },
  ],
  presets: [
    { id: "slap", label: "短拍", values: { delayMs: 90, decay: 0.3 } },
    { id: "room", label: "房間", values: { delayMs: 250, decay: 0.4 } },
    { id: "canyon", label: "山谷", values: { delayMs: 600, decay: 0.6 } },
  ],
  scope: "selection",
  keywords: ["echo", "delay"],
  build: echoBuild,
  preview: previewOf(echoBuild),
};

const reverbBuild = (v: ParamValues, range: TimeSelection) => rangeEffect("reverb", range, { size: Number(v.size), mix: Number(v.mix) }, "殘響");

export const reverbSpec: EffectSpec = {
  id: "effect.reverb",
  title: "殘響",
  simpleLabel: "加空間感",
  simpleHint: "像在房間或大廳裡講話",
  icon: Music2,
  group: "effect",
  section: "空間",
  blurb: "多重反射的空間感（近似，不是真的取樣殘響）。人聲加一點點就夠；尾巴在選取結尾截斷。",
  params: [
    { id: "size", label: "空間大小", kind: "slider", min: 0.3, max: 3, step: 0.1, default: 1, primary: true },
    { id: "mix", label: "量", kind: "slider", min: 0.1, max: 1, step: 0.05, default: 0.6 },
  ],
  presets: [
    { id: "small", label: "小房間", values: { size: 0.6, mix: 0.4 } },
    { id: "hall", label: "大廳", values: { size: 1.6, mix: 0.7 } },
    { id: "cathedral", label: "教堂", values: { size: 2.8, mix: 0.9 } },
  ],
  scope: "selection",
  keywords: ["reverb", "room", "hall", "space"],
  build: reverbBuild,
  preview: previewOf(reverbBuild),
};

const reverseBuild = (_v: ParamValues, range: TimeSelection) => rangeEffect("reverse", range, {}, "反轉");

/** 沒有參數 → registry 直接產一條指令。 */
export const reverseSpec: EffectSpec = {
  id: "effect.reverse",
  title: "反轉（倒著播）",
  icon: ArrowLeftRight,
  group: "effect",
  section: "時間",
  blurb: "把選的這一段倒著播。長度不變；輸出後的驗收對這一段只比位置、不比波形。",
  params: [],
  presets: [],
  scope: "selection",
  keywords: ["reverse", "backwards"],
  build: reverseBuild,
  preview: previewOf(reverseBuild),
};

const pitchBuild = (v: ParamValues, range: TimeSelection) => rangeEffect("pitch", range, { semitones: Number(v.semitones) }, `變調 ${sign(Number(v.semitones))}`);

export const pitchSpec: EffectSpec = {
  id: "effect.pitch",
  title: "變調（保持長度）",
  icon: AudioLines,
  group: "effect",
  section: "時間",
  blurb: "把音高升降幾個半音，長度不變（重取樣後再把時間拉回來）。±3 以內人聲還算自然，再多就像卡通。",
  params: [
    {
      id: "semitones",
      label: "半音",
      kind: "slider",
      min: -12,
      max: 12,
      step: 1,
      default: 0,
      primary: true,
      describe: (v) => (Math.abs(Number(v)) > 3 ? "超過 ±3 半音人聲會失真" : Number(v) === 0 ? "0＝沒有改變" : undefined),
    },
  ],
  presets: [
    { id: "up2", label: "+2", values: { semitones: 2 } },
    { id: "down2", label: "−2", values: { semitones: -2 } },
    { id: "down5", label: "−5", values: { semitones: -5 } },
  ],
  scope: "selection",
  keywords: ["pitch", "transpose", "semitone"],
  validate: (v) => (Number(v.semitones) === 0 ? "半音是 0，沒有東西要改" : null),
  build: pitchBuild,
  preview: previewOf(pitchBuild),
};

export const TONE_SPECS: EffectSpec[] = [eqSpec, compressorSpec, echoSpec, reverbSpec, reverseSpec, pitchSpec];
