import { create } from "zustand";
import type { ReelRange } from "../analysis/reel";
import { useProject } from "./project";

/**
 * 精華片段：要串成預告的那幾段。
 *
 * 跟 `cleanup` 一樣**不進 undo**：它不是剪輯，是「我挑了哪幾段」的收藏，
 * 而且畫面上就是一份可以逐筆刪掉的清單 —— 有明確的移除按鈕時，
 * 把它塞進剪輯的復原歷史只會讓 Ctrl+Z 變得難以預期。
 * 存檔照樣會帶（`pipeline/persist.ts`）。
 */
interface HighlightsStore {
  byMedia: Record<string, ReelRange[]>;
  list: (mediaId: string) => ReelRange[];
  /** 加一段；回傳 id。重疊的段落不會被擋（輸出時 normalizeRanges 會合併）。 */
  add: (mediaId: string, startMs: number, endMs: number, title?: string) => string;
  update: (mediaId: string, id: string, patch: Partial<Omit<ReelRange, "id">>) => void;
  remove: (mediaId: string, id: string) => void;
  clear: (mediaId: string) => void;
  /** 載入專案用：不標記 dirty。 */
  load: (mediaId: string, ranges: ReelRange[]) => void;
}

let seq = 0;

export const useHighlights = create<HighlightsStore>((set, get) => {
  const write = (mediaId: string, next: ReelRange[]) => {
    set((s) => ({ byMedia: { ...s.byMedia, [mediaId]: next } }));
    useProject.getState().markDirty();
  };
  return {
    byMedia: {},
    list: (mediaId) => get().byMedia[mediaId] ?? [],
    add: (mediaId, startMs, endMs, title) => {
      const id = `hl${++seq}-${Math.round(startMs)}`;
      const next = [...(get().byMedia[mediaId] ?? []), { id, startMs, endMs, title }].sort((a, b) => a.startMs - b.startMs);
      write(mediaId, next);
      return id;
    },
    update: (mediaId, id, patch) =>
      write(
        mediaId,
        (get().byMedia[mediaId] ?? []).map((h) => (h.id === id ? { ...h, ...patch } : h)).sort((a, b) => a.startMs - b.startMs),
      ),
    remove: (mediaId, id) => write(mediaId, (get().byMedia[mediaId] ?? []).filter((h) => h.id !== id)),
    clear: (mediaId) => write(mediaId, []),
    load: (mediaId, ranges) =>
      set((s) => {
        const byMedia = { ...s.byMedia };
        if (ranges.length) byMedia[mediaId] = [...ranges].sort((a, b) => a.startMs - b.startMs);
        else delete byMedia[mediaId];
        return { byMedia };
      }),
  };
});
