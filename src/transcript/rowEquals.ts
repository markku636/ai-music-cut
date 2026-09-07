import type { Sentence, Word } from "../analysis/types";
import type { Speaker } from "../analysis/speakers";

export type WordMark = "cut" | "pending" | "";

export interface RowProps {
  sentence: Sentence;
  words: Word[];
  activeWordId: number;
  isActive: boolean;
  marks: { mark: Map<number, WordMark>; cov: Map<number, string[]>; reason: Map<number, string> };
  selectedWordIds: Set<number>;
  selection: { startMs: number; endMs: number } | null;
  onSeek: (ms: number) => void;
  onWordClick: (wordId: number, candidateIds: string[], shift: boolean) => void;
  onWordToggle: (wordId: number) => void;
  onWordMenu?: (wordId: number, x: number, y: number) => void;
  onSentenceSelect?: (s: Sentence) => void;
  hitWordIds?: Set<number>;
  activeHitWordIds?: Set<number>;
  speaker?: Speaker | null;
  showSpeakerName?: boolean;
}

/**
 * 只比**這一列真的會用到的東西**。
 *
 * 預設的淺比較看的是 `marks` / `selectedWordIds` 這些**整份逐字稿共用**的物件 ——
 * 只要有人改了一筆決策，它們就換了識別，於是 1140 列全部重繪（實測接受一筆候選要
 * 3.5–7 秒）。但一列只關心自己那十個字，其餘的變動與它無關。
 *
 * 比較成本：每列約十個字 × 幾個 Map 查找，1140 列加起來遠比重繪一次整份逐字稿便宜。
 */
export function sameRow(a: RowProps, b: RowProps): boolean {
  if (
    a.sentence !== b.sentence ||
    a.words !== b.words ||
    a.isActive !== b.isActive ||
    a.activeWordId !== b.activeWordId ||
    a.speaker !== b.speaker ||
    a.showSpeakerName !== b.showSpeakerName ||
    a.onSeek !== b.onSeek ||
    a.onWordClick !== b.onWordClick ||
    a.onWordToggle !== b.onWordToggle ||
    a.onWordMenu !== b.onWordMenu ||
    a.onSentenceSelect !== b.onSentenceSelect
  ) {
    return false;
  }
  // 選取範圍：只有**與這一句重疊**時才影響這一列（拖選取時其餘的列不必重繪）
  const overlaps = (sel: RowProps["selection"]) => !!sel && sel.startMs < a.sentence.endMs && sel.endMs > a.sentence.startMs;
  if (overlaps(a.selection) !== overlaps(b.selection)) return false;
  if (overlaps(a.selection) && a.selection !== b.selection) return false;

  for (const id of a.sentence.wordIds) {
    if (a.marks.mark.get(id) !== b.marks.mark.get(id)) return false;
    if (a.marks.reason.get(id) !== b.marks.reason.get(id)) return false;
    if (a.selectedWordIds.has(id) !== b.selectedWordIds.has(id)) return false;
    if (!!a.hitWordIds?.has(id) !== !!b.hitWordIds?.has(id)) return false;
    if (!!a.activeHitWordIds?.has(id) !== !!b.activeHitWordIds?.has(id)) return false;
    // 覆蓋的候選 id 會傳進 onWordClick，內容變了行為就變了
    const ca = a.marks.cov.get(id);
    const cb = b.marks.cov.get(id);
    if ((ca?.length ?? 0) !== (cb?.length ?? 0)) return false;
    if (ca && cb) for (let i = 0; i < ca.length; i++) if (ca[i] !== cb[i]) return false;
  }
  return true;
}
