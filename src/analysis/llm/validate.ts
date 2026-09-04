// 驗證 / 轉換 LLM 輸出：代號→id、new_candidates 文字→字範圍；不合法的靜默丟棄（記進 warnings）。
import { normText } from "../normalize";
import { SUGGEST_ONLY_KINDS, candidateId, type Candidate, type CandidateKind, type DecisionState, type Transcript } from "../types";
import type { JudgeOutput } from "./schema";
import type { JudgeWindow } from "./windows";

export interface JudgeUpdate {
  id: string;
  state: DecisionState;
  reason: string;
}

export interface ValidatedJudge {
  updates: JudgeUpdate[];
  added: Candidate[];
  warnings: string[];
  notes?: string;
}

/** action → 決策狀態；只建議的類型即使 apply 也降為 pending（需求 3：使用者決定）。 */
export function actionToState(action: "apply" | "suggest" | "drop", kind: CandidateKind): DecisionState {
  if (action === "drop") return "rejected";
  if (action === "suggest") return "pending";
  return SUGGEST_ONLY_KINDS.has(kind) ? "pending" : "auto";
}

export function isJudgeOutput(v: unknown): v is JudgeOutput {
  return !!v && typeof v === "object" && Array.isArray((v as JudgeOutput).decisions) && Array.isArray((v as JudgeOutput).new_candidates);
}

/** 在句子的字序列中找 text（norm 比對）；回 [fromWordIdx, toWordIdx]（句內索引）或 null。 */
export function locateText(tr: Transcript, sid: number, text: string): [number, number] | null {
  const s = tr.sentences[sid];
  if (!s) return null;
  const target = normText(text);
  if (!target) return null;
  const norms = s.wordIds.map((id) => tr.words[id].norm);
  for (let i = 0; i < norms.length; i++) {
    let acc = "";
    for (let j = i; j < norms.length; j++) {
      acc += norms[j];
      if (acc === target) return [i, j];
      if (acc.length >= target.length) break;
    }
  }
  return null;
}

export function validateJudge(raw: unknown, w: JudgeWindow, alias: Map<string, string>, tr: Transcript, candidates: Candidate[]): ValidatedJudge {
  const warnings: string[] = [];
  if (!isJudgeOutput(raw)) return { updates: [], added: [], warnings: ["輸出不符 schema"] };
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const updates: JudgeUpdate[] = [];
  const seen = new Set<string>();
  for (const d of raw.decisions) {
    const id = alias.get(String(d.id)) ?? (byId.has(String(d.id)) ? String(d.id) : null);
    if (!id || !w.candidateIds.includes(id) || seen.has(id)) {
      warnings.push(`未知或重複的候選代號 ${String(d.id)}`);
      continue;
    }
    seen.add(id);
    const c = byId.get(id)!;
    updates.push({ id, state: actionToState(d.action, c.kind), reason: String(d.reason ?? "").slice(0, 60) });
  }
  // 沒給的候選 → suggest（保守）
  for (const id of w.candidateIds) {
    if (!seen.has(id)) updates.push({ id, state: "pending", reason: "AI 未判定，留給使用者" });
  }
  const added: Candidate[] = [];
  const core = new Set(w.coreSentenceIds);
  for (const n of raw.new_candidates) {
    const sid = Number(n.sentence_id);
    if (!core.has(sid)) {
      warnings.push(`new_candidate 不在核心句：S${sid}`);
      continue;
    }
    const loc = locateText(tr, sid, String(n.text ?? ""));
    if (!loc) {
      warnings.push(`new_candidate 文字找不到：${String(n.text).slice(0, 20)}`);
      continue;
    }
    const s = tr.sentences[sid];
    const wordIds = s.wordIds.slice(loc[0], loc[1] + 1);
    if (wordIds.length > 40) {
      warnings.push("new_candidate 範圍過長（>40 字）");
      continue;
    }
    const startMs = tr.words[wordIds[0]].startMs;
    const endMs = tr.words[wordIds[wordIds.length - 1]].endMs;
    if (endMs - startMs > 20_000) {
      warnings.push("new_candidate 範圍過長（>20 秒）");
      continue;
    }
    const kind = n.kind as CandidateKind;
    const id = candidateId(kind, startMs, endMs, "llm");
    if (byId.has(id) || added.some((a) => a.id === id)) continue;
    // 與同類既有候選重疊 ≥ 50% → 跳過
    const overlapped = candidates.some((c) => c.kind === kind && Math.min(c.endMs, endMs) - Math.max(c.startMs, startMs) > 0.5 * (endMs - startMs));
    if (overlapped) continue;
    added.push({
      id,
      kind,
      startMs,
      endMs,
      wordIds,
      reason: String(n.reason ?? "AI 建議").slice(0, 80),
      score: n.action === "apply" && !SUGGEST_ONLY_KINDS.has(kind) ? 0.7 : 0.5,
      source: "llm",
      sentenceId: sid,
      meta: { action: n.action },
    });
  }
  return { updates, added, warnings, notes: typeof raw.notes === "string" ? raw.notes : undefined };
}
