// 規則層 / EDL 與 store 的接線（分析完成、滑桿變動、專案還原時呼叫）。
import { buildEdl, DEFAULT_EDL_OPTIONS, type Edl, type EnergyProbe } from "../analysis/edl/build";
import { loudnessWindows, minEnergyPointMs } from "../analysis/peaks";
import { runRulesAt } from "../analysis/rules";
import { thresholdsFor } from "../analysis/thresholds";
import { useDecisions } from "../store/decisions";
import { useProject } from "../store/project";
import { useTranscript } from "../store/transcript";

/** 用目前激進度對某媒體重跑規則層；回候選數。record=true 會記進 undo。 */
export function runRulesFor(mediaId: string, opts: { label?: string; record?: boolean } = {}): number {
  const ts = useTranscript.getState();
  const tr = ts.byMedia[mediaId];
  if (!tr) return 0;
  const local = ts.local[mediaId];
  const aggr = useProject.getState().aggressiveness;
  const cands = runRulesAt({ transcript: tr, loudness: local ? loudnessWindows(local) : [], loudnessHopMs: local?.hopMs ?? 100 }, aggr);
  useDecisions.getState().setCandidates(mediaId, cands, { label: opts.label ?? "規則分析", aggressiveness: aggr, record: opts.record ?? false });
  return cands.length;
}

/** 目前決策 → EDL（含自然度守門）。 */
export function edlFor(mediaId: string): Edl | null {
  const ts = useTranscript.getState();
  const tr = ts.byMedia[mediaId];
  if (!tr) return null;
  const local = ts.local[mediaId];
  const probe: EnergyProbe | undefined = local ? { minEnergyPointMs: (a, b) => minEnergyPointMs(local, a, b) } : undefined;
  const d = useDecisions.getState();
  const th = thresholdsFor(useProject.getState().aggressiveness);
  const opts = { ...DEFAULT_EDL_OPTIONS, pauseKeepMs: th.pauseKeepMs, maxSentenceRemovalRatio: th.maxSentenceRemovalRatio };
  return buildEdl({ words: tr.words, sentences: tr.sentences, vad: tr.vad, durationMs: tr.durationMs }, d.candidates[mediaId] ?? [], d.decisions[mediaId] ?? {}, opts, probe);
}
