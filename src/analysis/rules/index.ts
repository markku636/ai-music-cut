// 規則層總入口：跑所有規則 → 同類重疊去重（留高分）→ 依時間排序。
import { thresholdsFor, type Thresholds } from "../thresholds";
import type { Candidate } from "../types";
import { RuleContext, type AnalysisInput } from "./context";
import { fillerRule } from "./fillers";
import { noiseRule } from "./noise";
import { pauseRule } from "./pauses";
import { redoRule } from "./redo";
import { repeatRule } from "./repeats";
import { unclearRule } from "./unclear";

export type { AnalysisInput } from "./context";

function overlaps(a: Candidate, b: Candidate): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}

/** 同類且重疊 → 留分數高者；不同類允許共存（例如 filler 與 unclear 同一個字）。 */
export function dedupe(cands: Candidate[]): Candidate[] {
  const sorted = cands.slice().sort((a, b) => a.startMs - b.startMs || b.score - a.score);
  const kept: Candidate[] = [];
  for (const c of sorted) {
    let dup = false;
    for (let i = kept.length - 1; i >= 0; i--) {
      const k = kept[i];
      if (k.endMs <= c.startMs - 5000) break; // 早於 5 秒的不可能重疊
      if (k.kind === c.kind && overlaps(k, c)) {
        if (c.score > k.score) kept[i] = c;
        dup = true;
        break;
      }
    }
    if (!dup) kept.push(c);
  }
  return kept.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

/** 用給定門檻跑規則層。 */
export function runRules(input: AnalysisInput, th: Thresholds): Candidate[] {
  const ctx = new RuleContext(input, th);
  const all = [...fillerRule(ctx), ...repeatRule(ctx), ...pauseRule(ctx), ...unclearRule(ctx), ...noiseRule(ctx), ...redoRule(ctx)];
  return dedupe(all);
}

/** 用激進度跑規則層。 */
export function runRulesAt(input: AnalysisInput, aggressiveness: number): Candidate[] {
  return runRules(input, thresholdsFor(aggressiveness));
}
