import { t } from "../i18n";
import { denoiseDbFor } from "./cleanup";
import { rangeLoudness } from "./meter";
import type { LocalAnalysis } from "./peaks";

/**
 * 零 Rust 的音量工具：從 analysis.bin（5 ms 桶的 i8 min/max、u8 RMS）算出「該加幾 dB」，
 * 結果都是既有的 gain 效果 —— 峰值正規化、響度對齊、降噪建議值、噪音樣本。
 *
 * **量化誠實**：i8 是 round(v·127)。滿刻度附近 ±0.035 dB；−20 dBFS（q≈13）±0.34 dB；
 * −30 dBFS（q≈4）±1.1 dB；−40 dBFS（q=1）±5 dB。所以 q < 8 的峰值只能算 heuristic，
 * 畫面上要說「這段太小聲，分析解析度不夠」，而不是印一個看起來很準的數字。
 */

export type Confidence = "measured" | "heuristic" | "default";

export interface GainSuggestion {
  db: number;
  summary: string;
  confidence: Confidence;
}

export interface NoisePrint {
  startMs: number;
  endMs: number;
  /** 這段的 RMS 底噪（dBFS）。 */
  floorDb: number;
  at: number;
}

/** 桶索引範圍（含頭不含尾），夾在分析長度內。 */
function bucketRange(a: LocalAnalysis, fromMs: number, toMs: number): [number, number] {
  const b0 = Math.max(0, Math.floor((Math.min(fromMs, toMs) / 1000) * a.pps));
  const b1 = Math.min(a.nBuckets, Math.ceil((Math.max(fromMs, toMs) / 1000) * a.pps));
  return [b0, Math.max(b0, b1)];
}

export function rmsU8ToDb(v: number): number {
  return -60 + (v / 255) * 60;
}

/** 範圍內的峰值：q = i8 的最大絕對值（0..127），db = 20·log10(q/127)。空範圍 q=0、db=−Infinity。 */
export function rangePeak(a: LocalAnalysis, fromMs: number, toMs: number): { db: number; q: number } {
  const [b0, b1] = bucketRange(a, fromMs, toMs);
  let q = 0;
  for (let i = b0; i < b1; i++) {
    const m = Math.max(Math.abs(a.mins[i]), Math.abs(a.maxs[i]));
    if (m > q) q = m;
  }
  return { q, db: q > 0 ? 20 * Math.log10(q / 127) : -Infinity };
}

/** 峰值量化誤差（±dB）：半個量化階在 q 附近換算成 dB。 */
export function peakUncertaintyDb(q: number): number {
  if (q <= 0) return Infinity;
  return (20 * Math.log10((q + 0.5) / Math.max(0.5, q - 0.5))) / 2;
}

/** 範圍內的 RMS（功率平均）dBFS。 */
export function rmsDbRange(a: LocalAnalysis, fromMs: number, toMs: number): number {
  const [b0, b1] = bucketRange(a, fromMs, toMs);
  if (b1 <= b0) return -60;
  let sum = 0;
  for (let i = b0; i < b1; i++) sum += Math.pow(10, rmsU8ToDb(a.rmsU8[i]) / 10);
  return 10 * Math.log10(Math.max(1e-9, sum / (b1 - b0)));
}

/** 範圍內 RMS 桶的百分位（0–1）；直方圖法（rmsU8 只有 256 種值）。 */
export function percentileDbRange(a: LocalAnalysis, fromMs: number, toMs: number, p: number): number {
  const [b0, b1] = bucketRange(a, fromMs, toMs);
  const n = b1 - b0;
  if (n <= 0) return -60;
  const hist = new Uint32Array(256);
  for (let i = b0; i < b1; i++) hist[a.rmsU8[i]]++;
  const target = Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))));
  let seen = 0;
  for (let v = 0; v < 256; v++) {
    seen += hist[v];
    if (seen > target) return rmsU8ToDb(v);
  }
  return rmsU8ToDb(255);
}

const fmt = (db: number) => `${db >= 0 ? "+" : ""}${db.toFixed(1)}`;

/** 峰值正規化：把範圍內最大聲拉到 targetDbfs。q < 8 只能算 heuristic。 */
export function peakNormalizeGainDb(a: LocalAnalysis | null, fromMs: number, toMs: number, targetDbfs = -1): GainSuggestion | null {
  if (!a) return null;
  const { db, q } = rangePeak(a, fromMs, toMs);
  if (!Number.isFinite(db)) return { db: 0, summary: t("這段是靜音，沒有峰值可以對齊"), confidence: "default" };
  const gain = Math.max(-40, Math.min(40, targetDbfs - db));
  const unc = peakUncertaintyDb(q);
  if (q >= 8) {
    return {
      db: gain,
      summary: t("峰值 {peak} dBFS → {target} dBFS，增益 {gain} dB（±{unc}）", { peak: db.toFixed(1), target: targetDbfs, gain: fmt(gain), unc: unc.toFixed(2) }),
      confidence: "measured",
    };
  }
  return {
    db: gain,
    summary: t("這段太小聲（峰值約 {peak} dBFS），分析解析度不夠（±{unc} dB）；建議改用「響度對齊」", { peak: db.toFixed(0), unc: unc.toFixed(1) }),
    confidence: "heuristic",
  };
}

