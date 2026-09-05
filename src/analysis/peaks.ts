// 解析 Rust media.rs 的 analysis.bin（"AIPK"）：波形 min/max/RMS（5 ms 桶）+ 響度視窗（100 ms hop）。
// v3 起每個桶多一個 byte：桶內第一個上升零交越的樣本位移（255 = 沒有）。
// **v2 的檔照樣讀得動**，只是沒有零交越資料 —— 舊專案不必強迫重新分析。
import type { LoudnessWindow } from "./types";

export interface LocalAnalysis {
  version: number;
  pps: number;
  hopMs: number;
  sampleRate: number;
  nBuckets: number;
  nWin: number;
  totalSamples: number;
  durationMs: number;
  /** i8：-127..127 → /127 為振幅。 */
  mins: Int8Array;
  maxs: Int8Array;
  /** u8：0..255 ↔ −60..0 dBFS。 */
  rmsU8: Uint8Array;
  /** f32 × 3 per window：[momentary LUFS, shortTerm LUFS, rms dBFS]。 */
  win: Float32Array;
  /**
   * v3+：每個桶內第一個上升零交越的樣本位移（255 = 這個桶裡沒有）。
   * v2 的檔案沒有這一段，值為 null —— 呼叫端要能接受「這份分析沒有零交越資訊」。
   */
  zx: Uint8Array | null;
}

const MAGIC = 0x4b504941; // "AIPK" little-endian

export class AnalysisFormatError extends Error {}

export function parseAnalysis(buf: ArrayBuffer): LocalAnalysis {
  const dv = new DataView(buf);
  if (buf.byteLength < 36 || dv.getUint32(0, true) !== MAGIC) throw new AnalysisFormatError("analysis.bin 格式不符");
  const version = dv.getUint32(4, true);
  const pps = dv.getUint32(8, true);
  const hopMs = dv.getUint32(12, true);
  const sampleRate = dv.getUint32(16, true);
  const nBuckets = dv.getUint32(20, true);
  const nWin = dv.getUint32(24, true);
  const totalSamples = Number(dv.getBigUint64(28, true));
  let off = 36;
  // v3 每桶 4 byte（多了零交越），v2 是 3 byte
  const perBucket = version >= 3 ? 4 : 3;
  const need = off + nBuckets * perBucket + nWin * 12;
  if (buf.byteLength < need) throw new AnalysisFormatError(`analysis.bin 長度不足（${buf.byteLength} < ${need}）`);
  const mins = new Int8Array(buf, off, nBuckets);
  off += nBuckets;
  const maxs = new Int8Array(buf, off, nBuckets);
  off += nBuckets;
  const rmsU8 = new Uint8Array(buf, off, nBuckets);
  off += nBuckets;
  let zx: Uint8Array | null = null;
  if (version >= 3) {
    zx = new Uint8Array(buf, off, nBuckets);
    off += nBuckets;
  }
  // f32 需 4 對齊：off 可能不對齊 → 複製一份
  const winBytes = buf.slice(off, off + nWin * 12);
  const win = new Float32Array(winBytes);
  return {
    version,
    pps,
    hopMs,
    sampleRate,
    nBuckets,
    nWin,
    totalSamples,
    durationMs: Math.round((totalSamples / sampleRate) * 1000),
    mins,
    maxs,
    rmsU8,
    win,
    zx,
  };
}

/** 這份分析有沒有零交越資料（v2 的舊快取沒有）。 */
export function hasZeroCross(a: LocalAnalysis): boolean {
  return a.zx !== null;
}

/**
 * 找離 ms 最近的上升零交越（±windowMs 內），回毫秒；找不到就回原值。
 *
 * 只在「夠安靜」的地方用：語音正中間的零交越一樣會切在字的中間，
 * 對得再準也還是切壞了。quietDb 就是這道閘門。
 */
