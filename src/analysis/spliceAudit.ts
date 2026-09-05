// 音訊比對驗收：不靠逐字稿，直接比「成品的能量包絡」跟「EDL 說要保留的來源片段」對不對得上。
// 音樂沒有字可以比，但每一段的能量輪廓是獨一無二的指紋；把成品每段跟來源對應位置做正規化互相關，
// 就能回答：這一段真的是那一段嗎？有沒有偏移？有沒有接錯順序？
import type { Edl } from "./edl/build";
import { rmsU8ToDb, type LocalAnalysis } from "./peaks";

export interface SegmentAudit {
  index: number;
  srcStartMs: number;
  outStartMs: number;
  /** 最佳對齊時的位移（ms）；理想值 0。 */
  lagMs: number;
  /** 正規化互相關 −1..1；1 = 完全吻合。 */
  corr: number;
  ok: boolean;
  note: string;
}

export interface SpliceAuditReport {
  segments: SegmentAudit[];
  okCount: number;
  /** 成品實際長度 − EDL 預估（ms）。 */
  durationDeltaMs: number;
  summary: string;
}

/** 互相關搜尋範圍（±ms）與判定門檻。 */
export const MAX_LAG_MS = 60;
export const CORR_OK = 0.75;
export const LAG_OK_MS = 25;

/** 取一段能量包絡（dB），長度以 bucket 計。 */
function window(a: LocalAnalysis, startMs: number, lenBuckets: number): Float32Array {
  const i0 = Math.max(0, Math.round((startMs / 1000) * a.pps));
  const out = new Float32Array(lenBuckets);
  for (let i = 0; i < lenBuckets; i++) {
    const idx = i0 + i;
    out[i] = idx < a.nBuckets ? rmsU8ToDb(a.rmsU8[idx]) : -60;
  }
  return out;
}

/** 正規化互相關（去平均、除以標準差）；長度不同時取較短者。 */
export function ncc(x: Float32Array, y: Float32Array): number {
  const n = Math.min(x.length, y.length);
  if (n < 4) return 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i];
    my += y[i];
  }
  mx /= n;
  my /= n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx;
    const b = y[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den > 1e-9 ? num / den : 0;
}

export interface AuditOptions {
  /** 每段取多長來比對（ms）。取段落中段，避開接縫模糊區。 */
  probeMs?: number;
  maxLagMs?: number;
}

/**
 * 逐段比對：對每個保留段，取來源中段的能量包絡，在成品對應位置 ±maxLag 內找最佳對齊。
 * corr 低 = 這段不是那段（接錯 / 漏段）；lag 大 = 位置偏了（多剪或少剪）。
 */
export function auditSplice(src: LocalAnalysis, out: LocalAnalysis, edl: Edl, opts: AuditOptions = {}): SpliceAuditReport {
  const probeMs = opts.probeMs ?? 1500;
  const maxLagMs = opts.maxLagMs ?? MAX_LAG_MS;
  const perMs = src.pps / 1000;
  const segments: SegmentAudit[] = [];

  for (const [i, k] of edl.keeps.entries()) {
    const segLen = k.srcEndMs - k.srcStartMs;
    const useMs = Math.min(probeMs, Math.max(200, segLen - 100));
    if (segLen < 250) continue; // 太短的段沒有可比的輪廓
    const mid = (segLen - useMs) / 2;
    const srcAt = k.srcStartMs + mid;
    const outAt = k.outStartMs + mid;
    const lenB = Math.max(8, Math.round(useMs * perMs));
    const ref = window(src, srcAt, lenB);

    let bestCorr = -2;
    let bestLag = 0;
    const stepMs = 1000 / src.pps;
    for (let lagMs = -maxLagMs; lagMs <= maxLagMs; lagMs += stepMs) {
      const cand = window(out, outAt + lagMs, lenB);
      const c = ncc(ref, cand);
      if (c > bestCorr) {
        bestCorr = c;
        bestLag = lagMs;
      }
    }
    const ok = bestCorr >= CORR_OK && Math.abs(bestLag) <= LAG_OK_MS;
    segments.push({
      index: i,
      srcStartMs: k.srcStartMs,
      outStartMs: k.outStartMs,
      lagMs: Math.round(bestLag),
      corr: Math.round(bestCorr * 1000) / 1000,
      ok,
      note: ok
        ? "對得上"
        : bestCorr < CORR_OK
          ? `波形對不上（相似度 ${(bestCorr * 100).toFixed(0)}%）：這段可能剪錯或接錯`
          : `位置偏了 ${Math.round(bestLag)} ms`,
    });
  }

  const okCount = segments.filter((s) => s.ok).length;
  // 期望長度要含接點帳：keptMs 是保留段的來源總長，沒扣 crossfade 重疊也沒加 room tone。
  // 用它比對成品每刀會差 20–150 ms，摘要裡的「時長差」就永遠是個假警訊。
  const expected = edl.stats.outMs;
  const durationDeltaMs = Math.round(out.durationMs - expected);
  const summary = segments.length
    ? okCount === segments.length
      ? `${segments.length} 段全部對得上（時長差 ${(durationDeltaMs / 1000).toFixed(2)} 秒）`
      : `${segments.length} 段中有 ${segments.length - okCount} 段對不上（時長差 ${(durationDeltaMs / 1000).toFixed(2)} 秒）`
    : "沒有足夠長的段落可比對";
  return { segments, okCount, durationDeltaMs, summary };
}
