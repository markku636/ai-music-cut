// 規則層 / EDL 與 store 的接線（分析完成、滑桿變動、專案還原時呼叫）。
import { buildEdl, DEFAULT_EDL_OPTIONS, type Edl, type EdlOptions, type EnergyProbe } from "../analysis/edl/build";
import { breathFor } from "../analysis/edl/breath";
import { hasZeroCross, loudnessWindows, minEnergyPointMs, nearestZeroCrossMs, rmsDbRange } from "../analysis/peaks";
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
  const durationMs = tr?.durationMs ?? useProject.getState().media.find((m) => m.id === mediaId)?.probe?.duration_ms ?? 0;
  if (!durationMs) return null;
  const local = ts.local[mediaId];
  const probe: EnergyProbe | undefined = local
    ? {
        minEnergyPointMs: (a, b) => minEnergyPointMs(local, a, b),
        rmsDbAt: (a, b) => rmsDbRange(local, a, b),
        // v2 的舊分析檔沒有零交越 → 不掛這個方法，buildEdl 就會跳過第三段細修
        ...(hasZeroCross(local) ? { nearestZeroCrossMs: (ms: number, w: number) => nearestZeroCrossMs(local, ms, w) } : {}),
      }
    : undefined;
  const d = useDecisions.getState();
  const th = thresholdsFor(useProject.getState().aggressiveness);
  // pauseKeepMs 以前傳在這裡，但 EdlOptions 根本沒有這個欄位 —— 是個從來沒生效過的死參數。
  // 呼吸感現在走 breath（句中 / 句尾 / 段落三級，隨激進度縮放）。
  const opts: EdlOptions = {
    ...DEFAULT_EDL_OPTIONS,
    breath: breathFor(useProject.getState().aggressiveness),
    maxSentenceRemovalRatio: th.maxSentenceRemovalRatio,
  };
  return buildEdl(
    { words: tr?.words ?? [], sentences: tr?.sentences ?? [], vad: tr?.vad ?? [], durationMs, splits: d.splits[mediaId] ?? [] },
    d.candidates[mediaId] ?? [],
    d.decisions[mediaId] ?? {},
    opts,
    probe,
  );
}
