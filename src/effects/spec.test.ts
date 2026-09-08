import { describe, expect, it } from "vitest";
import { Volume2 } from "lucide-react";
import { advancedParams, applyPresetKeepMeasured, mainParams, matchingPreset, resolveValues, type EffectSpec } from "./spec";
import { gainSpec } from "./specs/gain";

const spec: EffectSpec = {
  id: "t.x",
  title: "X",
  icon: Volume2,
  group: "effect",
  blurb: "x",
  params: [
    { id: "a", label: "a", kind: "slider", min: 0, max: 10, step: 1, default: 5 },
    { id: "b", label: "b", kind: "slider", min: -1, max: 1, step: 0.5, default: 0, primary: true },
    { id: "c", label: "c", kind: "toggle", default: false },
    { id: "d", label: "d", kind: "select", options: [{ value: "x", label: "x" }, { value: "y", label: "y" }], default: "x", advanced: true },
  ],
  presets: [{ id: "p1", label: "p1", values: { a: 9, b: 1 } }],
  scope: "selection",
  build: () => ({ kind: "custom", label: "x", apply: () => {} }),
};

describe("resolveValues", () => {
  it("預設 → preset → 覆蓋，並逐項 clamp", () => {
    expect(resolveValues(spec)).toEqual({ a: 5, b: 0, c: false, d: "x" });
    expect(resolveValues(spec, spec.presets[0])).toEqual({ a: 9, b: 1, c: false, d: "x" });
    expect(resolveValues(spec, spec.presets[0], { a: 99, b: 0.3, c: 1, d: "zzz" })).toEqual({ a: 10, b: 0.5, c: true, d: "x" });
  });
  it("非數字進滑桿退回預設", () => {
    expect(resolveValues(spec, null, { a: "nope" }).a).toBe(5);
  });
});

describe("applyPresetKeepMeasured", () => {
  const nfSpec: EffectSpec = {
    ...spec,
    params: [
      { id: "nr", label: "nr", kind: "slider", min: 3, max: 30, step: 1, default: 12 },
      { id: "nf", label: "nf", kind: "slider", min: -80, max: -20, step: 1, default: -50, measured: true },
      { id: "x", label: "x", kind: "slider", min: 0, max: 10, step: 1, default: 5 },
    ],
    presets: [
      { id: "light", label: "light", values: { nr: 6 } },
      { id: "reset", label: "reset", values: { nr: 6, nf: -50 } },
    ],
  };
  const current = { nr: 9, nf: -63, x: 8 };
  it("spec 標 measured 的 key：preset 沒列就留目前的值；其他 key 照舊退回預設", () => {
    expect(applyPresetKeepMeasured(nfSpec, nfSpec.presets[0], current)).toEqual({ nr: 6, nf: -63, x: 5 });
  });
  it("preset 明確列到的 key 以 preset 為準（就算等於預設）", () => {
    expect(applyPresetKeepMeasured(nfSpec, nfSpec.presets[1], current)).toEqual({ nr: 6, nf: -50, x: 5 });
  });
  it("對話框追蹤到的 measured key 也一樣保住，而且會 clamp", () => {
    expect(applyPresetKeepMeasured(nfSpec, nfSpec.presets[0], { ...current, x: 99 }, new Set(["x"]))).toEqual({ nr: 6, nf: -63, x: 10 });
    // 沒標、沒追蹤 → 等於 resolveValues(spec, preset)
    expect(applyPresetKeepMeasured(spec, spec.presets[0], { a: 1, b: -1, c: true, d: "y" })).toEqual(resolveValues(spec, spec.presets[0]));
  });
});

describe("mainParams / advancedParams", () => {
  it("專業：非 advanced 最多 3 個；簡易：只有 primary", () => {
    expect(mainParams(spec, false).map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(mainParams(spec, true).map((p) => p.id)).toEqual(["b"]);
    expect(advancedParams(spec).map((p) => p.id)).toEqual(["d"]);
  });
});

describe("matchingPreset", () => {
  it("全部 key 相等才算命中", () => {
    expect(matchingPreset(spec, { a: 9, b: 1, c: false, d: "x" })?.id).toBe("p1");
    expect(matchingPreset(spec, { a: 9, b: 0, c: false, d: "x" })).toBeNull();
  });
});

describe("gainSpec", () => {
  it("build 出一個 gain 效果，id 含範圍與 dB", () => {
    const v = resolveValues(gainSpec, gainSpec.presets.find((p) => p.id === "m6"));
    const app = gainSpec.build(v, { startMs: 1000, endMs: 4000 }, { mediaId: "m", local: null, transcript: null, selection: null, durationMs: 10000 });
    expect(app.kind).toBe("effects");
    if (app.kind !== "effects") return;
    expect(app.effects).toEqual([{ id: "gain:1000-4000:-6", kind: "gain", startMs: 1000, endMs: 4000, db: -6 }]);
    expect(app.label).toBe("-6 dB");
  });
  it("五個預設、一根 primary 滑桿", () => {
    expect(gainSpec.presets.map((p) => p.id)).toEqual(["p6", "p3", "m3", "m6", "m12"]);
    expect(mainParams(gainSpec, true).map((p) => p.id)).toEqual(["db"]);
  });
});
