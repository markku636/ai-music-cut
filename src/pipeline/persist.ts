// 專案檔 ↔ 執行期 store 的橋：存檔時把候選 / 決策併進 analysis[mediaId]；載入時還原。
import type { CleanupSpec } from "../analysis/cleanup";
import type { ReelRange } from "../analysis/reel";
import type { ShowNotes } from "../analysis/shownotes";
import type { AudioEffect } from "../analysis/effects";
import type { Overlay } from "../analysis/overlays";
import type { SpeakerState } from "../analysis/speakers";
import {
  emptyReport,
  sanitizeCandidates,
  sanitizeCleanup,
  sanitizeDecisions,
  sanitizeEffects,
  sanitizeMarkers,
  sanitizeOverlays,
  sanitizeSpeakers,
  sanitizeSplits,
} from "../project/sanitize";
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

/**
 * 載入後：analysis 記錄 → store（不記 undo）。回 true 表示有候選可用。
 *
 * **進 store 之前每一類都要驗過。** 專案檔會在機器之間複製、會被手改、會被不同版本的
 * App 寫過；壞掉的欄位進了 store 之後，症狀出現的地方離原因很遠（`splits: [{ms:"abc"}]`
 * 不會當場報錯，而是讓 EDL 算出 NaN 的時間，整條時間軸靜靜地壞掉）。
 * 壞掉的條目丟掉就好 —— 因為一個壞欄位打不開整個專案，代價是使用者一整集的工作。
 */
export function restoreDecisions(mediaId: string, rec: StoredAnalysis | undefined): boolean {
  const r = emptyReport();
  const cands = sanitizeCandidates(rec?.candidates, r);
  const known = new Set(cands.map((c) => c.id));
  const decisions = sanitizeDecisions(rec?.decisions, known, r);
  const effects = sanitizeEffects(rec?.effects, r);
  const splits = sanitizeSplits(rec?.splits, r);
  const markers = sanitizeMarkers(rec?.markers, r);
  const overlays = sanitizeOverlays(rec?.overlays, r);

  useCleanup.getState().load(mediaId, sanitizeCleanup(rec?.cleanup, r) ?? null);
  useHighlights.getState().load(mediaId, Array.isArray(rec?.highlights) ? rec.highlights : []);
  useShowNotes.getState().load(mediaId, rec?.showNotes ?? null);

  const speakers = sanitizeSpeakers(rec?.speakers, r);
  if (r.total > 0) {
    // 靜靜地少東西比壞掉更難查，所以一定要留下痕跡
    console.warn("[project] 專案檔有壞掉的欄位，已略過：", r.dropped);
  }
  if (!rec?.candidates || !rec.decisions) {
    if (effects.length || splits.length || markers.length || overlays.length || speakers?.list.length)
      useDecisions.getState().load(mediaId, [], {}, effects, splits, markers, overlays, speakers);
    return false;
  }
  useDecisions.getState().load(mediaId, cands, decisions, effects, splits, markers, overlays, speakers);
  return cands.length > 0;
}

/** 專案檔載入時丟掉了什麼（測試與除錯用）。 */
export function inspectAnalysis(rec: StoredAnalysis | undefined) {
  const r = emptyReport();
  const cands = sanitizeCandidates(rec?.candidates, r);
  sanitizeDecisions(rec?.decisions, new Set(cands.map((c) => c.id)), r);
  sanitizeEffects(rec?.effects, r);
  sanitizeSplits(rec?.splits, r);
  sanitizeMarkers(rec?.markers, r);
  sanitizeOverlays(rec?.overlays, r);
  sanitizeCleanup(rec?.cleanup, r);
  sanitizeSpeakers(rec?.speakers, r);
  return r;
}
