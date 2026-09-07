// 一步做了什麼，以及「只還原其中幾筆」。
//
// 歷史面板可以整步跳回去，但實際剪輯常常是「這一步大致對，只有三筆不對」——
// 「一鍵智慧剪輯」一次剪掉六類、「全部剪掉『呃』」一次處理 23 筆。整步還原會把
// 對的那 20 筆也一起丟掉，只好整步退回去再手動重做一遍。
//
// 每一步都存了完整的前後快照，所以「這一步改了哪幾筆」是**算得出來的**，
// 不必額外記錄操作日誌 —— 那種日誌跟真實狀態遲早會不一致。

import { isActiveState, type Candidate, type DecisionMap, type DecisionState } from "./types";

export interface StepChange {
  id: string;
  /** 之前的狀態；這一步新增的候選就是 null。 */
  from: DecisionState | null;
  /** 之後的狀態；這一步移除的候選就是 null。 */
  to: DecisionState | null;
  /** 之前 / 之後會不會被剪掉 —— 使用者在意的是這個，不是內部狀態名。 */
  wasCut: boolean;
  isCut: boolean;
}

/** 這一步把哪幾筆的決策改掉了（依候選的時間排序，跟波形上的順序一致）。 */
export function diffDecisions(before: DecisionMap, after: DecisionMap, order: Candidate[]): StepChange[] {
  const ids = new Set([...Object.keys(before), ...Object.keys(after)]);
  const pos = new Map(order.map((c, i) => [c.id, i]));
  const out: StepChange[] = [];
  for (const id of ids) {
    const b = before[id]?.state ?? null;
    const a = after[id]?.state ?? null;
    if (b === a) continue;
    out.push({ id, from: b, to: a, wasCut: isActiveState(b ?? undefined), isCut: isActiveState(a ?? undefined) });
  }
  // 沒在候選清單裡的（這一步之後又被移除）排最後，順序才穩定
  return out.sort((x, y) => (pos.get(x.id) ?? Number.MAX_SAFE_INTEGER) - (pos.get(y.id) ?? Number.MAX_SAFE_INTEGER));
}

/** 只看「剪不剪」有沒有變 —— 內部狀態從 auto 變 accepted 對使用者沒差別。 */
export function audibleChanges(changes: StepChange[]): StepChange[] {
  return changes.filter((c) => c.wasCut !== c.isCut);
}

/**
 * 把選中的那幾筆換回 `before` 的狀態，其餘維持現狀。
 *
 * 疊在**目前**的決策上而不是 before 上：這一步之後你可能又改了別的東西，
 * 從 before 整個蓋回去會把那些也一起吃掉 —— 那就變成整步還原了。
 */
export function revertSubset(current: DecisionMap, before: DecisionMap, ids: Iterable<string>): DecisionMap {
  const next = { ...current };
  for (const id of ids) {
    const b = before[id];
    if (b) next[id] = b;
    else delete next[id]; // 這一步之前根本沒有這一筆
  }
  return next;
}

/** 這一步是否有東西可以部分還原（只有一筆的話整步還原就夠了）。 */
export function canPartiallyRevert(changes: StepChange[]): boolean {
  return changes.length > 1;
}
