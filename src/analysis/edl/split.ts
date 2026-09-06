// 刀片切點套用到保留段。
//
// buildEdl 的步驟 6 算出「補集 → keeps」之後，這裡再把使用者切的刀套上去：
// 一個 keep 被切成兩個相鄰的 keep（srcEndMs === 下一段的 srcStartMs），中間不剪掉任何東西。
//
// 為什麼要獨立一支純函式：切點會改變 keep 的 id 編號，而 Join.afterKeepId、
// loudness 的 splitUnits、render 的 units 全都靠這個編號對位。把「切 + 重新編號 +
// 記錄哪個接縫是切點來的」放在一起，呼叫端就不可能只做一半。
import type { SplitPoint } from "../types";
import type { KeepSegment } from "./build";

export interface SplitSeam {
  splitId: string;
  /** 使用者要求在這一刀插多長的留白（0 = 純對接）。 */
  gapMs: number;
}

export interface SplitResult {
  keeps: KeepSegment[];
  /** keep.id → 該段之後的接縫是切點造成的。 */
  splitAfter: Map<number, SplitSeam>;
}

/**
 * 把切點套到 keeps 上。
 *
 * 切點落在保留段內、且切完兩側都還 >= minKeepMs 才算數 —— 貼著邊緣切出一個 3 ms 的
 * 碎片沒有意義，而且會讓 crossfade 公式（受兩側長度夾）退化成 0。
 * 落在剪除區裡的切點直接忽略（那裡本來就沒有聲音會被留下）。
 */
export function applySplits(keeps: KeepSegment[], splits: SplitPoint[], minKeepMs: number): SplitResult {
  const splitAfter = new Map<number, SplitSeam>();
  // 一定回傳新陣列：呼叫端會用「清空再 push 回去」把結果寫回原本的 keeps，
  // 回傳同一個參考的話那一步會先把自己清空，keeps 就整個不見了。
  if (!splits.length) return { keeps: keeps.slice(), splitAfter };

  const sorted = splits.slice().sort((a, b) => a.ms - b.ms);
  const out: KeepSegment[] = [];

  for (const k of keeps) {
    // 這一段內部的切點（去重：同一個位置切兩刀等於切一刀）
    const inside: SplitPoint[] = [];
    for (const s of sorted) {
      if (s.ms - k.srcStartMs < minKeepMs) continue;
      if (k.srcEndMs - s.ms < minKeepMs) continue;
      if (inside.length && Math.abs(inside[inside.length - 1].ms - s.ms) < 1) continue;
      inside.push(s);
    }
    if (!inside.length) {
      out.push({ ...k, id: out.length });
      continue;
    }
    let cursor = k.srcStartMs;
    for (const s of inside) {
      const id = out.length;
      out.push({ ...k, id, srcStartMs: cursor, srcEndMs: s.ms });
      splitAfter.set(id, { splitId: s.id, gapMs: Math.max(0, s.gapMs ?? 0) });
      cursor = s.ms;
    }
    out.push({ ...k, id: out.length, srcStartMs: cursor, srcEndMs: k.srcEndMs });
  }

  return { keeps: out, splitAfter };
}

/** 目前 EDL 下，某個時間點切下去會不會生效（UI 要據此給回饋）。 */
export function canSplitAt(keeps: KeepSegment[], ms: number, minKeepMs: number): boolean {
  return keeps.some((k) => ms - k.srcStartMs >= minKeepMs && k.srcEndMs - ms >= minKeepMs);
}
