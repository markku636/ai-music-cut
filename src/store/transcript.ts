import { create } from "zustand";
import type { LocalAnalysis } from "../analysis/peaks";
import type { Transcript, Word } from "../analysis/types";

/** 每個媒體的執行期分析資料：逐字稿（也存進專案檔）+ 本機波形/響度（只快取磁碟、不進專案檔）。 */
interface TranscriptStore {
  byMedia: Record<string, Transcript>;
  local: Record<string, LocalAnalysis>;
  setTranscript: (mediaId: string, t: Transcript | null) => void;
  setLocal: (mediaId: string, a: LocalAnalysis | null) => void;
}

export const useTranscript = create<TranscriptStore>((set) => ({
  byMedia: {},
  local: {},
  setTranscript: (mediaId, t) =>
    set((s) => {
      const byMedia = { ...s.byMedia };
      if (t) byMedia[mediaId] = t;
      else delete byMedia[mediaId];
      return { byMedia };
    }),
  setLocal: (mediaId, a) =>
    set((s) => {
      const local = { ...s.local };
      if (a) local[mediaId] = a;
      else delete local[mediaId];
      return { local };
    }),
}));

/** 含 ms 的字（或最近的前一個字）的索引；words 需依 startMs 排序。無字回 -1。 */
export function wordIndexAt(words: Word[], ms: number): number {
  let lo = 0;
  let hi = words.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].startMs <= ms) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}
