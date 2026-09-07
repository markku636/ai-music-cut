import { MoveVertical, Radio, Sparkles, Waves, Zap } from "lucide-react";
import { effectId, type AudioEffect, type RangeEffectKind } from "../../analysis/effects";
import { suggestDenoise } from "../../analysis/levels";
import { previewRangeEffects } from "../../pipeline/fxPreview";
import { useCleanup } from "../../store/cleanup";
import type { TimeSelection } from "../../store/timeline";
import type { EffectApplication, EffectSpec, ParamValues } from "../spec";

/**
 * 修復類（GoldWave 的 Restoration）：降噪 / 去爆音 / 去削波 / 去嗡聲 / DC。
 * 全部是**範圍濾波**：存成 params 袋的 AudioEffect，輸出時由 Rust fx.rs 在成品時間軸上 punch-in；
 * 即時播放聽不到，所以每個對話框的 A/B 走 fxPreview（對來源檔直接切一段，< 1 秒）。
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

const denoiseBuild = (v: ParamValues, range: TimeSelection) => rangeEffect("denoise", range, { nrDb: Number(v.nrDb), nfDb: Number(v.nfDb) }, `降噪 ${v.nrDb} dB`);

/** 範圍降噪：簡易右鍵的「去雜音」優先走這支（有選取就只處理那一段）。 */
export const denoiseSpec: EffectSpec = {
  id: "repair.denoise",
  title: "降噪（這一段）",
  simpleLabel: "去雜音",
  simpleHint: "壓掉選的這段裡的背景嘶聲；可復原",
  icon: Sparkles,
  group: "repair",
  section: "噪音",
  blurb: "只處理選的這一段：把背景嘶聲壓掉。減太多會出現「水聲」，建議值通常剛好；有噪音樣本就以它為準。",
  params: [
    {
      id: "nrDb",
      label: "降噪量",
      kind: "slider",
      min: 3,
      max: 30,
      step: 1,
      unit: "dB",
      default: 12,
      primary: true,
      describe: (v) => (Number(v) > 18 ? "減超過 18 dB 容易出現水聲" : undefined),
    },
    { id: "nfDb", label: "底噪", kind: "slider", min: -80, max: -20, step: 1, unit: "dBFS", default: -50, advanced: true, hint: "量到的底噪；有噪音樣本就用樣本的值" },
  ],
  presets: [
    { id: "light", label: "輕（6 dB）", values: { nrDb: 6 } },
    { id: "medium", label: "中（12 dB）", values: { nrDb: 12 } },
    { id: "strong", label: "強（18 dB）", values: { nrDb: 18 } },
  ],
  scope: "selection",
  keywords: ["denoise", "noise", "hiss", "clean"],
  suggest: (ctx, range) => {
    const print = useCleanup.getState().noisePrint[ctx.mediaId] ?? null;
    const s = suggestDenoise(ctx.local, range, print);
    return { values: { nrDb: s.nrDb || 6, nfDb: s.nfDb }, summary: s.summary, confidence: s.confidence };
  },
  build: denoiseBuild,
  preview: previewOf(denoiseBuild),
};

const declickBuild = (v: ParamValues, range: TimeSelection) => rangeEffect("declick", range, { threshold: Number(v.threshold) }, "去爆音");

export const declickSpec: EffectSpec = {
  id: "repair.declick",
  title: "去爆音",
  simpleLabel: "去啪聲",
  simpleHint: "去掉「啪」一聲的爆音（麥克風被碰到、黑膠式的 click）",
  icon: Zap,
  group: "repair",
  section: "修復",
  blurb: "去掉「啪」一聲的爆音（麥克風被碰到、線材接觸不良、黑膠式的 click / pop）。只處理選的這一段；越敏感越容易把子音當爆音。",
  params: [
    {
      id: "threshold",
      label: "敏感度",
      kind: "slider",
      min: 1,
      max: 10,
      step: 0.5,
      default: 2,
      primary: true,
      hint: "數字越小越敏感",
      describe: (v) => (Number(v) < 1.5 ? "太敏感會把ㄆ / ㄊ這類子音當成爆音" : undefined),
    },
  ],
  presets: [
    { id: "gentle", label: "溫和", values: { threshold: 4 } },
    { id: "normal", label: "一般", values: { threshold: 2 } },
    { id: "aggressive", label: "積極", values: { threshold: 1 } },
  ],
  scope: "selection",
  keywords: ["declick", "click", "pop", "crackle"],
  build: declickBuild,
  preview: previewOf(declickBuild),
};

