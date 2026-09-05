// 節拍偵測：從已經算好的 5 ms RMS 桶（analysis.bin）推出 BPM、拍點與小節線。
// 剪音樂跟剪語音最大的差別是「剪在拍子上就順、剪在拍子中間就破」，所以編輯器要有拍網格與貼齊。
// 純函式、不碰 DOM：能量包絡 → 起音（onset）→ 自相關求週期 → 相位對齊 → 拍點清單。
import { rmsU8ToDb, type LocalAnalysis } from "./peaks";

export interface BeatGrid {
  /** 每分鐘拍數（已折算到 60–190 的常用範圍）。 */
  bpm: number;
  /** 一拍多少毫秒。 */
  periodMs: number;
  /** 第一個拍點（ms）。 */
  offsetMs: number;
  /** 0–1，越高代表能量起伏越規律（語音通常很低）。 */
  confidence: number;
  /** 每小節幾拍（目前固定 4/4）。 */
  beatsPerBar: number;
  /** 拍點（ms，含小節第一拍）。 */
  beats: number[];
}

/** 自相關搜尋範圍：60–190 BPM（常見音樂）。 */
const MIN_BPM = 60;
const MAX_BPM = 190;
/** 低於此信心就不該顯示網格（多半是純語音）。 */
export const MIN_BEAT_CONFIDENCE = 0.12;

/** 能量包絡（dB）→ 半波整流的一階差分，就是簡易 onset strength。 */
export function onsetEnvelope(a: LocalAnalysis): { env: Float32Array; hopMs: number } {
  const hopMs = 1000 / a.pps;
  const n = a.nBuckets;
  const env = new Float32Array(n);
  let prev = rmsU8ToDb(a.rmsU8[0] ?? 0);
  for (let i = 1; i < n; i++) {
    const db = rmsU8ToDb(a.rmsU8[i]);
    const d = db - prev;
    env[i] = d > 0 ? d : 0;
    prev = db;
  }
  // 3 格移動平均，壓掉單點雜訊
  const sm = new Float32Array(n);
  for (let i = 1; i < n - 1; i++) sm[i] = (env[i - 1] + env[i] + env[i + 1]) / 3;
  return { env: sm, hopMs };
}

/** 對 env 做自相關，回 [lag格數 → 分數]（已扣掉平均、正規化到 0–1）。 */
export function autocorrelate(env: Float32Array, minLag: number, maxLag: number): Float32Array {
  const n = env.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= Math.max(1, n);
  const out = new Float32Array(maxLag + 1);
  let best = 1e-9;
  for (let lag = minLag; lag <= maxLag && lag < n; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += (env[i] - mean) * (env[i - lag] - mean);
    const v = s / (n - lag);
    out[lag] = v;
    if (v > best) best = v;
  }
  for (let lag = minLag; lag <= maxLag; lag++) out[lag] = Math.max(0, out[lag] / best);
  return out;
}

/** 找出最佳週期（格數）；優先選能量最高、且倍/半週期也有支撐的候選。 */
function pickPeriod(ac: Float32Array, minLag: number, maxLag: number): { lag: number; score: number } {
  let bestLag = minLag;
  let bestScore = -1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    // 局部極大值才算候選
    if (ac[lag] < ac[lag - 1] || ac[lag] < ac[lag + 1]) continue;
    const half = Math.round(lag / 2);
    const dbl = lag * 2;
    const support = ac[lag] + 0.35 * (half >= minLag ? ac[half] : 0) + 0.35 * (dbl <= maxLag ? ac[dbl] : 0);
    if (support > bestScore) {
      bestScore = support;
      bestLag = lag;
    }
  }
  return { lag: bestLag, score: Math.max(0, Math.min(1, bestScore / 1.7)) };
}

/** 在一個週期內找最對齊的相位（讓拍點落在能量突起上）。 */
function pickPhase(env: Float32Array, lag: number): number {
  let bestOff = 0;
  let bestSum = -1;
  for (let off = 0; off < lag; off++) {
    let s = 0;
    for (let i = off; i < env.length; i += lag) s += env[i];
    if (s > bestSum) {
      bestSum = s;
      bestOff = off;
    }
  }
  return bestOff;
}

/** BPM 折算到常用範圍（避免抓到半拍 / 倍拍）。 */
export function foldBpm(bpm: number): number {
  let v = bpm;
  while (v < MIN_BPM) v *= 2;
  while (v > MAX_BPM) v /= 2;
  return v;
}

export interface DetectOptions {
  /** 只分析前 N 秒（長曲子夠用且快）。 */
  maxAnalyzeSec?: number;
  beatsPerBar?: number;
}

