// 範圍濾波效果（降噪 / 去爆音 / 去嗡聲 / 去削波 / DC）→ 成品時間軸上的區域（RenderPlan.fx_regions）。
//
// 效果是釘在**來源時間**上的（使用者在波形上選的那一段），但 Rust 的 punch-in 引擎（fx.rs）
// 跑在剪好的 concat.wav（**成品時間**）上。這裡做的換算建在 plan 的 segs 上而不是 edl.keeps：
// 只輸出一段 / 精華合輯都會先把 keeps 裁成 units，逐 seg 走天然正確，也不用管 keeps 有沒有重排。
//
// 帳目規則（與 Rust fx.rs 對拍）：
//   · 區域邊緣 10 ms（XF）wet / dry 交叉；短於 2·XF 的碎片直接丟掉（聽不出來，只會多開一個 ffmpeg）。
//   · 兩個區域之間的縫短於 XF 就收起來（前一段延到後一段的起點），Rust 端拒收 0 < gap < XF。
//   · 同一個位置疊了兩種效果 → 拆成三塊，每塊帶自己的鏈；鏈內依固定順序（rank）排，
//     不管使用者先加哪一個 —— 先去 DC 再去爆音再降噪，順序反了效果會互相打架。
import { isRangeEffect, type AudioEffect, type RangeEffectKind } from "../effects";
import { framesToMs, msToFrames, segOutStartFrames, type JoinSpec, type SegSpan } from "../edl/joins";

/** 區域邊緣的 wet / dry 交叉長度（Rust fx.rs 的 XF_FRAMES = 480）。 */
export const FX_XF_MS = 10;
export const FX_XF_FRAMES = msToFrames(FX_XF_MS);
/** 短於這個的區域丟掉（兩端交叉都放不下）。 */
export const FX_MIN_REGION_FRAMES = 2 * FX_XF_FRAMES;

/** 鏈內順序：先修訊號本身的毛病（DC / 爆音 / 削波），再去嗡聲、降噪，最後才是音色與空間。 */
export const FX_RANK: Record<RangeEffectKind, number> = {
  dc: 0,
  declick: 1,
  declip: 2,
  hum: 3,
  denoise: 4,
  eq: 5,
  compressor: 6,
  echo: 7,
  reverb: 8,
  pitch: 9,
  reverse: 10,
};

/** 這些效果之後的波形跟原本沒有相關性（驗收不能拿波形相似度判它們）。 */
export const FX_UNCORRELATED: readonly RangeEffectKind[] = ["reverse", "pitch"];

/** 送給 Rust 的型別化效果（serde tag = kind）。數字在 Rust 端 clamp，這裡只負責搬。 */
export type RenderRangeFx =
  | { kind: "denoise"; nr_db: number; nf_db: number }
  | { kind: "declick"; threshold: number }
  | { kind: "declip"; threshold: number }
  | { kind: "hum"; base_hz: number; harmonics: number }
  | { kind: "dc"; shift: number };

export interface RenderFxRegion {
  out_start_ms: number;
  out_end_ms: number;
  chain: RenderRangeFx[];
}

export interface FxRegion extends RenderFxRegion {
  /** 這一塊由哪些效果組成（時間軸 / 驗收用）。 */
  effectIds: string[];
  /** false = 鏈裡有 reverse / pitch，成品波形跟來源對不上是正常的。 */
  correlated: boolean;
}

