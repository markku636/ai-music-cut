// 對齊用的特徵：從 analysis.bin（5 ms 桶的 u8 RMS）拉出 0–1 的能量包絡與 onset（能量上升）。
//
// 為什麼不用波形：兩支麥的相位 / 音色 / 增益都不同，樣本層級沒有相關性；能量包絡對音色免疫，
// 而且資料量小 2400 倍。onset 另成一個通道：句子的起頭在兩個 take 裡最一致，
// DTW 靠它「釘」在字的開頭，長母音裡就不會亂走。
import { rmsU8ToDb, type LocalAnalysis } from "../peaks";

export interface AlignFeatures {
  /** 每格的能量 0–1（靜音 = 0）。 */
  rms: Float32Array;
  /** 每格的 onset 強度 0–1（能量比前一格高多少，只取正）。 */
  onset: Float32Array;
  /** 每格幾毫秒。 */
  hopMs: number;
  /** 這份特徵對應來源的起點（毫秒）。 */
  startMs: number;
  /** 靜音門檻（dB）。 */
  quietDb: number;
}

export interface FeatureOptions {
  /** 幾毫秒一格（5 = 原始桶；100 = 粗對齊）。 */
  hopMs: number;
  /** 只取這個範圍（毫秒）。 */
  range?: { startMs: number; endMs: number } | null;
  /** 低於這個 dB 視為靜音 → 0。null = 用第 20 百分位當底噪自動估。 */
  quietDb?: number | null;
}

/** 第 p 百分位的 RMS（dB）。 */
function percentile(a: LocalAnalysis, b0: number, b1: number, p: number): number {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = b0; i < b1; i++) {
    hist[a.rmsU8[i]]++;
    n++;
  }
  if (!n) return -60;
  const target = Math.floor(p * (n - 1));
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += hist[v];
    if (seen > target) return rmsU8ToDb(v);
  }
  return 0;
}

/** 語音特徵：RMS（dB 線性映射到 0–1）+ onset。 */
export function speechFeatures(a: LocalAnalysis, opts: FeatureOptions): AlignFeatures {
  const step = Math.max(1, Math.round((opts.hopMs / 1000) * a.pps));
  const hopMs = (step * 1000) / a.pps;
  const b0 = Math.max(0, Math.floor(((opts.range?.startMs ?? 0) / 1000) * a.pps));
  const b1 = Math.min(a.nBuckets, Math.ceil(((opts.range?.endMs ?? a.durationMs) / 1000) * a.pps));
  const n = Math.max(0, Math.floor((b1 - b0) / step));
  // 底噪：第 20 百分位再加 6 dB 才算「有聲音」；太低會把底噪起伏當成內容拿去對
  const quietDb = opts.quietDb ?? Math.min(-20, percentile(a, b0, b1, 0.2) + 6);
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let peak = 0;
    const s = b0 + i * step;
    for (let k = s; k < s + step && k < b1; k++) if (a.rmsU8[k] > peak) peak = a.rmsU8[k];
    const db = rmsU8ToDb(peak);
    rms[i] = db <= quietDb ? 0 : Math.min(1, (db - quietDb) / -quietDb);
  }
  const onset = new Float32Array(n);
  for (let i = 1; i < n; i++) onset[i] = Math.max(0, rms[i] - rms[i - 1]);
  // onset 正規化到 0–1（用第 95 百分位，不讓單一個爆音把其他都壓扁）
  const sorted = Array.from(onset).filter((v) => v > 0).sort((x, y) => x - y);
  const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 1;
  if (p95 > 0) for (let i = 0; i < n; i++) onset[i] = Math.min(1, onset[i] / p95);
  return { rms, onset, hopMs, startMs: (b0 * 1000) / a.pps, quietDb };
}

/** 兩格特徵的距離（L1，rms 與 onset 各一半）。 */
export function frameDistance(f: AlignFeatures, i: number, g: AlignFeatures, j: number, onsetWeight = 1): number {
  return Math.abs(f.rms[i] - g.rms[j]) + onsetWeight * Math.abs(f.onset[i] - g.onset[j]);
}

/** 兩邊都安靜的格子（拉直用）。 */
export function bothQuiet(f: AlignFeatures, i: number, g: AlignFeatures, j: number): boolean {
  return f.rms[i] === 0 && g.rms[j] === 0;
}
