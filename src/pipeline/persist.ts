// 專案檔 ↔ 執行期 store 的橋：存檔時把候選 / 決策併進 analysis[mediaId]；載入時還原。
import type { Candidate, DecisionMap, Transcript } from "../analysis/types";
import type { MediaAnalysisV1 } from "../project/format";
import { useDecisions } from "../store/decisions";
import { useTranscript } from "../store/transcript";

export interface StoredAnalysis extends MediaAnalysisV1 {
  transcript?: Transcript;
  candidates?: Candidate[];
  decisions?: DecisionMap;
  transcribedAt?: string;
}

/** 存檔前：把 store 內的逐字稿 / 候選 / 決策寫回 analysis 記錄。 */
export function enrichAnalysis(analysis: Record<string, MediaAnalysisV1>): Record<string, MediaAnalysisV1> {
  const ts = useTranscript.getState();
  const d = useDecisions.getState();
  const out: Record<string, MediaAnalysisV1> = { ...analysis };
  const ids = new Set([...Object.keys(analysis), ...Object.keys(ts.byMedia)]);
  for (const id of ids) {
    const rec: StoredAnalysis = { ...(analysis[id] as StoredAnalysis | undefined) };
    if (ts.byMedia[id]) rec.transcript = ts.byMedia[id];
    if (d.candidates[id]) rec.candidates = d.candidates[id];
    if (d.decisions[id]) rec.decisions = d.decisions[id];
    if (rec.transcript) out[id] = rec;
  }
  return out;
}

/** 載入後：analysis 記錄 → store（不記 undo）。回 true 表示有候選可用。 */
export function restoreDecisions(mediaId: string, rec: StoredAnalysis | undefined): boolean {
  if (!rec?.candidates || !rec.decisions) return false;
  useDecisions.getState().load(mediaId, rec.candidates, rec.decisions);
  return true;
}
