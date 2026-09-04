// 專案檔 ↔ 執行期 store 的橋：存檔時把候選 / 決策併進 analysis[mediaId]；載入時還原。
import type { AudioEffect } from "../analysis/effects";
import type { Candidate, DecisionMap, Transcript } from "../analysis/types";
import type { MediaAnalysisV1 } from "../project/format";
import { useDecisions } from "../store/decisions";
import { useTranscript } from "../store/transcript";

export interface StoredAnalysis extends MediaAnalysisV1 {
  transcript?: Transcript;
  candidates?: Candidate[];
  decisions?: DecisionMap;
  effects?: AudioEffect[];
  transcribedAt?: string;
}

/** 存檔前：把 store 內的逐字稿 / 候選 / 決策寫回 analysis 記錄。 */
export function enrichAnalysis(analysis: Record<string, MediaAnalysisV1>): Record<string, MediaAnalysisV1> {
  const ts = useTranscript.getState();
  const d = useDecisions.getState();
  const out: Record<string, MediaAnalysisV1> = { ...analysis };
  const ids = new Set([...Object.keys(analysis), ...Object.keys(ts.byMedia), ...Object.keys(d.candidates), ...Object.keys(d.effects)]);
  for (const id of ids) {
    const rec: StoredAnalysis = { ...(analysis[id] as StoredAnalysis | undefined) };
    if (ts.byMedia[id]) rec.transcript = ts.byMedia[id];
    if (d.candidates[id]) rec.candidates = d.candidates[id];
    if (d.decisions[id]) rec.decisions = d.decisions[id];
    if (d.effects[id]?.length) rec.effects = d.effects[id];
    else delete rec.effects;
    // 沒逐字稿也可能有人工剪輯 / 效果（未分析就手動剪）
    if (rec.transcript || rec.candidates?.length || rec.effects?.length) out[id] = rec;
  }
  return out;
}

/** 載入後：analysis 記錄 → store（不記 undo）。回 true 表示有候選可用。 */
export function restoreDecisions(mediaId: string, rec: StoredAnalysis | undefined): boolean {
  if (!rec?.candidates || !rec.decisions) {
    if (rec?.effects?.length) useDecisions.getState().load(mediaId, [], {}, rec.effects);
    return false;
  }
  useDecisions.getState().load(mediaId, rec.candidates, rec.decisions, rec.effects ?? []);
  return true;
}
