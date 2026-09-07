// 把聲音體檢接到 App 的狀態上：拿本機分析與目前的 EDL，回一份摘要給 preflight 用。
//
// 掃描本身是純函式（analysis/audioQc.ts）。這裡只負責「找到資料」與「快取結果」——
// 一次掃描要走過 57 分鐘 × 200 個桶 = 68 萬個桶，開一次輸出對話框掃一次還行，
// 但輸出對話框每改一個欄位就重算一次 preflight，那就會變成每次打字都掃一遍。
import { scanAudio, summarizeQc, DEFAULT_QC, type QcFinding, type QcSummary } from "../analysis/audioQc";
import { useTranscript } from "../store/transcript";
import { edlFor } from "./rules";

export interface QcResult {
  findings: QcFinding[];
  summary: QcSummary;
  /** 各挑一個代表位置（最嚴重的那一筆），讓使用者點下去直接聽。 */
  at: { clipping?: number; levelJump?: number; deadAir?: number };
}

const cache = new Map<string, { key: unknown[]; value: QcResult | null }>();

function sameKey(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * 這一集的聲音體檢。沒有本機分析就回 null ——
 * **null 不等於「乾淨」**，呼叫端要能分辨「沒檢查」與「檢查過沒問題」。
 */
export function qcFor(mediaId: string | null | undefined): QcResult | null {
  if (!mediaId) return null;
  const local = useTranscript.getState().local[mediaId];
  if (!local) return null;
  const edl = edlFor(mediaId);
  const keeps = edl ? edl.keeps.map((k) => ({ startMs: k.srcStartMs, endMs: k.srcEndMs })) : null;

  const key = [local, edl];
  const hit = cache.get(mediaId);
  if (hit && sameKey(hit.key, key)) return hit.value;

  const findings = scanAudio(local, keeps, DEFAULT_QC);
  const worst = (kind: QcFinding["kind"]) => {
    let best: QcFinding | null = null;
    for (const f of findings) if (f.kind === kind && (!best || Math.abs(f.value) > Math.abs(best.value))) best = f;
    return best?.startMs;
  };
  const value: QcResult = {
    findings,
    summary: summarizeQc(findings),
    at: { clipping: worst("clipping"), levelJump: worst("level_jump"), deadAir: worst("dead_air") },
  };
  cache.set(mediaId, { key, value });
  return value;
}

export function clearQcCache(mediaId?: string): void {
  if (mediaId) cache.delete(mediaId);
  else cache.clear();
}
