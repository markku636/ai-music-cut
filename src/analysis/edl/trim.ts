// 漣漪 / 捲動修剪的純算術。
//
// 單軌連續錄音裡，「接縫」就是一段剪除區的兩個邊界，所以修剪＝改那段剪除區：
//   · 漣漪 ripple：只動一邊 → 剪除區變長 / 變短 → 後面整串跟著位移，成品總長改變。
//   · 捲動 roll  ：兩邊一起動、長度不變 → 成品總長不變，只是換掉接縫落在哪。
//
// FCP 還有 slip / slide，但那兩個的前提是「clip 的來源內容與時間軸位置解耦」。
// 單一連續錄音裡來源就是時間軸，滑動沒有意義 —— 要等多軌 / clip 模型才有語意。
export type TrimMode = "ripple" | "roll";
export type TrimSide = "left" | "right";

export interface TrimCandidate {
  id: string;
  startMs: number;
  endMs: number;
}

export interface TrimBounds {
  minMs: number;
  maxMs: number;
}

/** 剪除區最短長度：再短就變成一個沒有意義的碎片，而且 crossfade 公式會退化成 0。 */
export const MIN_REMOVAL_MS = 20;

/**
 * 算出修剪後每個候選的新範圍（只回傳真的有變的）。
 *
 * 一段剪除區可能是好幾個候選合併出來的（buildEdl 步驟 3）。漣漪只動最外側的那一個，
 * 捲動則是整批平移 —— 不然中間的候選會被留在原地，下次重算就散開了。
 */
export function planTrim(cands: TrimCandidate[], deltaMs: number, mode: TrimMode, side: TrimSide, bounds: TrimBounds): TrimCandidate[] {
  if (!cands.length || !deltaMs) return [];
  const sorted = cands.slice().sort((a, b) => a.startMs - b.startMs);

  if (mode === "roll") {
    const lo = Math.min(...sorted.map((c) => c.startMs));
    const hi = Math.max(...sorted.map((c) => c.endMs));
    // 整批一起夾：任何一端頂到邊界，整批就都停住（不然平移會把形狀擠變形）
    const d = Math.max(bounds.minMs - lo, Math.min(deltaMs, bounds.maxMs - hi));
    if (!d) return [];
    return sorted.map((c) => ({ id: c.id, startMs: c.startMs + d, endMs: c.endMs + d }));
  }

  if (side === "left") {
    const first = sorted[0];
    const limit = Math.min(first.endMs, sorted[0].endMs) - MIN_REMOVAL_MS;
    const next = Math.max(bounds.minMs, Math.min(first.startMs + deltaMs, limit));
    return next === first.startMs ? [] : [{ id: first.id, startMs: next, endMs: first.endMs }];
  }

  const last = sorted[sorted.length - 1];
  const floor = last.startMs + MIN_REMOVAL_MS;
  const next = Math.min(bounds.maxMs, Math.max(last.endMs + deltaMs, floor));
  return next === last.endMs ? [] : [{ id: last.id, startMs: last.startMs, endMs: next }];
}

/**
 * 切點上的漣漪修剪：那裡還沒有任何剪除區，所以只能「開始往這一側吃」。
 *
 * 往回拖左把手 = 剪掉切點前面那一段；往前拖右把手 = 剪掉切點後面那一段。
 * 反方向沒有意義：左段的出點往後移就會跟右段的入點重疊，同一段聲音會出現兩次。
 */
export function planSplitRipple(splitMs: number, deltaMs: number, side: TrimSide, bounds: TrimBounds): { startMs: number; endMs: number } | null {
  if (side === "left") {
    if (deltaMs >= 0) return null;
    const start = Math.max(bounds.minMs, splitMs + deltaMs);
    return splitMs - start >= MIN_REMOVAL_MS ? { startMs: start, endMs: splitMs } : null;
  }
  if (deltaMs <= 0) return null;
  const end = Math.min(bounds.maxMs, splitMs + deltaMs);
  return end - splitMs >= MIN_REMOVAL_MS ? { startMs: splitMs, endMs: end } : null;
}
