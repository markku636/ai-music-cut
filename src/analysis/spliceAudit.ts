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
  /**
   * 整份成品相對來源的共同延遲（ms）。
   *
   * 修聲的 afftdn / highpass 有 group delay，會把**整個**成品平移幾十毫秒。
   * 那不是接錯段，所以判斷用的是「相對於這個值的偏移」，不是絕對位移。
   */
  systematicLagMs: number;
  summary: string;
  /**
   * 成品混了配樂 / 音效 —— 這時**只看位置不看波形相似度**。
   *
   * 比對的是「成品的能量包絡」對「來源的能量包絡」。成品多了音樂，包絡本來就不一樣，
   * 相關係數會掉到 0.2 以下 —— 那不是接錯段，是成品裡真的多了東西。
   * 實測同一份剪輯：沒有配樂時三段都 0.80–0.92，加上 −18 dB 的配樂之後掉到 0.17，
   * 但位移仍然是 5 ms（位置完全正確）。硬用原本的門檻就會對一個好成品報三個假警報。
   */
  mixedWithOverlays: boolean;
}

/** 互相關搜尋範圍（±ms）與判定門檻。 */
export const MAX_LAG_MS = 60;
export const CORR_OK = 0.75;
export const LAG_OK_MS = 25;
/**
 * 共同延遲大到這個程度就**不當成訊號鏈延遲**，照樣讓每一段失敗。
 *
 * 濾鏡的 group delay 是幾十毫秒等級（實測開修聲之後整份平移 30 ms，少數段 40–50 ms）。
 * 再大就不是濾鏡了，是渲染真的錯位 —— 那要報出來，不能默默扣掉。
 *
 * 上限必須**小於 `MAX_LAG_MS`**：互相關只搜尋 ±60 ms，量不到比這更大的位移，
 * 訂成 100 的話這個條件永遠不會成立（寫過一次，是死碼）。
 * 真的平移超過搜尋範圍時，各段會量到互不相干的假峰值 —— 那會被「多數段落同意」
 * 那個條件擋下來，一樣不會被誤扣。
 */
export const SYSTEMATIC_LAG_MAX_MS = 50;
/** 少於這麼多段就不談「系統性」偏移：兩三段的中位數只是那兩三段，證明不了什麼。 */
export const SYSTEMATIC_MIN_SEGMENTS = 5;
/** 要有這個比例的段落同意，才算得上「整份檔案共同的延遲」。 */
export const SYSTEMATIC_AGREE_RATIO = 0.6;

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
  /** 成品混了配樂 / 音效 —— 只看位置，不看波形相似度（見 SpliceAuditReport.mixedWithOverlays）。 */
  mixedWithOverlays?: boolean;
}

/**
 * 逐段比對：對每個保留段，取來源中段的能量包絡，在成品對應位置 ±maxLag 內找最佳對齊。
 * corr 低 = 這段不是那段（接錯 / 漏段）；lag 大 = 位置偏了（多剪或少剪）。
 */
/** 中位數：拿來當系統性偏移的基準（對離群值免疫，不會被少數真的接錯的段拉走）。 */
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const a = xs.slice().sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