const num = (v: number | undefined, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** AudioEffect（params 袋）→ Rust 的型別化效果；引擎還不支援的種類回 null。 */
export function toRenderFx(e: AudioEffect): RenderRangeFx | null {
  const p = e.params ?? {};
  switch (e.kind) {
    case "denoise":
      return { kind: "denoise", nr_db: num(p.nrDb, 12), nf_db: num(p.nfDb, -50) };
    case "declick":
      return { kind: "declick", threshold: num(p.threshold, 2) };
    case "declip":
      return { kind: "declip", threshold: num(p.threshold, 10) };
    case "hum":
      return { kind: "hum", base_hz: num(p.baseHz, 60), harmonics: num(p.harmonics, 4) };
    case "dc":
      return { kind: "dc", shift: num(p.shift, 0) };
    default:
      return null;
  }
}

interface Piece {
  a: number;
  b: number;
  e: AudioEffect;
}

interface Region {
  a: number;
  b: number;
  effects: AudioEffect[];
}

function sortByRank(list: AudioEffect[]): AudioEffect[] {
  return [...list].sort((x, y) => FX_RANK[x.kind as RangeEffectKind] - FX_RANK[y.kind as RangeEffectKind] || x.id.localeCompare(y.id));
}

export interface FxRegionsResult {
  regions: FxRegion[];
  /** 引擎還不支援、這一趟不會處理的效果（要列出來，不能默默少掉）。 */
  unsupported: AudioEffect[];
}

/**
 * 來源時間的範圍效果 → 成品時間的區域。
 * segs / joins 就是 RenderPlan 送給 Rust 的那一份（成品長度帳與 planOutFrames 同源）。
 */
export function fxRegionsToOut(effects: readonly AudioEffect[], segs: SegSpan[], joins: JoinSpec[]): FxRegionsResult {
  const range = effects.filter(isRangeEffect);
  const supported = range.filter((e) => toRenderFx(e) !== null);
  const unsupported = range.filter((e) => toRenderFx(e) === null);
  if (!supported.length || !segs.length) return { regions: [], unsupported };

  const outStart = segOutStartFrames(segs, joins);
  const pieces: Piece[] = [];
  for (const e of supported) {
    const e0 = msToFrames(Math.min(e.startMs, e.endMs));
    const e1 = msToFrames(Math.max(e.startMs, e.endMs));
    if (e1 <= e0) continue;
    for (let i = 0; i < segs.length; i++) {
      const s0 = msToFrames(segs[i].startMs);
      const s1 = msToFrames(segs[i].endMs);
      const ov0 = Math.max(e0, s0);
      const ov1 = Math.min(e1, s1);
      if (ov1 <= ov0) continue;
      pieces.push({ a: outStart[i] + (ov0 - s0), b: outStart[i] + (ov1 - s0), e });
    }
  }
  if (!pieces.length) return { regions: [], unsupported };

  // 邊界掃描：所有起訖點切成基本區間，每個區間看哪些效果蓋到它
  const bounds = [...new Set(pieces.flatMap((p) => [p.a, p.b]))].sort((x, y) => x - y);
  const raw: Region[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const x0 = bounds[i];
    const x1 = bounds[i + 1];
    const active = pieces.filter((p) => p.a <= x0 && p.b >= x1).map((p) => p.e);
    if (!active.length) continue;
    // 同一效果跨兩個 seg 會有兩個 piece 落在同一區間（crossfade 重疊區），去重
    const uniq = sortByRank([...new Map(active.map((e) => [e.id, e])).values()]);
    const key = uniq.map((e) => e.id).join("|");
    const prev = raw[raw.length - 1];
    if (prev && prev.b === x0 && prev.effects.map((e) => e.id).join("|") === key) prev.b = x1;
    else raw.push({ a: x0, b: x1, effects: uniq });
  }

  // 丟掉放不下兩端交叉的碎片
  const kept = raw.filter((r) => r.b - r.a >= FX_MIN_REGION_FRAMES);
  // 收掉短於 XF 的縫：前一段延到後一段起點（0 = 兩段相接，Rust 端會 wet→wet 交叉）
  for (let i = 0; i + 1 < kept.length; i++) {
    const gap = kept[i + 1].a - kept[i].b;
    if (gap > 0 && gap < FX_XF_FRAMES) kept[i].b = kept[i + 1].a;
  }

  const regions: FxRegion[] = kept.map((r) => ({
    out_start_ms: framesToMs(r.a),
    out_end_ms: framesToMs(r.b),
    chain: r.effects.map((e) => toRenderFx(e)).filter((x): x is RenderRangeFx => x !== null),
    effectIds: r.effects.map((e) => e.id),
    correlated: !r.effects.some((e) => FX_UNCORRELATED.includes(e.kind as RangeEffectKind)),
  }));
  return { regions, unsupported };
}

/** 一個範圍效果在成品裡總共蓋了幾個 frame（不含被丟掉的碎片）—— 測試與 UI 摘要用。 */
export function coveredFrames(regions: readonly FxRegion[], effectId: string): number {
  let n = 0;
  for (const r of regions) if (r.effectIds.includes(effectId)) n += msToFrames(r.out_end_ms) - msToFrames(r.out_start_ms);
  return n;
}
