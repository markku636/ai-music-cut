import { create } from "zustand";

interface PlaybackStore {
  /** 來源時間軸上的播放位置（ms）。 */
  currentMs: number;
  playing: boolean;
  rate: number;
  /** 播放時跳過已剪除區段（false = 播放原始）。 */
  skipEnabled: boolean;
  /** 逐字稿 / 時間軸跟隨播放位置。 */
  follow: boolean;
  /** 一次性 seek 請求（AudioPlayer 消費）；nonce 讓同一 ms 也能重複觸發。 */
  seekReq: { ms: number; nonce: number } | null;
  seek: (ms: number) => void;
  setCurrent: (ms: number) => void;
  setPlaying: (b: boolean) => void;
  setRate: (r: number) => void;
  toggleSkip: () => void;
  toggleFollow: () => void;
}

export const useplayback = create<PlaybackStore>((set) => ({
  currentMs: 0,
  playing: false,
  rate: 1,
  skipEnabled: true,
  follow: true,
  seekReq: null,
  seek: (ms) => set((s) => ({ currentMs: Math.max(0, ms), seekReq: { ms: Math.max(0, ms), nonce: (s.seekReq?.nonce ?? 0) + 1 } })),
  setCurrent: (ms) => set({ currentMs: ms }),
  setPlaying: (b) => set({ playing: b }),
  setRate: (r) => set({ rate: r }),
  toggleSkip: () => set((s) => ({ skipEnabled: !s.skipEnabled })),
  toggleFollow: () => set((s) => ({ follow: !s.follow })),
}));

export const usePlayback = useplayback;
