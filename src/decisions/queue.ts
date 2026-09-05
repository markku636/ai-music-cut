// 審核佇列：只收「真的需要人看」的候選，並決定下一筆是哪一個。
//
// 舊版 App.tsx 的 stepCandidate 走的是全部候選、無視篩選也無視狀態，
// 所以 `[` / `]` 會一直帶你回到早就決定過的東西。這裡把「還沒處理完的」抽成純函式。
import type { Candidate, DecisionMap } from "../analysis/types";
import type { Downgrade } from "../analysis/edl/build";

export interface QueueOptions {
  /** 只收這些類型（空 = 全部）。 */
  kinds?: Set<Candidate["kind"]> | null;
  /** 被自然度守門降級的候選 —— 這些是 AI 想剪但被規則擋下來的，最值得人看一眼。 */
  downgrades?: Downgrade[] | null;
  /** 兩個 agent 意見相反的（R5 之後才有）。 */
  conflictIds?: Set<string> | null;
}

/**
 * 需要人處理的候選，依時間排序。
 * 收錄條件：未決 / 被守門降級 / 兩個 agent 意見分歧。
 * 已經是 accepted 或 rejected 的不再打擾（要回頭看走面板的篩選）。
 */
export function reviewQueue(candidates: Candidate[], decisions: DecisionMap, opts: QueueOptions = {}): Candidate[] {
  const downgraded = new Set((opts.downgrades ?? []).map((d) => d.candidateId));
  const conflicts = opts.conflictIds ?? null;
  return candidates
    .filter((c) => {
      if (opts.kinds && opts.kinds.size && !opts.kinds.has(c.kind)) return false;
      const st = decisions[c.id]?.state ?? "pending";
      if (st === "pending") return true;
      if (downgraded.has(c.id)) return true;
      if (conflicts?.has(c.id)) return true;
      return false;
    })
    .slice()
    .sort((a, b) => a.startMs - b.startMs);
}

/**
 * 從 currentId 往 dir 方向走一步；回傳新的候選（沒有就 null）。
 * currentId 不在佇列裡（剛被決定掉）→ 回到「時間上下一個」而不是跳回開頭，
 * 這樣「決定 → 自動前進」才會連續。
 */
export function stepQueue(queue: Candidate[], currentId: string | null, dir: 1 | -1): Candidate | null {
  if (!queue.length) return null;
  if (!currentId) return dir > 0 ? queue[0] : queue[queue.length - 1];
  const i = queue.findIndex((c) => c.id === currentId);
  if (i >= 0) {
    const n = i + dir;
    return n >= 0 && n < queue.length ? queue[n] : null;
  }
  // 已經不在佇列（剛被決定掉）→ 回到頭 / 尾，由 advanceAfterDecision 負責連續前進
  return dir > 0 ? queue[0] : queue[queue.length - 1];
}

/**
 * currentId 被決定掉之後，下一筆該是誰。
 * 傳「決定前」的佇列與「決定後」的佇列：用決定前的順序找位置，再對到決定後還在的那一筆。
 */
export function advanceAfterDecision(before: Candidate[], after: Candidate[], currentId: string): Candidate | null {
  const i = before.findIndex((c) => c.id === currentId);
  if (i < 0) return after[0] ?? null;
  const stillThere = new Set(after.map((c) => c.id));
  for (let k = i + 1; k < before.length; k++) if (stillThere.has(before[k].id)) return before[k];
  // 後面沒有了 → 往前找（處理完最後一筆時不要直接跳走）
  for (let k = i - 1; k >= 0; k--) if (stillThere.has(before[k].id)) return before[k];
  return null;
}

export interface QueueProgress {
  done: number;
  total: number;
  /** 每秒處理幾筆（審核速度指標）。 */
  rate: number | null;
}

/** total = 進審核模式當下的佇列長度；remaining = 現在還剩幾筆。 */
export function queueProgress(total: number, remaining: number, elapsedMs: number): QueueProgress {
  const done = Math.max(0, total - remaining);
  return { done, total, rate: elapsedMs > 1000 && done > 0 ? done / (elapsedMs / 1000) : null };
}
