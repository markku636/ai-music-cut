// 貼上與搬移：讓成品的順序可以跟來源時間**不一樣**。
//
// 到目前為止整個 EDL 建立在一個很強的假設上：keeps 是「剪除區間的補集」，
// 所以它天生保證三件事 —— 照來源時間排序、彼此不重疊、每一段來源只出現一次。
// 剪下貼上把這三件事全部打破：貼上會讓同一段來源出現兩次，搬移會讓順序跟來源不一致。
//
// **輸出層本來就撐得住。** `RenderSeg { src_start_ms, src_end_ms, gain_db }` 只是
// 一串「照順序接起來的來源區間」，沒有規定要排序、不重疊或不重複。所以 Rust 完全不用動，
// 要動的是「怎麼從決策推導出那一串」。
//
// 這裡就是那一層：拿剪完之後的 keeps（來源順序），把貼上的區塊插進去，
// 回傳**成品順序**的 keeps。之後 joins、輸出、時間換算全部照著這個順序走。

import type { KeepSegment } from "./build";

export interface Paste {
  id: string;
  /** 要貼的內容（來源區間）。 */
  srcStartMs: number;
  srcEndMs: number;
  /**
   * 貼在哪裡（**來源**時間）。
   *
   * 錨在來源時間而不是成品時間是刻意的：之後多剪掉幾個贅字，這一塊要跟著它前面那句話走，
   * 而不是停在「成品第 12 分 30 秒」那個位置。這跟配樂 overlay 用成品時間是相反的取捨 ——
   * 配樂要對齊的是聽眾聽到的時間點，貼上的內容要對齊的是它前面那句話。
   */
  atMs: number;
}

/** 一段 keep 是不是貼上來的（貼上來的那份不參與 src→out 的「原位」查表）。 */
export interface ArrangedKeep extends KeepSegment {
  /** 來自哪一次貼上；原本就在那裡的段落沒有這個欄位。 */
  pasteId?: string;
}

/** 貼上的區塊短於這個長度就忽略（避免手滑貼進一個 3 毫秒的東西）。 */
export const MIN_PASTE_MS = 20;

function clone(k: KeepSegment): ArrangedKeep {
  return { id: k.id, srcStartMs: k.srcStartMs, srcEndMs: k.srcEndMs, outStartMs: 0, outEndMs: 0, gainDb: k.gainDb };
}

/**
 * 把貼上的區塊插進 keeps。
 *
 * @param keeps 剪完之後的保留段（**來源順序**）。
 * @param pastes 貼上清單。
 * @param minKeepMs 切開之後太短的半邊就不切（沿用刀片切點的守門值）。
 * @returns **成品順序**的 keeps，id 重新編號。
 */
export function applyPastes(keeps: readonly KeepSegment[], pastes: readonly Paste[], minKeepMs: number): ArrangedKeep[] {
  const valid = pastes
    .filter((p) => p.srcEndMs - p.srcStartMs >= MIN_PASTE_MS)
    .slice()
    // 同一個位置貼好幾塊時，照清單順序疊上去（穩定排序）
    .sort((a, b) => a.atMs - b.atMs);
  if (!valid.length) return keeps.map(clone);

  let out: ArrangedKeep[] = keeps.map(clone);

  for (const p of valid) {
    const block: ArrangedKeep = {
      id: -1,
      srcStartMs: p.srcStartMs,
      srcEndMs: p.srcEndMs,
      outStartMs: 0,
      outEndMs: 0,
      gainDb: 0,
      pasteId: p.id,
    };

    // 找出要插在哪 —— 只看**原本就在那裡**的段落，不要插進另一塊剛貼上的東西裡面
    let inserted = false;
    const next: ArrangedKeep[] = [];
    for (let i = 0; i < out.length; i++) {
      const k = out[i];
      if (inserted || k.pasteId) {
        next.push(k);
        continue;
      }
      // 落在這一段裡面 → 切開，中間夾進去
      if (p.atMs > k.srcStartMs && p.atMs < k.srcEndMs) {
        const leftLen = p.atMs - k.srcStartMs;
        const rightLen = k.srcEndMs - p.atMs;
        if (leftLen < minKeepMs) {
          // 左邊太短就不切，整段往後推、貼在它前面
          next.push(block, k);
        } else if (rightLen < minKeepMs) {
          next.push(k, block);
        } else {
          next.push({ ...k, srcEndMs: p.atMs }, block, { ...k, srcStartMs: p.atMs });
        }
        inserted = true;
        continue;
      }
      // 落在這一段之前（剪除區裡、或整條時間軸的最前面）→ 插在它前面
      if (p.atMs <= k.srcStartMs) {
        next.push(block, k);
        inserted = true;
        continue;
      }
      next.push(k);
    }
    if (!inserted) next.push(block); // 貼在最後面
    out = next;
  }

  return out.map((k, i) => ({ ...k, id: i }));
}

