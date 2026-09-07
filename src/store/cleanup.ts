import { create } from "zustand";
import { CLEANUP_OFF, normalizeCleanup, type CleanupSpec } from "../analysis/cleanup";
import type { NoisePrint } from "../analysis/levels";
import { useProject } from "./project";

/**
 * 每個媒體的修聲設定。
 *
 * 刻意**不**放進 decisions store：那裡是「剪了什麼」的權威狀態，每一次變動都進 undo。
 * 修聲是輸出設定，跟目標響度同一類 —— 調降噪量不該和「剪掉這一句」擠在同一條復原歷史上。
 * 存檔一樣會帶（走 pipeline/persist.ts），所以重開專案設定還在。
 */
interface CleanupStore {
  byMedia: Record<string, CleanupSpec>;
  /** 噪音樣本（量測值，不進 undo；存專案檔）。之後範圍降噪與整檔修聲的底噪都預設吃它。 */
  noisePrint: Record<string, NoisePrint>;
  setNoisePrint: (mediaId: string, p: NoisePrint | null) => void;
  loadNoisePrint: (mediaId: string, p: NoisePrint | null) => void;
  /** 有設定才回，沒有回 null（呼叫端自己決定要不要用建議值）。 */
  get: (mediaId: string) => CleanupSpec | null;
  set: (mediaId: string, spec: Partial<CleanupSpec> | null) => void;
  /** 載入專案用：不標記 dirty。 */
  load: (mediaId: string, spec: CleanupSpec | null) => void;
}

export const useCleanup = create<CleanupStore>((set, get) => ({
  byMedia: {},
  noisePrint: {},
  setNoisePrint: (mediaId, p) => {
    set((s) => {
      const noisePrint = { ...s.noisePrint };
      if (p) noisePrint[mediaId] = p;
      else delete noisePrint[mediaId];
      return { noisePrint };
    });
    useProject.getState().markDirty();
  },
  loadNoisePrint: (mediaId, p) =>
    set((s) => {
      const noisePrint = { ...s.noisePrint };
      if (p) noisePrint[mediaId] = p;
      else delete noisePrint[mediaId];
      return { noisePrint };
    }),
  get: (mediaId) => get().byMedia[mediaId] ?? null,
  set: (mediaId, spec) => {
    set((s) => {
      const byMedia = { ...s.byMedia };
      if (spec) byMedia[mediaId] = normalizeCleanup({ ...CLEANUP_OFF, ...byMedia[mediaId], ...spec });
      else delete byMedia[mediaId];
      return { byMedia };
    });
    useProject.getState().markDirty();
  },
  load: (mediaId, spec) =>
    set((s) => {
      const byMedia = { ...s.byMedia };
      if (spec) byMedia[mediaId] = normalizeCleanup(spec);
      else delete byMedia[mediaId];
      return { byMedia };
    }),
}));
