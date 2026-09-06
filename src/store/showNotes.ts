import { create } from "zustand";
import type { ShowNotes } from "../analysis/shownotes";
import { useProject } from "./project";

/**
 * 產好的節目筆記。
 *
 * 跟 cleanup / highlights 一樣**不進 undo** —— 它是產出物，不是編輯。
 * 存進專案檔的理由很實際：重跑一次要 claude 讀完整集（幾十秒到一兩分鐘），
 * 而且已經貼到部落格的那一份，關掉視窗就找不回來會很煩。
 */
interface ShowNotesStore {
  byMedia: Record<string, ShowNotes>;
  get: (mediaId: string) => ShowNotes | null;
  set: (mediaId: string, notes: ShowNotes | null) => void;
  /** 載入專案用：不標記 dirty。 */
  load: (mediaId: string, notes: ShowNotes | null) => void;
}

export const useShowNotes = create<ShowNotesStore>((set, get) => {
  const write = (mediaId: string, notes: ShowNotes | null, dirty: boolean) => {
    set((s) => {
      const byMedia = { ...s.byMedia };
      if (notes) byMedia[mediaId] = notes;
      else delete byMedia[mediaId];
      return { byMedia };
    });
    if (dirty) useProject.getState().markDirty();
  };
  return {
    byMedia: {},
    get: (mediaId) => get().byMedia[mediaId] ?? null,
    set: (mediaId, notes) => write(mediaId, notes, true),
    load: (mediaId, notes) => write(mediaId, notes, false),
  };
});