/**
 * 依成品順序重算 outStartMs / outEndMs（不含接點帳；接點由 joins 那一層再調整）。
 * 抽出來是為了讓測試可以單獨驗「順序對不對」。
 */
export function layoutOut(keeps: ArrangedKeep[]): ArrangedKeep[] {
  let cursor = 0;
  return keeps.map((k) => {
    const len = Math.max(0, k.srcEndMs - k.srcStartMs);
    const withOut = { ...k, outStartMs: cursor, outEndMs: cursor + len };
    cursor += len;
    return withOut;
  });
}

/**
 * 成品順序下的「來源 → 成品」查表。
 *
 * **一段來源可能出現兩次**（複製貼上），所以規則要講清楚：回**成品裡最早**的那一次。
 * 搬移（剪下原本的 + 貼到別處）因此會回貼上後的位置，這正是使用者要的；
 * 複製則會回比較前面的那一份。這是有定義的行為，不是碰運氣。
 *
 * 落在剪除區（沒有任何段落覆蓋）時，靠到**來源時間上**最近的鄰居 ——
 * 所以這裡要用一份依來源排序的視圖，不能直接掃成品順序。
 */
export function srcToOutArranged(keeps: readonly ArrangedKeep[], srcMs: number, snap: "next" | "prev" = "next"): number {
  if (!keeps.length) return 0;
  // 覆蓋到的段落裡，取成品時間最早的那一個
  let best: ArrangedKeep | null = null;
  for (const k of keeps) {
    if (srcMs >= k.srcStartMs && srcMs <= k.srcEndMs) {
      if (!best || k.outStartMs < best.outStartMs) best = k;
    }
  }
  if (best) return best.outStartMs + (srcMs - best.srcStartMs);

  // 沒被覆蓋：靠到來源時間上最近的鄰居
  const bySrc = keeps.slice().sort((a, b) => a.srcStartMs - b.srcStartMs || a.srcEndMs - b.srcEndMs);
  if (srcMs < bySrc[0].srcStartMs) return bySrc[0].outStartMs;

  // 「來源結束得最晚」的那一段 —— **不是** bySrc 的最後一個。
  // 排序看的是起點，而貼上的區塊可能起點很晚卻很短（例如 2400-2600 排在 2000-3000 後面，
  // 但它 2600 就結束了）。用錯的話，超出範圍的時間會被對到那一小塊的結尾。
  let latest = bySrc[0];
  for (const k of bySrc) if (k.srcEndMs > latest.srcEndMs) latest = k;
  if (srcMs > latest.srcEndMs) return latest.outEndMs;

  for (let i = 0; i < bySrc.length; i++) {
    if (srcMs < bySrc[i].srcStartMs) {
      return snap === "next" ? bySrc[i].outStartMs : bySrc[i - 1].outEndMs;
    }
  }
  return latest.outEndMs;
}

/** 這份排列有沒有動過順序（沒有貼上時，整條路徑要跟以前逐位元相同）。 */
export function isRearranged(keeps: readonly ArrangedKeep[]): boolean {
  return keeps.some((k) => k.pasteId != null);
}
