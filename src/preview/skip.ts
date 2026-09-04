// 跳播的純函式：剪除區間（已合併、排序）上的查詢。
export interface Range {
  startMs: number;
  endMs: number;
}

/** ms 落在哪個剪除區（索引）；沒有回 -1。 */
export function cutIndexAt(cuts: Range[], ms: number): number {
  let lo = 0;
  let hi = cuts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cuts[mid];
    if (ms < c.startMs) hi = mid - 1;
    else if (ms >= c.endMs) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** 若 ms 在剪除區內 → 回該區結束點（可播放的下一點）；否則回 ms。 */
export function nextPlayable(cuts: Range[], ms: number): number {
  const i = cutIndexAt(cuts, ms);
  return i < 0 ? ms : cuts[i].endMs;
}

/** 下一個剪除區的起點（ms 之後）；沒有回 Infinity。 */
export function nextCutStart(cuts: Range[], ms: number): number {
  let lo = 0;
  let hi = cuts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cuts[mid].startMs <= ms) lo = mid + 1;
    else hi = mid;
  }
  return lo < cuts.length ? cuts[lo].startMs : Number.POSITIVE_INFINITY;
}

/** 來源時間 → 剪後時鐘（剪除區內視為該區起點的剪後時間）。 */
export function editedTimeAt(cuts: Range[], ms: number): number {
  let removed = 0;
  for (const c of cuts) {
    if (c.endMs <= ms) removed += c.endMs - c.startMs;
    else if (c.startMs < ms) {
      removed += ms - c.startMs;
      break;
    } else break;
  }
  return Math.max(0, ms - removed);
}