export function nearestZeroCrossMs(a: LocalAnalysis, ms: number, windowMs = 3, quietDb = -45): number {
  if (!a.zx) return ms;
  const bucketMs = 1000 / a.pps;
  const samplesPerBucket = a.sampleRate / a.pps;
  const span = Math.max(1, Math.ceil(windowMs / bucketMs));
  const center = Math.floor((ms / 1000) * a.pps);
  let best = ms;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = center - span; i <= center + span; i++) {
    if (i < 0 || i >= a.nBuckets) continue;
    const off = a.zx[i];
    if (off === 255) continue;
    if (rmsU8ToDb(a.rmsU8[i]) > quietDb) continue;
    const at = (i * samplesPerBucket + off) / a.sampleRate * 1000;
    const d = Math.abs(at - ms);
    if (d < bestD && d <= windowMs) {
      bestD = d;
      best = at;
    }
  }
  return best;
}

export function rmsU8ToDb(v: number): number {
  return (v / 255) * 60 - 60;
}

/** 某時刻的桶 RMS（dBFS）；超界回 −120。 */
export function rmsDbAt(a: LocalAnalysis, ms: number): number {
  const i = Math.floor((ms / 1000) * a.pps);
  if (i < 0 || i >= a.nBuckets) return -120;
  return rmsU8ToDb(a.rmsU8[i]);
}

/**
 * [fromMs, toMs] 的平均 RMS（dBFS）；範圍無效回 −120。
 * 在**功率域**平均而不是 dB 域 —— dB 域平均會被一個特別安靜的桶把整段拉低，
 * 判成「這裡是靜音」然後用太短的交叉，接點就會有 click。
 */
export function rmsDbRange(a: LocalAnalysis, fromMs: number, toMs: number): number {
  const lo = Math.max(0, Math.floor((fromMs / 1000) * a.pps));
  const hi = Math.min(a.nBuckets - 1, Math.ceil((toMs / 1000) * a.pps));
  if (hi < lo) return -120;
  let sum = 0;
  let n = 0;
  for (let i = lo; i <= hi; i++) {
    const db = rmsU8ToDb(a.rmsU8[i]);
    sum += 10 ** (db / 10);
    n += 1;
  }
  if (!n) return -120;
  const p = sum / n;
  return p <= 0 ? -120 : 10 * Math.log10(p);
}

/** [fromMs, toMs] 內能量最低的桶中點（EDL 貼邊用）；範圍無效回中點。 */
export function minEnergyPointMs(a: LocalAnalysis, fromMs: number, toMs: number): number {
  const lo = Math.max(0, Math.floor((fromMs / 1000) * a.pps));
  const hi = Math.min(a.nBuckets - 1, Math.floor((toMs / 1000) * a.pps));
  if (hi < lo) return (fromMs + toMs) / 2;
  let best = lo;
  let bestV = 256;
  for (let i = lo; i <= hi; i++) {
    const v = a.rmsU8[i];
    if (v < bestV) {
      bestV = v;
      best = i;
    }
  }
  return ((best + 0.5) / a.pps) * 1000;
}

/** 響度視窗物件陣列（規則層用）。 */
export function loudnessWindows(a: LocalAnalysis): LoudnessWindow[] {
  const out: LoudnessWindow[] = new Array(a.nWin);
  for (let i = 0; i < a.nWin; i++) {
    out[i] = { tMs: i * a.hopMs, momentary: a.win[i * 3], shortTerm: a.win[i * 3 + 1], rmsDb: a.win[i * 3 + 2] };
  }
  return out;
}

/** wavesurfer 雙通道 peaks：[上=max, 下=min]，-1..1。 */
export function wavesurferPeaks(a: LocalAnalysis): [Float32Array, Float32Array] {
  const top = new Float32Array(a.nBuckets);
  const bottom = new Float32Array(a.nBuckets);
  for (let i = 0; i < a.nBuckets; i++) {
    top[i] = Math.max(0, a.maxs[i] / 127);
    bottom[i] = Math.min(0, a.mins[i] / 127);
  }
  return [top, bottom];
}
