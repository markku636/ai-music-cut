// 刀片與修剪的動作層：把 analysis/edl/trim.ts 的算術接到 store。
// 與 selectionActions 一樣不經 React 樹，讓快捷鍵、右鍵選單、修剪把手、MCP 工具共用同一套語意。
import { effectId } from "../analysis/effects";
import type { Edl } from "../analysis/edl/build";
import { canSplitAt } from "../analysis/edl/split";
import { planSplitRipple, planTrim, type TrimCandidate, type TrimMode, type TrimSide } from "../analysis/edl/trim";
import { edlFor } from "../pipeline/rules";
import { useDecisions } from "../store/decisions";
import { usePlayback } from "../store/playback";
import { useProject } from "../store/project";
import { useTimeline } from "../store/timeline";
import { useTranscript } from "../store/transcript";
import { formatMs } from "../time";
import { wordIdsInRange } from "./selectionActions";

function mediaCtx() {
  const mediaId = useProject.getState().activeMediaId;
  if (!mediaId) return null;
  const media = useProject.getState().media.find((m) => m.id === mediaId);
  const transcript = useTranscript.getState().byMedia[mediaId] ?? null;
  const durationMs = media?.probe?.duration_ms ?? transcript?.durationMs ?? 0;
  return { mediaId, transcript, durationMs };
}

export interface SeamInfo {
  afterKeepId: number;
  /** 前一段的出點（來源時間）。切點的接縫上與 srcAfterMs 相同。 */
  srcBeforeMs: number;
  srcAfterMs: number;
  /** 是刀片切點造成的接縫（沒有東西被剪掉）。 */
  splitId?: string;
  /** 這一刀插了多長的留白。 */
  gapMs: number;
  kind: "crossfade" | "gap" | "seam";
}

/** 目前 EDL 的所有接縫（時間軸畫把手、[ ] 巡覽、修剪都用這份）。 */
export function seamsOfEdl(edl: Edl | null): SeamInfo[] {
  if (!edl) return [];
  const out: SeamInfo[] = [];
  for (let i = 0; i + 1 < edl.keeps.length; i++) {
    const k = edl.keeps[i];
    const next = edl.keeps[i + 1];
    const j = edl.joins.find((x) => x.afterKeepId === k.id);
    out.push({
      afterKeepId: k.id,
      srcBeforeMs: k.srcEndMs,
      srcAfterMs: next.srcStartMs,
      splitId: j?.splitId,
      gapMs: j?.kind === "gap" ? j.ms : 0,
      kind: j?.kind ?? "crossfade",
    });
  }
  return out;
}

export function currentEdl(): Edl | null {
  const mediaId = useProject.getState().activeMediaId;
  return mediaId ? edlFor(mediaId) : null;
}

/**
 * 刀片：在 ms 切一刀（同位置已有切點則移除）。回傳切完之後那裡有沒有切點；
 * 位置不能切（會切出比 minKeepMs 短的碎片、或落在剪除區裡）時回 null。
 */
export function bladeAt(ms: number): boolean | null {
  const c = mediaCtx();
  if (!c) return null;
  const at = useTimeline.getState().snapMs(ms);
  const edl = currentEdl();
  const existing = (useDecisions.getState().splits[c.mediaId] ?? []).some((s) => Math.abs(s.ms - at) <= 20);
  if (!existing && edl && !canSplitAt(edl.keeps, at, 80)) return null;
  return useDecisions.getState().toggleSplit(c.mediaId, at);
}

export function bladeAtPlayhead(): boolean | null {
  return bladeAt(usePlayback.getState().currentMs);
}

/**
 * 提起（lift）：不關洞，把選取換成靜音。
 *
 * 跟「剪掉」的差別是時間感 —— 咳嗽、關門聲拿掉之後，講者的節奏還在原來的位置。
 * 剪掉會讓後面整串往前跑，配樂與影片對點就全歪了。
 */
export function liftSelection(): string | null {
  const c = mediaCtx();
  const sel = useTimeline.getState().selection;
  if (!c || !sel) return null;
  const id = effectId("mute", sel.startMs, sel.endMs);
  useDecisions.getState().addEffect(c.mediaId, { id, kind: "mute", startMs: sel.startMs, endMs: sel.endMs });
  useTimeline.getState().setSelection(null);
  return id;
}

/**
 * 修剪一個接縫。deltaMs 是「拖了多遠」，一次拖曳只呼叫一次（不要每個 mousemove 都叫，
 * 那會在 undo 歷史裡塞滿幾百筆）。回傳有沒有真的改到東西。
 */
export function trimSeam(afterKeepId: number, deltaMs: number, mode: TrimMode, side: TrimSide): boolean {
  const c = mediaCtx();
  if (!c || !deltaMs) return false;
  const edl = currentEdl();
  const seam = seamsOfEdl(edl).find((s) => s.afterKeepId === afterKeepId);
  if (!edl || !seam) return false;
  const bounds = { minMs: 0, maxMs: c.durationMs };
  const d = useDecisions.getState();

  // 切點的接縫：那裡還沒有剪除區
  if (seam.splitId) {
    if (mode === "roll") {
      d.moveSplit(c.mediaId, seam.splitId, useTimeline.getState().snapMs(seam.srcBeforeMs + deltaMs));
      return true;
    }
    const r = planSplitRipple(seam.srcBeforeMs, deltaMs, side, bounds);
    if (!r) return false;
    d.addManualCut(c.mediaId, r.startMs, r.endMs, wordIdsInRange(c.transcript, r.startMs, r.endMs), `修剪接縫 ${formatMs(seam.srcBeforeMs, { millis: false })}`);
    return true;
  }

  // 一般接縫：改造成它的那段剪除區（可能是好幾個候選合併出來的）
  const removal = edl.removals.find((r) => r.startMs <= seam.srcBeforeMs + 1 && r.endMs >= seam.srcAfterMs - 1);
  const ids = new Set(removal?.candidateIds ?? []);
  const cands: TrimCandidate[] = (d.candidates[c.mediaId] ?? []).filter((x) => ids.has(x.id)).map((x) => ({ id: x.id, startMs: x.startMs, endMs: x.endMs }));
  const next = planTrim(cands, deltaMs, mode, side, bounds);
  if (!next.length) return false;
  for (const n of next) d.updateCandidateRange(c.mediaId, n.id, n.startMs, n.endMs, wordIdsInRange(c.transcript, n.startMs, n.endMs));
  return true;
}

/** 在切點插入 / 移除留白（room tone）。只有切點的接縫可以 —— 一般接縫的呼吸由 breath 自動決定。 */
export function setSeamPause(afterKeepId: number, gapMs: number): boolean {
  const c = mediaCtx();
  if (!c) return false;
  const seam = seamsOfEdl(currentEdl()).find((s) => s.afterKeepId === afterKeepId);
  if (!seam?.splitId) return false;
  useDecisions.getState().setSplitGap(c.mediaId, seam.splitId, gapMs);
  return true;
}

export function removeSeamSplit(afterKeepId: number): boolean {
  const c = mediaCtx();
  if (!c) return false;
  const seam = seamsOfEdl(currentEdl()).find((s) => s.afterKeepId === afterKeepId);
  if (!seam?.splitId) return false;
  useDecisions.getState().removeSplit(c.mediaId, seam.splitId);
  return true;
}
