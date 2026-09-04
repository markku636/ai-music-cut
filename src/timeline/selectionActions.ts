// 時間選取（拖選波形 / 逐字稿 Shift+點）的動作：剪掉、只保留、預聽、清除。
// 不經 React 樹直接操作 store，讓快捷鍵、浮動動作列、MCP 工具都能共用同一套語意。
import { effectId, type EffectKind } from "../analysis/effects";
import type { Transcript } from "../analysis/types";
import { playRange } from "../preview/playerRef";
import { useDecisions } from "../store/decisions";
import { useProject } from "../store/project";
import { useTimeline } from "../store/timeline";
import { useTranscript } from "../store/transcript";
import { formatMs } from "../time";

/** 與 [startMs, endMs] 重疊的字 id（沒有逐字稿回空陣列）。 */
export function wordIdsInRange(transcript: Transcript | null | undefined, startMs: number, endMs: number): number[] {
  if (!transcript) return [];
  const out: number[] = [];
  for (const w of transcript.words) {
    if (w.startMs >= endMs) break;
    if (w.endMs > startMs) out.push(w.id);
  }
  return out;
}

function ctx() {
  const mediaId = useProject.getState().activeMediaId;
  const sel = useTimeline.getState().selection;
  if (!mediaId || !sel) return null;
  return { mediaId, sel, transcript: useTranscript.getState().byMedia[mediaId] ?? null };
}

/** 把目前選取剪掉（手動候選，狀態 accepted）。回傳候選 id；沒有選取回 null。 */
export function cutSelection(): string | null {
  const c = ctx();
  if (!c) return null;
  const { mediaId, sel, transcript } = c;
  const words = wordIdsInRange(transcript, sel.startMs, sel.endMs);
  const sentenceId = words.length ? (transcript?.sentences.find((s) => s.wordIds.includes(words[0]))?.id ?? -1) : -1;
  const id = useDecisions
    .getState()
    .addManualCut(mediaId, sel.startMs, sel.endMs, words, `手動剪除 ${formatMs(sel.startMs, { millis: false })}–${formatMs(sel.endMs, { millis: false })}`, sentenceId);
  useTimeline.getState().setSelection(null);
  useDecisions.getState().select([id]);
  return id;
}

/** 只保留選取：頭尾各建一段手動剪除（短於 200 ms 的頭尾略過）。回傳新增的候選數。 */
export function keepOnlySelection(): number {
  const c = ctx();
  if (!c) return 0;
  const { mediaId, sel, transcript } = c;
  const media = useProject.getState().media.find((m) => m.id === mediaId);
  const dur = media?.probe?.duration_ms ?? transcript?.durationMs ?? 0;
  const d = useDecisions.getState();
  let n = 0;
  if (sel.startMs > 200) {
    d.addManualCut(mediaId, 0, sel.startMs, wordIdsInRange(transcript, 0, sel.startMs), `只保留選取：剪掉開頭到 ${formatMs(sel.startMs, { millis: false })}`);
    n++;
  }
  if (dur - sel.endMs > 200) {
    d.addManualCut(mediaId, sel.endMs, dur, wordIdsInRange(transcript, sel.endMs, dur), `只保留選取：剪掉 ${formatMs(sel.endMs, { millis: false })} 到結尾`);
    n++;
  }
  useTimeline.getState().setSelection(null);
  return n;
}

/** 預聽選取範圍（播原始，不跳播）。 */
export function previewSelection(): boolean {
  const c = ctx();
  if (!c) return false;
  playRange(c.sel.startMs, c.sel.endMs, { skip: false });
  return true;
}

export function clearSelection(): void {
  useTimeline.getState().setSelection(null);
}

/** 對目前選取加效果（靜音 / 淡入 / 淡出 / 增益 dB）。 */
export function addEffectOnSelection(kind: EffectKind, db?: number): string | null {
  const c = ctx();
  if (!c) return null;
  const id = effectId(kind, c.sel.startMs, c.sel.endMs, db);
  useDecisions.getState().addEffect(c.mediaId, { id, kind, startMs: c.sel.startMs, endMs: c.sel.endMs, ...(db != null ? { db } : {}) });
  return id;
}

export function updateEffectRange(id: string, startMs: number, endMs: number): void {
  const mediaId = useProject.getState().activeMediaId;
  if (!mediaId) return;
  const s = Math.round(Math.min(startMs, endMs));
  const e = Math.round(Math.max(startMs, endMs));
  if (e - s < 20) return;
  useDecisions.getState().updateEffect(mediaId, id, { startMs: s, endMs: e });
}

export function removeEffect(id: string): void {
  const mediaId = useProject.getState().activeMediaId;
  if (mediaId) useDecisions.getState().removeEffect(mediaId, id);
}

/** 拉候選邊界後：更新時間範圍與覆蓋的字。 */
export function applyCandidateRange(id: string, startMs: number, endMs: number): void {
  const mediaId = useProject.getState().activeMediaId;
  if (!mediaId) return;
  const transcript = useTranscript.getState().byMedia[mediaId] ?? null;
  useDecisions.getState().updateCandidateRange(mediaId, id, startMs, endMs, wordIdsInRange(transcript, startMs, endMs));
}
