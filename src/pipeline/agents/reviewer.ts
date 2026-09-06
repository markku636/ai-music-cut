// 審核 agent：對剪輯 agent 判「剪」的候選做第二輪覆核。
//
// 為什麼零 Rust 改動：直接複用 agent.rs 的 claude_structured（零工具、無 session、--json-schema）。
// 走 MCP 那條路會撞到「全域單一工具目錄」與「assistantChat 單一 session」兩個結構限制，
// 而審核根本不需要工具 —— 它只要讀一段文字、回一個 verdict。
//
// 只覆核「判剪」的候選：keep 是安全方向（不剪不會壞），覆核它沒有價值，
// 而且能省下約 40% 的 token。
import { api, errMessage } from "../../api";
import { renderReviewWindow, REVIEWER_SYSTEM_PROMPT } from "../../analysis/llm/prompt";
import { REVIEW_SCHEMA, type ReviewOutput } from "../../analysis/llm/schema";
import type { JudgeWindow } from "../../analysis/llm/windows";
import type { Candidate, DecisionMap, Opinion, Transcript } from "../../analysis/types";
import { agentBackend } from "../../store/settings";

export interface ReviewResult {
  /** 候選 id → 審核意見。 */
  opinions: Record<string, Opinion>;
  warnings: string[];
}

/** claude 的原始輸出 → 以候選 id 為鍵的意見表（別名還原 + 值域檢查）。 */
export function validateReview(raw: unknown, w: JudgeWindow, alias: Map<string, string>, model: string, now: string): ReviewResult {
  const opinions: Record<string, Opinion> = {};
  const warnings: string[] = [];
  const o = raw as Partial<ReviewOutput> | null;
  if (!o || !Array.isArray(o.reviews)) return { opinions, warnings: ["輸出不符 schema"] };
  if (o.window_id && o.window_id !== w.id) warnings.push(`window_id 不符（${o.window_id}）`);
  for (const r of o.reviews) {
    const id = alias.get(String(r?.id ?? ""));
    if (!id) {
      warnings.push(`未知代號 ${String(r?.id)}`);
      continue;
    }
    const verdict = r?.verdict;
    if (verdict !== "cut" && verdict !== "keep" && verdict !== "unsure") {
      warnings.push(`${r?.id} verdict 不合法`);
      continue;
    }
    opinions[id] = { verdict, reason: String(r?.reason ?? "").slice(0, 60), at: now, model };
  }
  const missing = [...alias.values()].filter((id) => !opinions[id]);
  if (missing.length) warnings.push(`${missing.length} 個候選沒有 review`);
  return { opinions, warnings };
}

export interface ReviewWindowOptions {
  model: string;
  systemPrompt?: string;
  timeoutMs?: number;
}

/**
 * 覆核一個視窗裡「剪輯判剪」的候選。
 * cutIds 為空就直接回空結果，不浪費一次呼叫。
 */
export async function reviewWindow(
  tr: Transcript,
  w: JudgeWindow,
  candidates: Candidate[],
  decisions: DecisionMap,
  cutIds: Set<string>,
  opts: ReviewWindowOptions,
): Promise<ReviewResult> {
  const inWindow = new Set(w.candidateIds.filter((id) => cutIds.has(id)));
  if (!inWindow.size) return { opinions: {}, warnings: [] };
  const r = renderReviewWindow(tr, w, candidates, decisions, inWindow);
  const sys = opts.systemPrompt ?? REVIEWER_SYSTEM_PROMPT;
  const now = new Date().toISOString();
  try {
    const raw = await api.claudeStructured(r.prompt, REVIEW_SCHEMA, opts.model, sys, opts.timeoutMs ?? 240_000, agentBackend());
    return validateReview(raw, w, r.alias, opts.model, now);
  } catch (e) {
    // 單一視窗失敗就降級成「只有剪輯意見」，不要讓整趟判讀失敗
    return { opinions: {}, warnings: [`${w.id}: ${errMessage(e)}`] };
  }
}
