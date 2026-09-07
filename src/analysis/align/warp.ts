// DTW 路徑 → 可以渲染的 warp：拉直靜音、tightness 平滑、簡化、切成速率段。
//
// warp 的表示法：一串 (dubMs, guideMs) 點，單調遞增；dub 時間 t 要播到 guide 時間 warpAt(t)。
// 渲染端（Rust align.rs）吃「分段固定速率」：每段 [dubStart, dubEnd) 用 rate = Δguide / Δdub 的 atempo。

export interface WarpPoint {
  dubMs: number;
  guideMs: number;
}

export interface WarpSegment {
  dubStartMs: number;
  dubEndMs: number;
  /** atempo 的倍率：> 1 = 這段 dub 要縮短（講太慢）；< 1 = 拉長。 */
  rate: number;
}

/** DTW 的 (i, j) 路徑 → 毫秒點。同一個 i 或 j 連續出現時只留第一個（避免 0 長度段）。 */
export function pathToWarp(path: [number, number][], guideHopMs: number, dubHopMs: number, guideStartMs = 0, dubStartMs = 0): WarpPoint[] {
  const out: WarpPoint[] = [];
  let lastI = -1;
  let lastJ = -1;
  for (const [i, j] of path) {
    if (i === lastI || j === lastJ) continue;
    out.push({ dubMs: dubStartMs + j * dubHopMs, guideMs: guideStartMs + i * guideHopMs });
    lastI = i;
    lastJ = j;
  }
  return out;
}

/** 在 dub 時間 t 對應的 guide 時間（線性內插；範圍外用最近一段的斜率外推）。 */
export function warpAt(points: readonly WarpPoint[], dubMs: number): number {
  if (!points.length) return dubMs;
  if (points.length === 1) return dubMs + (points[0].guideMs - points[0].dubMs);
  if (dubMs <= points[0].dubMs) {
    const [a, b] = [points[0], points[1]];
    const r = (b.guideMs - a.guideMs) / Math.max(1e-6, b.dubMs - a.dubMs);
    return a.guideMs + (dubMs - a.dubMs) * r;
  }
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].dubMs <= dubMs) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const r = (b.guideMs - a.guideMs) / Math.max(1e-6, b.dubMs - a.dubMs);
  return a.guideMs + (dubMs - a.dubMs) * r;
}

/**
 * 兩邊都安靜 ≥ minMs 的段落拉直：中間的點丟掉，差異吸收在沒人聽的地方。
 * `quiet(dubMs, guideMs)` 由呼叫端提供（看兩邊特徵是否都為 0）。
 */
export function straightenSilence(points: readonly WarpPoint[], quiet: (p: WarpPoint) => boolean, minMs = 150): WarpPoint[] {
  if (points.length < 3) return [...points];
  const out: WarpPoint[] = [points[0]];
  let runStart = -1;
  for (let i = 1; i < points.length; i++) {
    const q = quiet(points[i]);
    if (q && runStart < 0) runStart = i;
    if (!q || i === points.length - 1) {
      if (runStart >= 0) {
        const runEnd = q ? i : i - 1;
        const len = points[runEnd].dubMs - points[runStart].dubMs;
        if (len >= minMs) {
          // 只留頭尾，中間拉直
          out.push(points[runStart]);
          if (runEnd !== runStart) out.push(points[runEnd]);
        } else {
          for (let k = runStart; k <= runEnd; k++) out.push(points[k]);
        }
        runStart = -1;
      }
      if (!q) out.push(points[i]);
    }
  }
  return dedupe(out);
}

function dedupe(points: WarpPoint[]): WarpPoint[] {
  const out: WarpPoint[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && (p.dubMs <= last.dubMs || p.guideMs < last.guideMs)) continue;
    out.push(p);
  }
  return out;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Tightness 0–100。先把偏差拆成「線性趨勢」（全域位移 + 時鐘漂移）與「殘差」（逐字的快慢）：
 * 趨勢永遠保留（漂移校正不該被 tightness 削掉），殘差用 W = (100 − T)/100 × 2000 ms 的移動平均平滑再乘 T/100。
 * T=100 → 原封不動（貼到每個字）；T=0 → 只剩趨勢 = 整體位移 + 線性漂移（沒漂移時就等於今天 sync.ts 的結果）。
 */
export function applyTightness(points: readonly WarpPoint[], tightness: number): WarpPoint[] {
  if (!points.length) return [];
  const T = Math.max(0, Math.min(100, tightness)) / 100;
  const n = points.length;
  // 最小平方直線 dev = a + b · dubMs
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    const d = p.guideMs - p.dubMs;
    sx += p.dubMs;
    sy += d;
    sxx += p.dubMs * p.dubMs;
    sxy += p.dubMs * d;
  }
  const den = n * sxx - sx * sx;
  const b = den > 0 ? (n * sxy - sx * sy) / den : 0;
  const a = (sy - b * sx) / n;
  const trend = (dubMs: number) => a + b * dubMs;
  const resid = points.map((p) => p.guideMs - p.dubMs - trend(p.dubMs));
  const W = (1 - T) * 2000;
  const out: WarpPoint[] = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let cnt = 0;
    if (W <= 0) {
      sum = resid[i];
      cnt = 1;
    } else {
      for (let k = i; k >= 0 && points[i].dubMs - points[k].dubMs <= W; k--) {
        sum += resid[k];
        cnt++;
      }
      for (let k = i + 1; k < n && points[k].dubMs - points[i].dubMs <= W; k++) {
        sum += resid[k];
        cnt++;
      }
    }
    const smooth = cnt ? sum / cnt : 0;
    out.push({ dubMs: points[i].dubMs, guideMs: points[i].dubMs + trend(points[i].dubMs) + T * smooth });
  }
  return dedupe(out);
}

