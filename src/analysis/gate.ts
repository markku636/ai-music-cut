// 串音衰減：一人一軌錄音時，別人講話會從你的麥克風漏進來。
//
// 兩支麥同時開著，每個人的軌都收得到對方（隔一段距離、加上房間殘響）。合成之後
// 同一句話會聽到兩次：一次清楚、一次糊的 —— 那個「糊的」就是讓業餘錄音聽起來
// 像在浴室裡的主因。
//
// 處理方式是「沒在講話的時候把這一軌壓下去」。關鍵不在濾波器，而在**門檻要設在哪**：
// 每支麥的增益、距離、房間都不一樣，寫死一個 dB 值一定有人被切掉氣音、有人完全沒作用。
// 所以門檻由這一軌自己的能量分布量出來 —— 我們本來就有 5 ms 的 RMS 桶。
import type { LocalAnalysis } from "./peaks";
import { rmsU8ToDb } from "./peaks";

export interface GateEstimate {
  /** 這一軌的底噪（含串音）水準。 */
  noiseFloorDb: number;
  /** 這一軌真正在講話時的水準。 */
  speechDb: number;
  /** 建議的門檻：落在底噪與人聲之間。 */
  thresholdDb: number;
  /** 人聲與底噪差多少。太小（< 12 dB）表示這一軌本來就很吵，硬切會傷到內容。 */
  marginDb: number;
}

/** 取 rms 桶的百分位（0–1）。 */
export function percentileDb(a: LocalAnalysis, p: number): number {
  const n = a.nBuckets;
  if (!n) return -60;
  // 直方圖：rmsU8 只有 256 種值，不必排序
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[a.rmsU8[i]]++;
  const target = Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))));
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += hist[v];
    if (seen > target) return rmsU8ToDb(v);
  }
  return rmsU8ToDb(255);
}

export interface GateOptions {
  /** 底噪取第幾百分位（多數時間沒人在這支麥前面講話）。 */
  floorPct: number;
  /** 人聲水準取第幾百分位。 */
  speechPct: number;
  /**
   * 門檻放在底噪與人聲之間的比例（0 = 貼著底噪、1 = 貼著人聲）。
   * 0.35 偏保守：寧可讓一點串音漏過去，也不要把氣音與句尾切掉 ——
   * 被切掉的字救不回來，多一點串音只是稍微不夠乾淨。
   */
  mix: number;
  /** 人聲與底噪至少要差這麼多才值得處理。 */
  minMarginDb: number;
}

export const DEFAULT_GATE: GateOptions = { floorPct: 0.35, speechPct: 0.95, mix: 0.35, minMarginDb: 12 };

export function estimateGate(a: LocalAnalysis, opts: GateOptions = DEFAULT_GATE): GateEstimate {
  const noiseFloorDb = percentileDb(a, opts.floorPct);
  const speechDb = percentileDb(a, opts.speechPct);
  const marginDb = speechDb - noiseFloorDb;
  const thresholdDb = noiseFloorDb + marginDb * opts.mix;
  return { noiseFloorDb, speechDb, thresholdDb, marginDb };
}

/** 這一軌適不適合做串音衰減。差距太小就別動 —— 硬切會傷到內容。 */
export function worthGating(g: GateEstimate, opts: GateOptions = DEFAULT_GATE): boolean {
  return g.marginDb >= opts.minMarginDb;
}

/** dB → 0–1 的線性值（ffmpeg 的 agate 用線性）。 */
export function dbToAmp(db: number): number {
  return Math.min(1, Math.max(0, Math.pow(10, db / 20)));
}

export interface GateSpec {
  /** 低於這個振幅就衰減。 */
  threshold: number;
  /** 衰減到剩多少（0.25 ≈ −12 dB）。不是 0 —— 全靜音會讓房間的呼吸感整個消失，聽起來像斷線。 */
  range: number;
  attackMs: number;
  releaseMs: number;
}

/**
 * 衰減深度（dB，負值）→ agate 的 range。
 *
 * 刻意不給「完全靜音」的選項：串音底下還有房間的空氣聲，把它切到 0 之後，
 * 每次換人講話都會有一個「唰」的空間感落差，比留一點串音更明顯。
 */
export function gateSpec(g: GateEstimate, depthDb: number, attackMs = 5, releaseMs = 260): GateSpec {
  return {
    threshold: dbToAmp(g.thresholdDb),
    range: dbToAmp(Math.min(-3, depthDb)),
    attackMs,
    releaseMs,
  };
}