export function auditSplice(src: LocalAnalysis, out: LocalAnalysis, edl: Edl, opts: AuditOptions = {}): SpliceAuditReport {
  // 成品混了配樂時，波形相似度不再是有效的訊號，只有位移還算數
  const mixed = opts.mixedWithOverlays === true;
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
    segments.push({
      index: i,
      srcStartMs: k.srcStartMs,
      outStartMs: k.outStartMs,
      lagMs: Math.round(bestLag),
      corr: Math.round(bestCorr * 1000) / 1000,
      // ok / note 等全部量完、扣掉系統性偏移之後再判（見下方）
      ok: false,
      note: "",
    });
  }

  // ---- 扣掉整份檔案共同的延遲 ----
  //
  // 修聲的 afftdn 是 FFT 降噪，本身就有 group delay；highpass 也有相位延遲。
  // 於是**整個成品**會相對來源平移幾十毫秒 —— 每一段都平移一樣多。
  // 那不是接錯段，是訊號鏈的固定延遲。
  //
  // 實測一集 57 分鐘、開了修聲的成品：662 段裡有 551 段的 lag 剛好是 30 ms、
  // 109 段 40 ms（直方圖幾乎只有一根柱子），相關係數中位數 0.99 ——
  // 每一段都接得好好的，卻有 597 段因為「位置偏了 30 ms」被判失敗。
  // 一鍵粗剪預設就會開修聲，等於每次輸出都收到 600 段的假警報。
  //
  // 所以判斷的對象是**相對於整份檔案的偏移**：共同平移不算錯，
  // 某一段偏離其他段才算。中位數對離群值免疫，正好適合當基準。
  const rawSystematic = median(segments.map((s) => s.lagMs));
  // 要扣掉共同延遲，得先確定它**真的是共同的**，三個條件缺一不可：
  //
  // ① 段數夠多 —— 兩三段的中位數只是那兩三段。段數少時一段接錯就能把中位數拉走，
  //    反而讓真正的錯誤變成新的基準，把自己藏起來。
  // ② 多數段落同意 —— 大部分段的 lag 都貼著中位數，才叫「整份平移」。
  //    如果 lag 散得到處都是，那是剪接真的亂了，不是濾鏡延遲。
  // ③ 幅度像濾鏡 —— 濾鏡的 group delay 是幾十毫秒等級；平移到 100 ms 以上
  //    就不是濾鏡了，是渲染錯位，要報出來不能默默扣掉。
  const agree = segments.filter((x) => Math.abs(x.lagMs - rawSystematic) <= LAG_OK_MS).length;
  const isSystematic =
    segments.length >= SYSTEMATIC_MIN_SEGMENTS &&
    agree / segments.length >= SYSTEMATIC_AGREE_RATIO &&
    Math.abs(rawSystematic) <= SYSTEMATIC_LAG_MAX_MS;
  const systematicLagMs = isSystematic ? rawSystematic : 0;
  for (const seg of segments) {
    const rel = seg.lagMs - systematicLagMs;
    seg.ok = (mixed || seg.corr >= CORR_OK) && Math.abs(rel) <= LAG_OK_MS;
    seg.note = seg.ok
      ? "對得上"
      : seg.corr < CORR_OK
        ? `波形對不上（相似度 ${(seg.corr * 100).toFixed(0)}%）：這段可能剪錯或接錯`
        : `位置比其他段偏了 ${Math.round(rel)} ms`;
  }

  const okCount = segments.filter((s) => s.ok).length;
  // 期望長度要含接點帳：keptMs 是保留段的來源總長，沒扣 crossfade 重疊也沒加 room tone。
  // 用它比對成品每刀會差 20–150 ms，摘要裡的「時長差」就永遠是個假警訊。
  const expected = edl.stats.outMs;
  const durationDeltaMs = Math.round(out.durationMs - expected);
  const note =
    (mixed ? "；成品含配樂，只比對位置" : "") +
    (systematicLagMs !== 0 && Math.abs(systematicLagMs) > 5 ? `；整體延遲 ${systematicLagMs} ms（訊號鏈固定延遲，已扣除）` : "") +
    (!isSystematic && Math.abs(rawSystematic) > SYSTEMATIC_LAG_MAX_MS ? `；整份成品平移了 ${rawSystematic} ms，這不是濾鏡延遲` : "");
  const summary = segments.length
    ? okCount === segments.length
      ? `${segments.length} 段全部對得上（時長差 ${(durationDeltaMs / 1000).toFixed(2)} 秒${note}）`
      : `${segments.length} 段中有 ${segments.length - okCount} 段對不上（時長差 ${(durationDeltaMs / 1000).toFixed(2)} 秒${note}）`
    : "沒有足夠長的段落可比對";
  return { segments, okCount, durationDeltaMs, summary, mixedWithOverlays: mixed, systematicLagMs };
}