/** 響度對齊：ref = "episode" 對齊到整集平均，或給一個 LUFS 數字。 */
export function matchLoudnessGainDb(a: LocalAnalysis | null, fromMs: number, toMs: number, ref: "episode" | number): GainSuggestion | null {
  if (!a) return null;
  const r = rangeLoudness(a, fromMs, toMs, typeof ref === "number" ? ref : -16);
  if (r.silent) return { db: 0, summary: t("這段是靜音，量不到響度"), confidence: "default" };
  if (ref === "episode") {
    if (r.vsEpisodeLu == null) return { db: 0, summary: t("整集量不到響度"), confidence: "default" };
    const gain = Math.max(-24, Math.min(24, -r.vsEpisodeLu));
    // 「大 / 小」拆成兩把 key：別的語言不一定能只換一個字
    const p = { lufs: r.lufs.toFixed(1), lu: Math.abs(r.vsEpisodeLu).toFixed(1), gain: fmt(gain) };
    return {
      db: gain,
      summary: r.vsEpisodeLu >= 0 ? t("這段 {lufs} LUFS，比整集大 {lu} LU → 增益 {gain} dB", p) : t("這段 {lufs} LUFS，比整集小 {lu} LU → 增益 {gain} dB", p),
      confidence: "measured",
    };
  }
  const gain = Math.max(-24, Math.min(24, ref - r.lufs));
  return { db: gain, summary: t("這段 {lufs} LUFS → {ref} LUFS，增益 {gain} dB", { lufs: r.lufs.toFixed(1), ref, gain: fmt(gain) }), confidence: "measured" };
}

export const NOISE_PRINT_MIN_MS = 300;
export const NOISE_PRINT_MAX_MS = 5000;
/** p95 − p5 超過這個就不像純底噪（裡面有人講話 / 有聲音起伏）。 */
export const NOISE_PRINT_STEADY_DB = 12;

/** 把一段當噪音樣本：要夠長、夠短、夠平。 */
export function makeNoisePrint(a: LocalAnalysis | null, startMs: number, endMs: number, now = Date.now()): { print: NoisePrint } | { error: string } {
  if (!a) return { error: "還沒有波形分析，量不到底噪" };
  const len = endMs - startMs;
  if (len < NOISE_PRINT_MIN_MS) return { error: "噪音樣本至少要 0.3 秒" };
  if (len > NOISE_PRINT_MAX_MS) return { error: "噪音樣本最多 5 秒，選一段沒人講話的就好" };
  const p5 = percentileDbRange(a, startMs, endMs, 0.05);
  const p95 = percentileDbRange(a, startMs, endMs, 0.95);
  if (p95 - p5 > NOISE_PRINT_STEADY_DB) return { error: "這段裡好像有講話或有起伏，選一段安靜的純底噪" };
  return { print: { startMs, endMs, floorDb: Math.round(rmsDbRange(a, startMs, endMs) * 10) / 10, at: now } };
}

export interface DenoiseSuggestion {
  nrDb: number;
  nfDb: number;
  summary: string;
  confidence: Confidence;
}

/** 降噪建議值：噪音樣本 > 選取範圍的 5% 百分位 > 整檔的 5% 百分位。 */
export function suggestDenoise(a: LocalAnalysis | null, range: { startMs: number; endMs: number } | null, print: NoisePrint | null): DenoiseSuggestion {
  if (print) {
    const nr = denoiseDbFor(print.floorDb);
    const floor = print.floorDb.toFixed(1);
    return {
      nrDb: nr,
      nfDb: Math.round(print.floorDb),
      summary: nr ? t("噪音樣本 {floor} dBFS → 降噪 {nr} dB", { floor, nr }) : t("噪音樣本 {floor} dBFS，已經夠安靜，不建議降噪", { floor }),
      confidence: "measured",
    };
  }
  if (!a) return { nrDb: 12, nfDb: -50, summary: t("還沒有波形分析，用一般值"), confidence: "default" };
  const floor = range ? percentileDbRange(a, range.startMs, range.endMs, 0.05) : percentileDbRange(a, 0, a.durationMs, 0.05);
  const nr = denoiseDbFor(floor);
  const floorS = floor.toFixed(1);
  return {
    nrDb: nr,
    nfDb: Math.round(Math.max(-80, Math.min(-20, floor))),
    summary: nr ? t("底噪約 {floor} dBFS → 降噪 {nr} dB（選一段純底噪當樣本會更準）", { floor: floorS, nr }) : t("底噪約 {floor} dBFS，已經夠安靜，不建議降噪", { floor: floorS }),
    confidence: "heuristic",
  };
}
