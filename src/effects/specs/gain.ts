import { Volume2 } from "lucide-react";
import { effectId, type AudioEffect } from "../../analysis/effects";
import type { EffectSpec } from "../spec";

const STEPS = [6, 3, -3, -6, -12];

/** 增益：R1 的示範 spec —— 一根滑桿、五個預設、選取範圍。 */
export const gainSpec: EffectSpec = {
  id: "effect.gain",
  title: "增益",
  simpleLabel: "音量",
  simpleHint: "把選的這一段變大聲或變小聲",
  icon: Volume2,
  group: "effect",
  section: "音量",
  blurb: "把選的這一段變大聲或變小聲（dB）。超過 +6 dB 容易破音。",
  params: [
    {
      id: "db",
      label: "增益",
      kind: "slider",
      min: -24,
      max: 12,
      step: 1,
      unit: "dB",
      default: 0,
      primary: true,
      describe: (v) => (Number(v) > 6 ? "超過 +6 dB 容易破音" : Number(v) === 0 ? "0 dB＝沒有改變" : undefined),
    },
  ],
  presets: STEPS.map((db) => ({ id: `${db > 0 ? "p" : "m"}${Math.abs(db)}`, label: "增益 {db} dB", labelParams: { db: db > 0 ? `+${db}` : String(db) }, values: { db } })),
  scope: "selection",
  keywords: ["gain", "volume", "louder", "quieter"],
  build: (v, range) => {
    const db = Number(v.db);
    const e: AudioEffect = { id: effectId("gain", range.startMs, range.endMs, db), kind: "gain", startMs: range.startMs, endMs: range.endMs, db };
    return { kind: "effects", effects: [e], label: `${db >= 0 ? "+" : ""}${db} dB` };
  },
};
