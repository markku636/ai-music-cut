// 對齊後的驗收：guide 與對齊後的檔每 10 秒一個視窗做能量包絡的正規化互相關，看還差幾毫秒。
import { rmsU8ToDb, type LocalAnalysis } from "../peaks";

export interface ResidualRow {
  startMs: number;
  /** 最佳位移（毫秒；正 = 對齊後的檔還落後）。 */
  lagMs: number;
  corr: number;
  /** 兩邊都有聲音才算數。 */
  valid: boolean;
}

export interface ResidualOptions {
  windowMs: number;
  maxLagMs: number;
  quietDb: number;
}

export const DEFAULT_RESIDUAL: ResidualOptions = { windowMs: 10_000, maxLagMs: 150, quietDb: -50 };

function env(a: LocalAnalysis, startMs: number, len: number): Float32Array {
  const b0 = Math.round((startMs / 1000) * a.pps);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const b = b0 + i;
    if (b >= 0 && b < a.nBuckets) {
      const db = rmsU8ToDb(a.rmsU8[b]);
      out[i] = db <= -60 ? 0 : (db + 60) / 60;
    }
  }
  return out;
}

export function ncc(x: Float32Array, y: Float32Array): number {
  const n = Math.min(x.length, y.length);
  if (n < 4) return 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i];
    sy += y[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx;
    const b = y[i] - my;
    sxy += a * b;
    sxx += a * a;
    syy += b * b;
  }
  const d = Math.sqrt(sxx * syy);
  return d > 1e-9 ? sxy / d : 0;
}

export function residualByWindow(guide: LocalAnalysis, aligned: LocalAnalysis, opts: ResidualOptions = DEFAULT_RESIDUAL): ResidualRow[] {
  const rows: ResidualRow[] = [];
  const len = Math.round((opts.windowMs / 1000) * guide.pps);
  const stepMs = 1000 / guide.pps;
  const total = Math.min(guide.durationMs, aligned.durationMs);
  for (let s = 0; s + opts.windowMs <= total; s += opts.windowMs) {
    const ref = env(guide, s, len);
    const loud = (e: Float32Array) => e.some((v) => v > (opts.quietDb + 60) / 60);
    const cand0 = env(aligned, s, len);
    if (!loud(ref) || !loud(cand0)) {
      rows.push({ startMs: s, lagMs: 0, corr: 0, valid: false });
      continue;
    }
    let best = -2;
    let bestLag = 0;
    for (let lag = -opts.maxLagMs; lag <= opts.maxLagMs; lag += stepMs) {
      const c = ncc(ref, env(aligned, s + lag, len));
      if (c > best) {
        best = c;
        bestLag = lag;
      }
    }
    rows.push({ startMs: s, lagMs: Math.round(bestLag), corr: Math.round(best * 1000) / 1000, valid: true });
  }
  return rows;
}

export interface AlignVerdict {
  ok: boolean;
  medianAbsLagMs: number;
  /** 相關性 < 0.5 的視窗比例。 */
  weakRatio: number;
  summary: string;
  /** 最差的視窗（先聽這裡）。 */
  worstAtMs: number | null;
}

export function alignVerdict(rows: ResidualRow[]): AlignVerdict {
  const valid = rows.filter((r) => r.valid);
  if (!valid.length) return { ok: false, medianAbsLagMs: 0, weakRatio: 1, summary: "沒有可以比對的段落（兩邊都太安靜）", worstAtMs: null };
  const lags = valid.map((r) => Math.abs(r.lagMs)).sort((a, b) => a - b);
  const median = lags[lags.length >> 1];
  const weak = valid.filter((r) => r.corr < 0.5);
  const weakRatio = weak.length / valid.length;
  const worst = valid.reduce((a, b) => (Math.abs(b.lagMs) > Math.abs(a.lagMs) ? b : a));
  const ok = median <= 25 && weakRatio <= 0.2;
  const summary = ok
    ? `對齊了：${valid.length} 段中位偏差 ${median} ms`
    : `可能沒對上：${weak.length} 段相關性低、中位偏差 ${median} ms，先聽 ${Math.round(worst.startMs / 1000)} 秒那裡`;
  return { ok, medianAbsLagMs: median, weakRatio, summary, worstAtMs: worst.startMs };
}
