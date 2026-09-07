// 音軌的剪下 / 複製 / 貼上 / 搬移。
//
// 剪貼簿只存**一段來源範圍**（起訖時間），不存音訊本身 —— 貼上的時候是叫剪接器
// 再去讀同一個來源檔的那一段。所以複製一段 10 分鐘的內容是零成本的，
// 而且貼上之後如果又去修剪了原本那一段，貼上的那份**不會**跟著變（它記的是時間，不是內容）。
//
// 搬移 = 剪下 + 貼上，中間不落地。做成一個動作而不是兩個，是因為使用者心裡那是一件事，
// 而且分成兩筆 undo 的話「搬移到一半」是一個壞掉的中間狀態。
import { useDecisions } from "../store/decisions";
import { useProject } from "../store/project";
import { useTimeline } from "../store/timeline";
import { useTranscript } from "../store/transcript";
import { usePlayback } from "../store/playback";
import { formatMs } from "../time";

export interface ClipboardRange {
  mediaId: string;
  startMs: number;
  endMs: number;
}

/**
 * 剪貼簿是**模組層的狀態**，不進 store。
 *
 * 它不是專案內容的一部分：關掉 App 再打開，剪貼簿本來就該是空的，
 * 存進專案檔只會讓「這個專案裡怎麼有一段莫名其妙的剪貼簿」變成一個要解釋的東西。
 */
let clip: ClipboardRange | null = null;

export function clipboard(): ClipboardRange | null {
  return clip;
}

export function clearClipboard(): void {
  clip = null;
}

function ctx() {
  const mediaId = useProject.getState().activeMediaId;
  const sel = useTimeline.getState().selection;
  return mediaId && sel ? { mediaId, sel } : null;
}

/** 複製目前選取（不動剪輯）。回傳有沒有複製到。 */
export function copySelection(): boolean {
  const c = ctx();
  if (!c) return false;
  clip = { mediaId: c.mediaId, startMs: c.sel.startMs, endMs: c.sel.endMs };
  return true;
}

/**
 * 剪下目前選取：放進剪貼簿，並把它剪掉（手動候選，一筆 undo）。
 * 回傳新增的候選 id。
 */
export function cutSelectionToClipboard(): string | null {
  const c = ctx();
  if (!c) return null;
  clip = { mediaId: c.mediaId, startMs: c.sel.startMs, endMs: c.sel.endMs };
  const tr = useTranscript.getState().byMedia[c.mediaId];
  const wordIds = (tr?.words ?? []).filter((w) => w.startMs < c.sel.endMs && w.endMs > c.sel.startMs).map((w) => w.id);
  const sentenceId = wordIds.length ? (tr?.sentences.find((x) => x.wordIds.includes(wordIds[0]))?.id ?? -1) : -1;
  const id = useDecisions
    .getState()
    .addManualCut(c.mediaId, c.sel.startMs, c.sel.endMs, wordIds, `剪下 ${formatMs(c.sel.startMs, { millis: false })}–${formatMs(c.sel.endMs, { millis: false })}`, sentenceId);
  useTimeline.getState().setSelection(null);
  return id;
}

/**
 * 把剪貼簿貼到播放線的位置。
 *
 * **只能貼回同一個媒體**：貼上記的是「來源檔的哪一段」，跨媒體貼上要的是另一個來源檔，
 * 那是多軌的事（RenderSeg 目前沒有 src 欄位）。與其做出一個會安靜貼錯內容的東西，
 * 不如明講不支援。
 */
export function pasteAtPlayhead(): string | null {
  const mediaId = useProject.getState().activeMediaId;
  if (!mediaId || !clip || clip.mediaId !== mediaId) return null;
  const at = usePlayback.getState().currentMs;
  return useDecisions.getState().addPaste(mediaId, clip.startMs, clip.endMs, at, `貼上 ${formatMs(at, { millis: false })}`);
}

/**
 * 搬移：把目前選取剪掉，並貼到播放線的位置。
 *
 * 播放線落在選取範圍**裡面**時不做事 —— 那等於「搬到自己身上」，
 * 使用者多半是忘了先把播放線移開，安靜地做一件沒有意義的事比擋下來更糟。
 */
export function moveSelectionToPlayhead(): boolean {
  const c = ctx();
  if (!c) return false;
  const at = usePlayback.getState().currentMs;
  if (at > c.sel.startMs && at < c.sel.endMs) return false;
  const cutId = cutSelectionToClipboard();
  if (!cutId) return false;
  return pasteAtPlayhead() != null;
}
