// 兩個 agent 的意見怎麼收斂成一個決策。
//
// 使用者要的是「剪輯 + 審核」兩個角色：剪輯提議剪什麼，審核站在相反立場覆核
// （只有明顯會壞才推翻）。兩邊都說剪才自動剪，意見相反就送人裁決 —— 這是刻意的：
// 分歧正是「這裡不好判斷」的訊號，自動選一邊等於把最需要人看的地方藏起來。
//
// 所有「誰蓋過誰」的規則都收在這一個純函式裡，才測得完整、也才不會有第二個地方
// 偷偷覆寫使用者的決定。
import type { AgentRole, Decision, DecisionState, Opinion } from "../types";

export interface ResolveInput {
  /** 目前的決策（可能已經有人手動決定過）。 */
  current: Decision | undefined;
  editor: Opinion | undefined;
  reviewer: Opinion | undefined;
  /** 這一類候選是不是「只建議、不自動剪」（unclear / rambling / off_topic / redo）。 */
  suggestOnly: boolean;
}

export interface ResolveResult {
  state: DecisionState;
  reason?: string;
  conflict: boolean;
  opinions: Partial<Record<AgentRole, Opinion>>;
  /** 有沒有真的改動（沒改就不必寫回 store）。 */
  changed: boolean;
}

/**
 * 收斂規則（順序即優先序）：
 *  1. `origin === "user"` → 原封不動。人講過的話最大，agent 不能覆蓋。
 *  2. 只有剪輯有意見（沒開審核 / 審核那格失敗）→ 照剪輯的走（等同舊行為）。
 *  3. 兩邊都說剪 → auto（建議類仍然只到 pending）。
 *  4. 兩邊都說留 → rejected。
 *  5. 意見相反 → pending + conflict，送人裁決。
 *  6. 任一邊 unsure → pending（不確定就不要自動動刀）。
 */
export function resolveOpinions(input: ResolveInput): ResolveResult {
  const { current, editor, reviewer, suggestOnly } = input;
  const opinions: Partial<Record<AgentRole, Opinion>> = { ...(current?.opinions ?? {}) };
  if (editor) opinions.editor = editor;
  if (reviewer) opinions.reviewer = reviewer;

  // 1) 使用者決定過的絕對不動 —— 但意見還是記下來（面板要顯示 AI 怎麼想）
  if (current?.origin === "user") {
    return {
      state: current.state,
      reason: current.reason,
      conflict: false,
      opinions,
      changed: !!(editor || reviewer),
    };
  }

  const e = opinions.editor?.verdict;
  const r = opinions.reviewer?.verdict;

  let state: DecisionState;
  let conflict = false;
  let reason = opinions.editor?.reason ?? opinions.reviewer?.reason;

  if (!e && !r) {
    state = current?.state ?? "pending";
  } else if (!r) {
    // 只有剪輯有意見
    state = e === "cut" ? "auto" : e === "keep" ? "rejected" : "pending";
  } else if (!e) {
    // 只有審核有意見（罕見：剪輯那格失敗）
    state = r === "cut" ? "auto" : r === "keep" ? "rejected" : "pending";
    reason = opinions.reviewer?.reason;
  } else if (e === "unsure" || r === "unsure") {
    state = "pending";
    reason = (e === "unsure" ? opinions.reviewer?.reason : opinions.editor?.reason) ?? reason;
  } else if (e === r) {
    state = e === "cut" ? "auto" : "rejected";
  } else {
    // 相反 → 交給人，並把審核的理由端到最前面（那是「為什麼不該剪」）
    state = "pending";
    conflict = true;
    reason = opinions.reviewer?.reason ?? reason;
  }

  // 建議類永遠不自動剪
  if (suggestOnly && state === "auto") state = "pending";

  const changed = state !== current?.state || conflict !== !!current?.conflict || !!editor || !!reviewer;
  return { state, reason, conflict, opinions, changed };
}

/** 兩個角色都表態、而且方向相反。 */
export function isConflict(d: Decision | undefined): boolean {
  const e = d?.opinions?.editor?.verdict;
  const r = d?.opinions?.reviewer?.verdict;
  if (!e || !r) return false;
  return (e === "cut" && r === "keep") || (e === "keep" && r === "cut");
}
