// 專案檔 ↔ 執行期 store 的橋：存檔時把候選 / 決策併進 analysis[mediaId]；載入時還原。
import type { CleanupSpec } from "../analysis/cleanup";
import type { ReelRange } from "../analysis/reel";
import type { ShowNotes } from "../analysis/shownotes";
import type { AudioEffect } from "../analysis/effects";
import type { Overlay } from "../analysis/overlays";
import { parseSpeakerState, type SpeakerState } from "../analysis/speakers";
import type { Candidate, DecisionMap, Marker, SplitPoint, Transcript } from "../analysis/types";
import type { MediaAnalysisV1 } from "../project/format";
import { useCleanup } from "../store/cleanup";
import { useHighlights } from "../store/highlights";
import { useShowNotes } from "../store/showNotes";
import { useDecisions } from "../store/decisions";
import { useTranscript } from "../store/transcript";

export interface StoredAnalysis extends MediaAnalysisV1 {
  transcript?: Transcript;
  candidates?: Candidate[];
  decisions?: DecisionMap;
  effects?: AudioEffect[];
  splits?: SplitPoint[];
  markers?: Marker[];
  overlays?: Overlay[];
  /** 講者標籤（誰在什麼時候講；進 undo）。 */
  speakers?: SpeakerState;
  /** 修聲設定（輸出設定，不進 undo）。 */
  cleanup?: CleanupSpec;
  /** 精華片段（要串成預告的那幾段；不進 undo）。 */
  highlights?: ReelRange[];
  /** 節目筆記（產出物，不進 undo）。 */
  showNotes?: ShowNotes;
  transcribedAt?: string;
}

/** 存檔前：把 store 內的逐字稿 / 候選 / 決策寫回 analysis 記錄。 */
export function enrichAnalysis(analysis: Record<string, MediaAnalysisV1>): Record<string, MediaAnalysisV1> {
  const ts = useTranscript.getState();
  const d = useDecisions.getState();
  const cl = useCleanup.getState();
  const hl = useHighlights.getState();
  const sn = useShowNotes.getState();
  const out: Record<string, MediaAnalysisV1> = { ...analysis };
  const ids = new Set([...Object.keys(analysis), ...Object.keys(ts.byMedia), ...Object.keys(d.candidates), ...Object.keys(d.effects), ...Object.keys(d.splits), ...Object.keys(d.markers), ...Object.keys(d.overlays), ...Object.keys(d.speakers), ...Object.keys(cl.byMedia), ...Object.keys(hl.byMedia), ...Object.keys(sn.byMedia)]);
  for (const id of ids) {
    const rec: StoredAnalysis = { ...(analysis[id] as StoredAnalysis | undefined) };
    if (ts.byMedia[id]) rec.transcript = ts.byMedia[id];
    if (d.candidates[id]) rec.candidates = d.candidates[id];
    if (d.decisions[id]) rec.decisions = d.decisions[id];
    if (d.effects[id]?.length) rec.effects = d.effects[id];
    else delete rec.effects;
    if (d.splits[id]?.length) rec.splits = d.splits[id];
    else delete rec.splits;
    if (d.markers[id]?.length) rec.markers = d.markers[id];
    else delete rec.markers;
    if (d.overlays[id]?.length) rec.overlays = d.overlays[id];
    else delete rec.overlays;
    if (d.speakers[id]?.list.length) rec.speakers = d.speakers[id];
    else delete rec.speakers;
    if (cl.byMedia[id]) rec.cleanup = cl.byMedia[id];
    else delete rec.cleanup;
    if (hl.byMedia[id]?.length) rec.highlights = hl.byMedia[id];
    else delete rec.highlights;
    if (sn.byMedia[id]) rec.showNotes = sn.byMedia[id];
    else delete rec.showNotes;
    // 沒逐字稿也可能有人工剪輯 / 效果 / 切點（未分析就手動剪）
    if (rec.transcript || rec.candidates?.length || rec.effects?.length || rec.splits?.length || rec.markers?.length || rec.overlays?.length || rec.speakers?.list.length || rec.cleanup || rec.highlights?.length || rec.showNotes) out[id] = rec;
  }
  return out;
}

/** 載入後：analysis 記錄 → store（不記 undo）。回 true 表示有候選可用。 */
export function restoreDecisions(mediaId: string, rec: StoredAnalysis | undefined): boolean {
  useCleanup.getState().load(mediaId, rec?.cleanup ?? null);
  useHighlights.getState().load(mediaId, rec?.highlights ?? []);
  useShowNotes.getState().load(mediaId, rec?.showNotes ?? null);
  if (!rec?.candidates || !rec.decisions) {
    if (rec?.effects?.length || rec?.splits?.length || rec?.markers?.length || rec?.overlays?.length || rec?.speakers?.list.length)
      useDecisions.getState().load(mediaId, [], {}, rec.effects ?? [], rec.splits ?? [], rec.markers ?? [], rec.overlays ?? [], speakersOf(rec));
    return false;
  }
  useDecisions.getState().load(mediaId, rec.candidates, rec.decisions, rec.effects ?? [], rec.splits ?? [], rec.markers ?? [], rec.overlays ?? [], speakersOf(rec));
  return true;
}

/**
 * 專案檔裡的講者標籤要**驗過再放進 store**。
 *
 * 段落重疊或反向的話 `speakerAtMs` 的二分搜會給出錯的答案 —— 而這個檔案可能是別台
 * 機器、別的版本寫的，甚至被人手改過。
 */
function speakersOf(rec: StoredAnalysis | undefined): SpeakerState | undefined {
  return rec?.speakers ? (parseSpeakerState(rec.speakers) ?? undefined) : undefined;
}