/** 從本機分析（RMS 桶）偵測拍點。信心過低時仍回結果，由 UI 決定要不要顯示。 */
export function detectBeats(a: LocalAnalysis, opts: DetectOptions = {}): BeatGrid {
  const { env, hopMs } = onsetEnvelope(a);
  const maxSec = opts.maxAnalyzeSec ?? 120;
  const limit = Math.min(env.length, Math.round((maxSec * 1000) / hopMs));
  const slice = env.subarray(0, limit);
  const minLag = Math.max(2, Math.round(60000 / MAX_BPM / hopMs));
  const maxLag = Math.min(slice.length - 2, Math.round(60000 / MIN_BPM / hopMs));
  if (maxLag <= minLag) {
    return { bpm: 0, periodMs: 0, offsetMs: 0, confidence: 0, beatsPerBar: opts.beatsPerBar ?? 4, beats: [] };
  }
  const ac = autocorrelate(slice, minLag, maxLag);
  const { lag, score } = pickPeriod(ac, minLag, maxLag);
  const off = pickPhase(slice, lag);
  const periodMs = lag * hopMs;
  const bpm = foldBpm(60000 / periodMs);
  const foldedPeriod = 60000 / bpm;
  const offsetMs = off * hopMs;
  const beats: number[] = [];
  for (let t = offsetMs; t <= a.durationMs; t += foldedPeriod) beats.push(Math.round(t));
  return {
    bpm: Math.round(bpm * 10) / 10,
    periodMs: foldedPeriod,
    offsetMs: Math.round(offsetMs),
    confidence: score,
    beatsPerBar: opts.beatsPerBar ?? 4,
    beats,
  };
}

/** 人工修正：AI 抓錯拍時使用者的調整（倍/半速、相位平移）。 */
export interface GridOverride {
  /** 週期倍率：2 = 拍子變兩倍密（BPM ×2）、0.5 = 減半。 */
  bpmScale: number;
  /** 相位平移（ms），指定某處為小節首拍時用。 */
  offsetDeltaMs: number;
}

export const NO_OVERRIDE: GridOverride = { bpmScale: 1, offsetDeltaMs: 0 };

/** 把人工修正套到偵測結果上（重算拍點）。 */
export function applyOverride(g: BeatGrid | null, ov: GridOverride, durationMs?: number): BeatGrid | null {
  if (!g || !g.periodMs) return g;
  if (ov.bpmScale === 1 && ov.offsetDeltaMs === 0) return g;
  const periodMs = g.periodMs / ov.bpmScale;
  const offsetMs = g.offsetMs + ov.offsetDeltaMs;
  const dur = durationMs ?? (g.beats.length ? g.beats[g.beats.length - 1] : 0);
  const beats: number[] = [];
  const first = offsetMs - Math.floor(offsetMs / periodMs) * periodMs;
  for (let t = first; t <= dur; t += periodMs) beats.push(Math.round(t));
  return { ...g, bpm: Math.round((60000 / periodMs) * 10) / 10, periodMs, offsetMs, beats };
}

/** 敲拍測速：取最近幾次間隔的中位數（丟掉離群 > 1.6 倍中位數者）。至少 3 下才回 BPM。 */
export function tapTempo(times: number[]): number | null {
  if (times.length < 3) return null;
  const recent = times.slice(-8);
  const gaps: number[] = [];
  for (let i = 1; i < recent.length; i++) gaps.push(recent[i] - recent[i - 1]);
  const sorted = gaps.slice().sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const good = gaps.filter((g) => g > med / 1.6 && g < med * 1.6);
  if (!good.length) return null;
  const avg = good.reduce((a, b) => a + b, 0) / good.length;
  if (avg < 200 || avg > 2000) return null;
  return Math.round(foldBpm(60000 / avg) * 10) / 10;
}

/** 貼齊：把時間點吸到最近的拍點（超過 tolerance 就不動）。 */
export function snapToBeat(grid: BeatGrid | null, ms: number, toleranceMs = 120): number {
  if (!grid || !grid.periodMs || grid.confidence < MIN_BEAT_CONFIDENCE) return ms;
  const k = Math.round((ms - grid.offsetMs) / grid.periodMs);
  const snapped = grid.offsetMs + k * grid.periodMs;
  return Math.abs(snapped - ms) <= toleranceMs ? Math.max(0, Math.round(snapped)) : ms;
}

/** 這個拍點是不是小節第一拍。 */
export function isDownbeat(grid: BeatGrid, beatMs: number): boolean {
  if (!grid.periodMs) return false;
  const k = Math.round((beatMs - grid.offsetMs) / grid.periodMs);
  return ((k % grid.beatsPerBar) + grid.beatsPerBar) % grid.beatsPerBar === 0;
}
