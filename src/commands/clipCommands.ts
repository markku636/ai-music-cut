import { FileInput } from "lucide-react";
import { api, errMessage } from "../api";
import { AUDIO_EXTENSIONS } from "../brand";
import { mapSrcToOut } from "../analysis/edl/map";
import { overlayId, type Overlay } from "../analysis/overlays";
import { t } from "../i18n";
import { edlFor } from "../pipeline/rules";
import { useDecisions } from "../store/decisions";
import { useProject } from "../store/project";
import { useTimeline } from "../store/timeline";
import { pickOpenFile, toast } from "../ui";
import { activeId, needsSelection } from "./guards";
import type { Command } from "./types";
import { withUndoToast } from "./undoToast";

/**
 * 「選取區間單獨匯入」：把一個外部音檔放進目前選取的位置（音效軌 overlay），長度以選取為準。
 * 不動原檔、不動 EDL：它是疊在成品上的一段，位置錨在成品時間（跟配樂一樣）；一筆 undo。
 */
export async function importIntoSelection(path?: string): Promise<string | null> {
  const mainId = activeId();
  const sel = useTimeline.getState().selection;
  if (!mainId || !sel) return null;
  const p = path ?? (await pickOpenFile([{ name: t("音訊"), extensions: AUDIO_EXTENSIONS }]));
  if (!p) return null;
  let clipId: string;
  try {
    clipId = await useProject.getState().openMedia(p, { activate: false });
  } catch (e) {
    toast.error(errMessage(e));
    return null;
  }
  const clip = useProject.getState().media.find((m) => m.id === clipId);
  let clipMs = clip?.probe?.duration_ms ?? 0;
  if (!clipMs) clipMs = await api.mediaProbe(p).then((x) => x.duration_ms).catch(() => 0);
  const slotMs = sel.endMs - sel.startMs;
  // 素材比選取長就截到選取長度；比選取短就照素材長度放（不拉伸）
  const useMs = Math.min(clipMs || slotMs, slotMs);
  const edl = edlFor(mainId);
  const outStartMs = edl ? mapSrcToOut(edl.keeps, sel.startMs) : sel.startMs;
  const o: Overlay = {
    id: overlayId("sfx", outStartMs),
    lane: "sfx",
    mediaId: clipId,
    srcInMs: 0,
    srcOutMs: Math.max(50, useMs),
    outStartMs,
    // 錨在選取的來源時間：之後剪掉前面的字，這段素材跟著它蓋住的內容走
    anchorSrcMs: sel.startMs,
    gainDb: 0,
    fadeInMs: 10,
    fadeOutMs: 10,
    role: "sfx",
  };
  await withUndoToast(
    clipMs > slotMs + 1 ? t("已放進選取的位置（素材比選取長，只放前 {s} 秒）", { s: (useMs / 1000).toFixed(1) }) : t("已放進選取的位置"),
    () => useDecisions.getState().addOverlays(mainId, [o], "匯入到選取區間"),
  );
  return o.id;
}

export const CLIP_COMMANDS: Command[] = [
  {
    id: "edit.importIntoSelection",
    title: "把音檔放進選取區間…",
    group: "edit",
    section: "選取",
    icon: FileInput,
    surfaces: ["menu", "palette", "context", "simple"],
    simple: true,
    simpleLabel: "放一段音檔進來",
    simpleHint: "選一個音檔，放進選的這一段（原檔不動，可復原）",
    keywords: ["import", "insert", "place", "clip", "sfx"],
    enabled: needsSelection,
    run: () => void importIntoSelection(),
  },
];