/** Douglas-Peucker：在 (dubMs → dev) 曲線上簡化，容差 tolMs。 */
export function simplifyWarp(points: readonly WarpPoint[], tolMs: number): WarpPoint[] {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const dev = (p: WarpPoint) => p.guideMs - p.dubMs;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b - a < 2) continue;
    const da = dev(points[a]);
    const db = dev(points[b]);
    const span = points[b].dubMs - points[a].dubMs;
    let worst = -1;
    let worstIdx = -1;
    for (let k = a + 1; k < b; k++) {
      const f = span > 0 ? (points[k].dubMs - points[a].dubMs) / span : 0;
      const expect = da + (db - da) * f;
      const e = Math.abs(dev(points[k]) - expect);
      if (e > worst) {
        worst = e;
        worstIdx = k;
      }
    }
    if (worst > tolMs && worstIdx > 0) {
      keep[worstIdx] = 1;
      stack.push([a, worstIdx], [worstIdx, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

export interface SegmentOptions {
  /** 段最短幾毫秒（太碎的段合併掉，atempo 切換太密會抖）。 */
  minSegMs: number;
  /** 速率量化（0.005 = 0.5%）。 */
  rateQuant: number;
  /** 速率上下限（atempo 0.5–2）。 */
  clamp: [number, number];
}

export const DEFAULT_SEGMENTS: SegmentOptions = { minSegMs: 250, rateQuant: 0.005, clamp: [0.5, 2] };

/** 點 → 分段固定速率。合併太短的段（併進前一段重算速率）、量化、夾限。 */
export function warpSegments(points: readonly WarpPoint[], opts: SegmentOptions = DEFAULT_SEGMENTS): WarpSegment[] {
  if (points.length < 2) return [];
  const raw: WarpSegment[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dd = b.dubMs - a.dubMs;
    if (dd <= 0) continue;
    raw.push({ dubStartMs: a.dubMs, dubEndMs: b.dubMs, rate: (b.guideMs - a.guideMs) / dd });
  }
  // 合併短段：把 guide 的總位移守住（速率 = 合併後 Δguide / Δdub）
  const merged: WarpSegment[] = [];
  for (const s of raw) {
    const last = merged[merged.length - 1];
    if (last && (last.dubEndMs - last.dubStartMs < opts.minSegMs || s.dubEndMs - s.dubStartMs < opts.minSegMs)) {
      const gLast = last.rate * (last.dubEndMs - last.dubStartMs);
      const gThis = s.rate * (s.dubEndMs - s.dubStartMs);
      last.dubEndMs = s.dubEndMs;
      last.rate = (gLast + gThis) / (last.dubEndMs - last.dubStartMs);
    } else merged.push({ ...s });
  }
  for (const s of merged) {
    const q = Math.round(s.rate / opts.rateQuant) * opts.rateQuant;
    s.rate = Math.max(opts.clamp[0], Math.min(opts.clamp[1], Math.round(q * 1e6) / 1e6));
  }
  // 相鄰同速率合併
  const out: WarpSegment[] = [];
  for (const s of merged) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.rate - s.rate) < 1e-9) last.dubEndMs = s.dubEndMs;
    else out.push({ ...s });
  }
  return out;
}

export interface WarpSummary {
  /** 全域位移（guide − dub 的中位數，毫秒）。 */
  offsetMs: number;
  /** 去掉位移後最大偏差（毫秒）。 */
  maxDeviationMs: number;
  /** 最佳擬合直線的斜率（1 = 沒有漂移；1.0006 = 每小時漂 2 秒）。 */
  slope: number;
  /** 去掉直線後的最大殘差。 */
  maxResidualMs: number;
}

export function summarizeWarp(points: readonly WarpPoint[]): WarpSummary {
  if (points.length < 2) return { offsetMs: points[0] ? points[0].guideMs - points[0].dubMs : 0, maxDeviationMs: 0, slope: 1, maxResidualMs: 0 };
  const devs = points.map((p) => p.guideMs - p.dubMs);
  const offsetMs = median(devs);
  const maxDeviationMs = Math.max(...devs.map((d) => Math.abs(d - offsetMs)));
  // 最小平方直線 guide = slope · dub + b
  const n = points.length;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sx += p.dubMs;
    sy += p.guideMs;
    sxx += p.dubMs * p.dubMs;
    sxy += p.dubMs * p.guideMs;
  }
  const den = n * sxx - sx * sx;
  const slope = den > 0 ? (n * sxy - sx * sy) / den : 1;
  const b = (sy - slope * sx) / n;
  const maxResidualMs = Math.max(...points.map((p) => Math.abs(p.guideMs - (slope * p.dubMs + b))));
  return { offsetMs, maxDeviationMs, slope, maxResidualMs };
}

/** 小漂移走純重取樣就夠：去掉直線後 < 20 ms 且斜率離 1 不到 0.2%（≤ 3.5 cent）。 */
export function resampleOnly(s: WarpSummary): number | null {
  return s.maxResidualMs < 20 && Math.abs(s.slope - 1) <= 0.002 && Math.abs(s.slope - 1) > 1e-6 ? s.slope : null;
}
