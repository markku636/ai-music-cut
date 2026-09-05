import { create } from "zustand";

export interface PreviewRange {
  startMs: number;
  endMs: number;
  /** 預聽期間是否沿用跳播。 */
  skip: boolean;
}

/**
 * 播放跟隨模式。舊版是布林值 `follow`，開著就同時打開 wavesurfer 的 autoScroll + autoCenter ——
 * 線因此被釘在畫面正中央、動的是波形，使用者的體感就是「線不會動」。
 * 拆成三態後預設 "page"：線自己往右走，跑到右緣才翻一頁。
 */
export type FollowMode = "off" | "page" | "center";

/** UI 的循環順序（Crosshair 按鈕）。 */
export const FOLLOW_MODES: FollowMode[] = ["page", "center", "off"];

interface PlaybackStore {
  /** 來源時間軸上的播放位置（ms）。 */
  currentMs: number;
  playing: boolean;
  rate: number;
  /** 播放時跳過已剪除區段（false = 播放原始）。 */
  skipEnabled: boolean;
  /** 逐字稿 / 時間軸跟隨播放位置（見 FollowMode）。 */
  followMode: FollowMode;
  /** 一次性 seek 請求（AudioPlayer 消費）；nonce 讓同一 ms 也能重複觸發。 */
  seekReq: { ms: number; nonce: number } | null;
  /** 預聽中的範圍（playerRef.playRange 設定）。 */
  preview: PreviewRange | null;
  seek: (ms: number) => void;
  setCurrent: (ms: number) => void;
  setPlaying: (b: boolean) => void;
  setRate: (r: number) => void;
  toggleSkip: () => void;
  /** 依 FOLLOW_MODES 的順序切到下一個模式。 */
  cycleFollow: () => void;
  setFollowMode: (m: FollowMode) => void;
  setPreview: (p: PreviewRange | null) => void;
}

export const usePlayback = create<PlaybackStore>((set) => ({
  currentMs: 0,
  playing: false,
  rate: 1,
  skipEnabled: true,
  followMode: "page",
  seekReq: null,
  preview: null,
  seek: (ms) => set((s) => ({ currentMs: Math.max(0, ms), seekReq: { ms: Math.max(0, ms), nonce: (s.seekReq?.nonce ?? 0) + 1 } })),
  setCurrent: (ms) => set({ currentMs: ms }),
  setPlaying: (b) => set({ playing: b }),
  setRate: (r) => set({ rate: r }),
  toggleSkip: () => set((s) => ({ skipEnabled: !s.skipEnabled })),
  cycleFollow: () =>
    set((s) => ({ followMode: FOLLOW_MODES[(FOLLOW_MODES.indexOf(s.followMode) + 1) % FOLLOW_MODES.length] })),
  setFollowMode: (m) => set({ followMode: m }),
  setPreview: (p) => set({ preview: p }),
}));
