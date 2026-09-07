import { create } from "zustand";
import type { SpliceAuditReport } from "../analysis/spliceAudit";
import type { VerifyReport } from "../analysis/verify";

export interface StoredVerifyReport extends VerifyReport {
  /** 被驗證的成品檔。 */
  outPath: string;
  at: string;
}

export interface StoredSpliceReport extends SpliceAuditReport {
  outPath: string;
  at: string;
}

export interface LastOutput {
  path: string;
  /**
   * 這份輸出計畫「預期」的成品長度（毫秒）。
   * 注意不是 edl.stats.keptMs —— 那是保留段的來源總長，沒扣 crossfade 重疊也沒加 room tone，
   * 拿它比對成品時間軸會每刀誤差約 20 ms。正解是 buildRenderPlan 的 expectedOutMs。
   */
  expectedOutMs: number | null;
  /** ffmpeg 實測（給交付前的響度守門）。 */
  outputLufs?: number | null;
  outputTp?: number | null;
  targetLufs?: number;
  /** 範圍濾波動過的成品區段；correlated=false（反轉 / 變調）的段落驗收不比波形相似度。 */
  fxSpans?: { startMs: number; endMs: number; correlated: boolean }[];
}

interface VerifyStore {
  byMedia: Record<string, StoredVerifyReport>;
  /** 音訊比對（不需逐字稿，音樂也能驗）。 */
  spliceByMedia: Record<string, StoredSpliceReport>;
  setSplice: (mediaId: string, r: StoredSpliceReport) => void;
  running: Record<string, boolean>;
  /** 每個媒體最近一次成功輸出的檔案（重開 App 不保留）。 */
  lastOutput: Record<string, LastOutput>;
  setLastOutput: (mediaId: string, out: LastOutput) => void;
  setReport: (mediaId: string, r: StoredVerifyReport) => void;
  setRunning: (mediaId: string, v: boolean) => void;
  clear: (mediaId: string) => void;
}

/** ASR 驗收報告（執行期，不進專案檔；重新輸出後自動失效由呼叫端 clear）。 */
export const useVerify = create<VerifyStore>((set) => ({
  byMedia: {},
  spliceByMedia: {},
  setSplice: (mediaId, r) => set((s) => ({ spliceByMedia: { ...s.spliceByMedia, [mediaId]: r } })),
  running: {},
  lastOutput: {},
  setLastOutput: (mediaId, out) => set((s) => ({ lastOutput: { ...s.lastOutput, [mediaId]: out } })),
  setReport: (mediaId, r) => set((s) => ({ byMedia: { ...s.byMedia, [mediaId]: r } })),
  setRunning: (mediaId, v) => set((s) => ({ running: { ...s.running, [mediaId]: v } })),
  clear: (mediaId) =>
    set((s) => {
      const byMedia = { ...s.byMedia };
      const spliceByMedia = { ...s.spliceByMedia };
      delete byMedia[mediaId];
      delete spliceByMedia[mediaId];
      return { byMedia, spliceByMedia };
    }),
}));
