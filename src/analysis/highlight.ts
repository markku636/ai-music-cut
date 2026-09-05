// 自動精華片段：從能量包絡挑「最像副歌 / 最有內容」的一段，並對齊小節線切出指定長度。
// 剪音樂最常見的需求是「幫我做一個 30 秒版本」；這裡只做選段（純函式），真正的剪除交給既有 EDL / 手動候選。
import type { BeatGrid } from "./beats";
import { rmsU8ToDb, type LocalAnalysis } from "./peaks";

export interface HighlightRange {
  startMs: number;
  endMs: number;
  /** 0–1，這段相對全曲的能量分數。 */
  score: number;
  /** 是否有貼齊小節線。 */
  barAligned: boolean;
  /** 給 UI 的一句話說明。 */
  reason: string;
}

export interface HighlightOptions {
  /** 想要的長度（ms）。 */
  targetMs: number;
  /** 掃描步進（ms），預設 1 秒。 */
  stepMs?: number;
  /** 開頭 / 結尾保留不選的比例（避免抓到前奏或淡出）。 */
  edgeSkipRatio?: number;
  beats?: BeatGrid | null;
}

/** 每 bucket 的能量（線性），用來算視窗平均與變化量。 */
function energyCurve(a: LocalAnalysis): Float32Array {
  const n = a.nBuckets;
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const db = rmsU8ToDb(a.rmsU8[i]);
    e[i] = Math.pow(10, db / 20); // dB → 線性振幅
  }
  return e;
}

/**
 * 找出最精華的一段：以能量平均為主分數，加上「段內有起伏」的加分（純持續噪音不算精華），
 * 再把邊界貼到小節線（有拍網格時）。回傳 null 代表音檔比目標長度還短。
 */
export function findHighlight(a: LocalAnalysis, opts: HighlightOptions): HighlightRange | null {
  const dur = a.durationMs;
  const target = Math.min(opts.targetMs, dur);
  if (dur <= 1000 || target <= 500) return null;
  const step = opts.stepMs ?? 1000;
  const edge = Math.round(dur * (opts.edgeSkipRatio ?? 0.05));
  const e = energyCurve(a);
  const perMs = a.pps / 1000; // bucket per ms

  const idx = (ms: number) => Math.max(0, Math.min(a.nBuckets - 1, Math.round(ms * perMs)));
  // 前綴和 → O(1) 取視窗平均
  const pre = new Float64Array(a.nBuckets + 1);
  for (let i = 0; i < a.nBuckets; i++) pre[i + 1] = pre[i] + e[i];
  const mean = (s: number, t: number) => (t > s ? (pre[t] - pre[s]) / (t - s) : 0);

  const overall = mean(0, a.nBuckets) || 1e-9;
  let best: { startMs: number; score: number } | null = null;
  const lastStart = Math.max(0, dur - target - edge);
  // 素材只比目標長一點點（甚至一樣長）→ 至少要評估一個從 0 開始的視窗
  const firstStart = Math.min(edge, lastStart);
  for (let s = firstStart; s <= lastStart; s += step) {
    const i0 = idx(s);
    const i1 = idx(s + target);
    const m = mean(i0, i1);
    // 段內起伏：把視窗切 8 塊看標準差（副歌通常有律動、不是一片平）
    let variance = 0;
    const parts = 8;
    const seg = (i1 - i0) / parts;
    if (seg >= 2) {
      const ms_: number[] = [];
      for (let k = 0; k < parts; k++) ms_.push(mean(Math.round(i0 + k * seg), Math.round(i0 + (k + 1) * seg)));
      const avg = ms_.reduce((x, y) => x + y, 0) / parts;
      variance = Math.sqrt(ms_.reduce((x, y) => x + (y - avg) ** 2, 0) / parts) / (avg || 1e-9);
    }
    const score = (m / overall) * (1 + Math.min(0.35, variance));
    if (!best || score > best.score) best = { startMs: s, score };
  }
  if (!best) return null;

  let startMs = best.startMs;
  let endMs = Math.min(dur, startMs + target);
  let barAligned = false;
  const g = opts.beats;
  if (g?.periodMs) {
    const barMs = g.periodMs * g.beatsPerBar;
    const k = Math.round((startMs - g.offsetMs) / barMs);
    const snapped = g.offsetMs + k * barMs;
    if (snapped >= 0 && Math.abs(snapped - startMs) <= barMs) {
      startMs = Math.max(0, Math.round(snapped));
      // 長度也取整數小節，讓收尾落在小節線上
      const bars = Math.max(1, Math.round(target / barMs));
      endMs = Math.min(dur, Math.round(startMs + bars * barMs));
      barAligned = true;
    }
  }
  const scoreNorm = Math.max(0, Math.min(1, (best.score - 0.6) / 1.2));
  const reason = barAligned
    ? `能量最集中的一段，起訖已貼齊小節線（${Math.round((endMs - startMs) / 1000)} 秒）`
    : `能量最集中的一段（${Math.round((endMs - startMs) / 1000)} 秒）`;
  return { startMs, endMs, score: scoreNorm, barAligned, reason };
}

/** 常用短版長度（秒）。 */
export const HIGHLIGHT_LENGTHS = [15, 30, 60, 90] as const;
