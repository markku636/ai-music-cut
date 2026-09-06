import type { Span } from "./clip";

/**
 * 精華合輯：把散在整集裡的好段落串成一支預告。
 *
 * 「只輸出這一段」（`clip.ts`）解的是一個連續範圍；這一支解的是**好幾段不相鄰**的範圍。
 * 差別不只是數量 —— 連續範圍夾完之後，留下來的相鄰單元關係跟夾之前一樣，
 * 所以接點可以原樣沿用；不相鄰的範圍串起來，**每一個範圍交界都是新的接點**，
 * 原本的接點資訊完全不適用。這是這支模組存在的唯一理由。
 */

export interface ReelRange extends Span {
  id: string;
  title?: string;
}

/** 範圍交界的交越長度：比句中接點長得多，因為兩邊在原本的錄音裡毫無關係。 */
export const REEL_CROSSFADE_MS = 120;

/** 太短的範圍串起來只會像雜訊。 */
export const MIN_REEL_RANGE_MS = 300;

/**
 * 排序 + 合併重疊。
 *
 * 重疊的範圍不合併的話，同一段聲音會在合輯裡出現兩次 —— 而且因為中間插了一個交越，
 * 聽起來像結巴。相接（end === start）也要合併，否則會在完全連續的地方插一個交越。
 */
export function normalizeRanges<T extends Span>(ranges: T[]): Span[] {
  const clean = ranges
    .filter((r) => Number.isFinite(r.startMs) && Number.isFinite(r.endMs) && r.endMs - r.startMs >= 1)
    .map((r) => ({ startMs: Math.max(0, r.startMs), endMs: r.endMs }))
    .sort((a, b) => a.startMs - b.startMs);
  const out: Span[] = [];
  for (const r of clean) {
    const last = out[out.length - 1];
    if (last && r.startMs <= last.endMs) last.endMs = Math.max(last.endMs, r.endMs);
    else out.push({ ...r });
  }
  return out;
}

/**
 * 把響度單元夾進多個範圍，依範圍順序串起來。
 *
 * 每個單元帶著它屬於第幾個範圍（`rangeIdx`）——**接點判斷一定要用它**。
 * 不能只看 `keepId`：兩個不同的精華範圍可能落在同一個保留段裡（同一段話挑了兩句），
 * 這時 keepId 相同，接點邏輯會判成「同一段內的單元邊界」而直接對接 ——
 * 聽起來就是中間被硬生生挖掉一塊、沒有任何過渡。
 */
export function clipUnitsMulti<T extends Span>(units: T[], ranges: Span[]): (T & { rangeIdx: number })[] {
  const spans = normalizeRanges(ranges);
  const out: (T & { rangeIdx: number })[] = [];
  spans.forEach((range, rangeIdx) => {
    for (const u of units) {
      const s = Math.max(u.startMs, range.startMs);
      const e = Math.min(u.endMs, range.endMs);
      if (e - s < 1) continue;
      out.push({ ...u, startMs: s, endMs: e, rangeIdx });
    }
  });
  return out;
}

/** 合輯的素材總長（還沒扣掉交越的重疊）。 */
export function reelSourceMs(ranges: Span[]): number {
  return normalizeRanges(ranges).reduce((sum, r) => sum + (r.endMs - r.startMs), 0);
}

/** 這組範圍能不能做成合輯，不行的話說為什麼。 */
export function reelProblem(ranges: ReelRange[]): string | null {
  const spans = normalizeRanges(ranges);
  if (!spans.length) return "還沒有精華片段";
  if (spans.every((r) => r.endMs - r.startMs < MIN_REEL_RANGE_MS)) return "精華片段都太短（至少 0.3 秒）";
  return null;
}
