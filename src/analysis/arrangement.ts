// 成品順序帶的版面：把 EDL 的保留段整理成「一集節目長什麼樣子」的區塊。
//
// 波形是**來源時間**的，這在只會「拿掉東西」的時候剛好夠用 —— 剪掉的地方畫個灰底，
// 其餘就是節目本身。但剪下貼上 / 搬移之後，來源時間軸就不再是節目了：
// 貼上的那一段在波形上完全看不到（它是同一段來源的第二份），搬移過的段落
// 看起來還在原地。使用者做了一件事，畫面上沒有任何痕跡。
//
// 這一條是它的對照組：**依成品順序**畫。一個區塊 = 成品裡連續的一段內容，
// 點下去跳到它在來源的位置，貼上來的那幾塊標成另一個顏色、可以直接移除。
//
// **粒度是「編排」不是「每一刀」。** 剪掉贅字會把保留段切成幾百段，全部畫出來只是雜訊；
// 所以來源上連續往前走的段落會合併成同一塊，只有三種情況才斷開：
// 來源往回跳（搬移 / 貼上的接縫）、換了一次貼上、以及剪掉一大段（那是真的結構性剪輯）。

import type { KeepSegment } from "./edl/build";
import type { ArrangedKeep } from "./edl/arrange";

/** 往前剪掉超過這麼久就另起一塊 —— 剪掉一整段是結構性的編輯，該看得到。 */
export const DEFAULT_GAP_BREAK_MS = 2000;

export interface ArrangementBlock {
  /** 0 起算，畫面上的 key。 */
  index: number;
  /** 成品時間。 */
  outStartMs: number;
  outEndMs: number;
  /** 來源時間（合併之後的頭尾）。 */
  srcStartMs: number;
  srcEndMs: number;
  /** 來自哪一次貼上；原本就在那裡的段落沒有這個欄位。 */
  pasteId?: string;
  /** 這一塊合併了幾個保留段（＝裡面有幾刀）。 */
  keepCount: number;
  /** 這一塊裡面總共剪掉多久（來源時間）。 */
  cutInsideMs: number;
  /** 相對位置與寬度（0..1）。畫的時候乘上像素寬。 */
  x: number;
  w: number;
}

/**
 * 保留段（**成品順序**）→ 成品順序帶的區塊。
 *
 * @param outMs 成品總長；<= 0 時回空陣列（沒有東西可以按比例畫）。
 */
export function arrangementBlocks(
  keeps: readonly KeepSegment[],
  outMs: number,
  opts: { gapBreakMs?: number } = {},
): ArrangementBlock[] {
  if (!keeps.length || outMs <= 0) return [];
  const gapBreak = opts.gapBreakMs ?? DEFAULT_GAP_BREAK_MS;
  const arranged = keeps as readonly ArrangedKeep[];

  const blocks: ArrangementBlock[] = [];
  for (let i = 0; i < arranged.length; i++) {
    const k = arranged[i];
    const last = blocks[blocks.length - 1];
    const prev = arranged[i - 1];
    // 接得下去嗎：同一次貼上（或都不是貼上）、來源往前走、而且沒有剪掉一大段
    const gap = prev ? k.srcStartMs - prev.srcEndMs : 0;
    const joins = last && prev && k.pasteId === prev.pasteId && gap >= 0 && gap <= gapBreak;
    if (joins) {
      last.outEndMs = k.outEndMs;
      last.srcEndMs = k.srcEndMs;
      last.keepCount += 1;
      last.cutInsideMs += gap;
      continue;
    }
    blocks.push({
      index: blocks.length,
      outStartMs: k.outStartMs,
      outEndMs: k.outEndMs,
      srcStartMs: k.srcStartMs,
      srcEndMs: k.srcEndMs,
      pasteId: k.pasteId,
      keepCount: 1,
      cutInsideMs: 0,
      x: 0,
      w: 0,
    });
  }

  for (const b of blocks) {
    b.x = b.outStartMs / outMs;
    b.w = Math.max(0, (b.outEndMs - b.outStartMs) / outMs);
  }
  return blocks;
}

/**
 * 這一集有沒有「編排」可看 —— 有貼上、或者不只一塊。
 *
 * 完全沒剪過的檔案只會有一塊，畫出來是一條實心橫條，佔高度而不給資訊。
 */
export function worthShowing(blocks: readonly ArrangementBlock[]): boolean {
  return blocks.length > 1 || blocks.some((b) => b.pasteId != null);
}
