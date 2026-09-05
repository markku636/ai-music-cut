// 來源時間 ↔ 成品時間的換算，以及「接縫在成品的哪裡」。
//
// A-B 切換要靠這個才能保住位置：從原始切到剪後時，聽的人在意的是「同一句話」，
// 不是「同一個秒數」。接縫巡覽也要靠它才知道要跳到成品的哪一秒。
//
// 依據是 EDL 的 keeps 已經帶了 outStartMs / outEndMs（R3 之後那是含接點帳的真值），
// 所以這裡只做查表與線性內插，不再自己算一次長度。
import type { Edl, Join, KeepSegment } from "./build";

/** 落在剪除區時要往哪邊靠。 */
export type SnapDirection = "next" | "prev";

/**
 * 來源時間 → 成品時間。
 * srcMs 落在剪除區（沒有任何 keep 覆蓋）時，依 snap 靠到下一段的開頭或前一段的結尾。
 */
export function mapSrcToOut(keeps: KeepSegment[], srcMs: number, snap: SnapDirection = "next"): number {
  if (!keeps.length) return 0;
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
  /** 這一刀剪掉多久。 */
  removedMs: number;
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
    out.push({
      index: out.length,
      afterKeepId: j.afterKeepId,
      kind: j.kind,
      outMs: k.outEndMs,
      srcBeforeMs: k.srcEndMs,
      srcAfterMs: next.srcStartMs,
      removedMs: Math.max(0, next.srcStartMs - k.srcEndMs),
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
