// 來源時間 ↔ 成品時間的換算，以及「接縫在成品的哪裡」。
//
// A-B 切換要靠這個才能保住位置：從原始切到剪後時，聽的人在意的是「同一句話」，
// 不是「同一個秒數」。接縫巡覽也要靠它才知道要跳到成品的哪一秒。
//
// 依據是 EDL 的 keeps 已經帶了 outStartMs / outEndMs（R3 之後那是含接點帳的真值），
// 所以這裡只做查表與線性內插，不再自己算一次長度。
import type { Edl, Join, KeepSegment } from "./build";
import { srcToOutArranged, type ArrangedKeep } from "./arrange";

/** keeps 有沒有離開「依來源時間遞增」的排列（貼上 / 搬移會打破它）。 */
export function isRearrangedKeeps(keeps: readonly KeepSegment[]): boolean {
  for (let i = 1; i < keeps.length; i++) {
    if (keeps[i].srcStartMs < keeps[i - 1].srcStartMs) return true;
  }
  return (keeps as readonly ArrangedKeep[]).some((k) => k.pasteId != null);
}

/**
 * 這個接縫是「編排」造成的（剪下貼上 / 搬移），不是「剪掉一段」。
 *
 * 兩者長得像但完全不是同一件事，而且分不出來的後果是**安靜改錯東西**：
 * 一般接縫的兩邊在來源上相鄰，中間那段就是被剪掉的內容，所以修剪＝改那段剪除區；
 * 編排接縫的兩邊來自來源的兩個地方，中間**沒有**被剪掉的東西 ——
 * 拿 `srcBeforeMs` / `srcAfterMs` 去找剪除區時，因為 `srcAfterMs < srcBeforeMs`，
 * 比對條件會變成恆真，於是找到一個完全不相干的剪除區、改掉它的候選。
 *
 * 兩種情況都算：來源往回跳（搬移），或任一邊是貼上來的（貼上是**插入**，不是剪除）。
 */
export function isArrangementSeam(before: KeepSegment, after: KeepSegment): boolean {
  const a = before as ArrangedKeep;
  const b = after as ArrangedKeep;
  return after.srcStartMs < before.srcEndMs || a.pasteId != null || b.pasteId != null;
}

/** 落在剪除區時要往哪邊靠。 */
export type SnapDirection = "next" | "prev";

/**
 * 來源時間 → 成品時間。
 * srcMs 落在剪除區（沒有任何 keep 覆蓋）時，依 snap 靠到下一段的開頭或前一段的結尾。
 */
export function mapSrcToOut(keeps: KeepSegment[], srcMs: number, snap: SnapDirection = "next"): number {
  if (!keeps.length) return 0;
  // 重排過的 EDL（有貼上 / 搬移）不能用下面這條「依來源順序掃、回第一個命中」的捷徑 ——
  // 它會安靜地回錯的位置，而字幕、章節、節目筆記全都吃這一支。
  //
  // 在這裡分流而不是改每一個呼叫端的簽章：呼叫端有十幾處，漏掉一處就是一個
  // 「錯得很安靜」的 bug，而且測試不一定抓得到。沒有重排時走原本的路徑，逐位元相同。
  if (isRearrangedKeeps(keeps)) return srcToOutArranged(keeps, srcMs, snap);
  if (srcMs <= keeps[0].srcStartMs) return keeps[0].outStartMs;
  const last = keeps[keeps.length - 1];
  if (srcMs >= last.srcEndMs) return last.outEndMs;
  for (let i = 0; i < keeps.length; i++) {
    const k = keeps[i];
    if (srcMs < k.srcStartMs) {
      // 在 keeps[i-1] 與 keeps[i] 之間的剪除區
      return snap === "next" ? k.outStartMs : keeps[i - 1].outEndMs;
    }
    if (srcMs <= k.srcEndMs) return k.outStartMs + (srcMs - k.srcStartMs);
  }
  return last.outEndMs;
}

/** 成品時間 → 來源時間。落在 gap（room tone）裡就回下一段的起點。 */
export function mapOutToSrc(keeps: KeepSegment[], outMs: number): number {
  if (!keeps.length) return 0;
  if (outMs <= keeps[0].outStartMs) return keeps[0].srcStartMs;
  const last = keeps[keeps.length - 1];
  if (outMs >= last.outEndMs) return last.srcEndMs;
  for (let i = 0; i < keeps.length; i++) {
    const k = keeps[i];
    if (outMs < k.outStartMs) return k.srcStartMs; // gap 裡
    if (outMs <= k.outEndMs) return k.srcStartMs + (outMs - k.outStartMs);
  }
  return last.srcEndMs;
}

export interface Seam {
  index: number;
  /** 接的是哪一段之後。 */
  afterKeepId: number;
  kind: Join["kind"];
  /** 成品時間軸上的接點位置（前一段結束＝後一段開始）。 */
  outMs: number;
  /** 來源時間軸上被剪掉的那一段。 */
  srcBeforeMs: number;
  srcAfterMs: number;
  /** 這一刀剪掉多久。`rearranged` 為 true 時是 0 而且沒有意義 —— 那裡沒有剪掉東西。 */
  removedMs: number;
  /** 編排（剪下貼上 / 搬移）造成的接縫，不是剪除。見 `isArrangementSeam`。 */
  rearranged: boolean;
  /** 造成這個接縫的候選（可以在巡覽時當場改判保留）。 */
  candidateIds: string[];
}

/** 成品裡所有接縫，依成品時間排序。seam（響度單元邊界）不算 —— 那裡沒有剪東西。 */
export function seamsOf(edl: Edl): Seam[] {
  const byId = new Map(edl.keeps.map((k) => [k.id, k]));
  const out: Seam[] = [];
  for (const j of edl.joins) {
    const k = byId.get(j.afterKeepId);
    if (!k) continue;
    const nextIdx = edl.keeps.findIndex((x) => x.id === j.afterKeepId) + 1;
    const next = edl.keeps[nextIdx];
    if (!next) continue;
    const rearranged = isArrangementSeam(k, next);
    out.push({
      index: out.length,
      afterKeepId: j.afterKeepId,
      kind: j.kind,
      outMs: k.outEndMs,
      srcBeforeMs: k.srcEndMs,
      srcAfterMs: next.srcStartMs,
      // 編排接縫沒有「剪掉多久」可言。以前這裡是 Math.max(0, …)，
      // 把負數夾成 0 之後畫面上就寫著「剪掉 0.00s」—— 那是一句謊話。
      removedMs: rearranged ? 0 : next.srcStartMs - k.srcEndMs,
      rearranged,
      candidateIds: j.removedCandidateIds,
    });
  }
  out.sort((a, b) => a.outMs - b.outMs);
  out.forEach((s, i) => (s.index = i));
  return out;
}

/** 巡覽某個接縫時要播成品的哪一段（前後各留 padMs）。 */
export function seamWindow(s: Seam, padMs = 1200): { startMs: number; endMs: number } {
  return { startMs: Math.max(0, s.outMs - padMs), endMs: s.outMs + padMs };
}

/** 從目前成品位置找下一個 / 上一個接縫。 */
export function seamNear(seams: Seam[], outMs: number, dir: 1 | -1): Seam | null {
  if (!seams.length) return null;
  if (dir > 0) return seams.find((s) => s.outMs > outMs + 1) ?? null;
  return [...seams].reverse().find((s) => s.outMs < outMs - 1) ?? null;
}