const declipBuild = (v: ParamValues, range: TimeSelection) => rangeEffect("declip", range, { threshold: Number(v.threshold) }, "去削波");

export const declipSpec: EffectSpec = {
  id: "repair.declip",
  title: "去削波",
  icon: Waves,
  group: "repair",
  section: "修復",
  blurb: "前級開太大、波形頂到天花板（削波）時，用前後的波形把被切平的波峰補回來。只救得了輕微的削波；整段都爆掉的救不回來。",
  params: [
    {
      id: "threshold",
      label: "判定門檻",
      kind: "slider",
      min: 1,
      max: 20,
      step: 1,
      default: 10,
      primary: true,
      hint: "數字越小，越多樣本會被當成削波來修",
    },
  ],
  presets: [
    { id: "light", label: "輕", values: { threshold: 15 } },
    { id: "normal", label: "一般", values: { threshold: 10 } },
    { id: "heavy", label: "重", values: { threshold: 5 } },
  ],
  scope: "selection",
  keywords: ["declip", "clipping", "distortion"],
  build: declipBuild,
  preview: previewOf(declipBuild),
};

const humBuild = (v: ParamValues, range: TimeSelection) => rangeEffect("hum", range, { baseHz: Number(v.baseHz), harmonics: Number(v.harmonics) }, `去嗡聲 ${v.baseHz} Hz`);

export const humSpec: EffectSpec = {
  id: "repair.hum",
  title: "去嗡聲",
  icon: Radio,
  group: "repair",
  section: "修復",
  blurb: "去掉電源嗡聲（50 / 60 Hz 與它的諧波）。台灣、美國、日本東部是 60 Hz；歐洲、中國、日本西部是 50 Hz。每個諧波只挖幾 Hz 寬，人聲不受影響。",
  params: [
    {
      id: "baseHz",
      label: "電源頻率",
      kind: "select",
      options: [
        { value: "60", label: "60 Hz（台灣 / 美國）" },
        { value: "50", label: "50 Hz（歐洲 / 中國）" },
      ],
      default: "60",
      primary: true,
    },
    { id: "harmonics", label: "諧波數", kind: "slider", min: 1, max: 8, step: 1, default: 4, hint: "嗡聲通常不只基頻，還有 2、3、4 倍頻" },
  ],
  presets: [
    { id: "tw", label: "60 Hz × 4", values: { baseHz: "60", harmonics: 4 } },
    { id: "eu", label: "50 Hz × 4", values: { baseHz: "50", harmonics: 4 } },
  ],
  scope: "selection",
  keywords: ["hum", "buzz", "50hz", "60hz", "mains"],
  build: humBuild,
  preview: previewOf(humBuild),
};

const dcBuild = (_v: ParamValues, range: TimeSelection) => rangeEffect("dc", range, { shift: 0 }, "DC 修正");

/** 沒有參數：registry 直接產一條指令（不開對話框）。 */
export const dcSpec: EffectSpec = {
  id: "repair.dc",
  title: "DC 偏移修正",
  icon: MoveVertical,
  group: "repair",
  section: "修復",
  blurb: "波形整個往上或往下偏（錄音介面的直流偏移）時，用 10 Hz 高通把它拉回中線。",
  params: [],
  presets: [],
  scope: "selection",
  keywords: ["dc", "offset"],
  build: dcBuild,
  preview: previewOf(dcBuild),
};

export const REPAIR_SPECS: EffectSpec[] = [denoiseSpec, declickSpec, declipSpec, humSpec, dcSpec];
