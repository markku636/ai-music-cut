import { create } from "zustand";
import { snapToBeat, type BeatGrid } from "../analysis/beats";

/** 時間軸縮放與工具狀態。pxPerSec = null 代表「整段適配」（fit-to-width），由 Timeline 依容器寬度算出 fitPxPerSec。 */
export const MAX_PX_PER_SEC = 500;

export type TimelineTool = "seek" | "select";

export interface TimeSelection {
  startMs: number;
  endMs: number;
}

interface TimelineStore {
  pxPerSec: number | null;
  fitPxPerSec: number;
  /** 波形容器寬度（px），縮放到選取用。 */
  viewWidth: number;
  showLoudness: boolean;
  /** seek：點擊 / 拖曳定位；select：拖曳選取一段（手動剪輯）。 */
  tool: TimelineTool;
  /** 目前的時間選取（select 工具拖出來、或逐字稿 Shift+點）。 */
  selection: TimeSelection | null;
  /** 播放選取時是否循環。 */
  loopSelection: boolean;
  /** 一次性捲動請求（Timeline 消費）。 */
  scrollReq: { ms: number; nonce: number } | null;
  /** 目前媒體的拍網格（剪音樂用；語音檔信心低時為 null）。 */
  beatGrid: BeatGrid | null;
  /** 時間軸上顯示拍線 / 小節線。 */
  showBeats: boolean;
  /** 選取自動貼齊拍點（剪在拍子上才不會破）。 */
  snapBeats: boolean;
  setBeatGrid: (g: BeatGrid | null) => void;
  toggleBeats: () => void;
  toggleSnap: () => void;
  setFit: (px: number, viewWidth?: number) => void;
  setPxPerSec: (px: number | null) => void;
  zoomBy: (factor: number) => void;
  fit: () => void;
  zoomToSelection: () => void;
  scrollTo: (ms: number) => void;
  toggleLoudness: () => void;
  setTool: (tool: TimelineTool) => void;
  setSelection: (sel: TimeSelection | null) => void;
  toggleLoop: () => void;
}

/** 夾在 [fit, MAX]；fit 以下沒有意義（波形比容器窄）。 */
export function clampZoom(px: number, fit: number): number {
  const lo = Math.max(0.01, fit);
  return Math.max(lo, Math.min(MAX_PX_PER_SEC, px));
}

/** 從目前值乘上倍率；落回 fit（含誤差）就回 null 代表整段適配。 */
export function nextZoom(cur: number | null, fit: number, factor: number): number | null {
  const next = clampZoom((cur ?? fit) * factor, fit);
  return next <= fit * 1.001 ? null : next;
}

function readTool(): TimelineTool {
  try {
    return localStorage.getItem("aicut:tool") === "seek" ? "seek" : "select";
  } catch {
    return "select";
  }
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

function writeBool(key: string, v: boolean) {
  try {
    localStorage.setItem(key, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export const useTimeline = create<TimelineStore>((set, get) => ({
  pxPerSec: null,
  fitPxPerSec: 1,
  viewWidth: 800,
  showLoudness: readBool("aicut:showLoudness", false),
  tool: readTool(),
  selection: null,
  loopSelection: readBool("aicut:loopSelection", false),
  scrollReq: null,
  beatGrid: null,
  showBeats: readBool("aicut:showBeats", true),
  snapBeats: readBool("aicut:snapBeats", true),
  setBeatGrid: (g) => set({ beatGrid: g }),
  toggleBeats: () =>
    set((s) => {
      writeBool("aicut:showBeats", !s.showBeats);
      return { showBeats: !s.showBeats };
    }),
  toggleSnap: () =>
    set((s) => {
      writeBool("aicut:snapBeats", !s.snapBeats);
      return { snapBeats: !s.snapBeats };
    }),
  setFit: (px, viewWidth) => set((s) => ({ fitPxPerSec: Math.max(0.01, px), viewWidth: viewWidth ?? s.viewWidth })),
  setPxPerSec: (px) => set({ pxPerSec: px == null ? null : clampZoom(px, get().fitPxPerSec) }),
  zoomBy: (factor) => set((s) => ({ pxPerSec: nextZoom(s.pxPerSec, s.fitPxPerSec, factor) })),
  fit: () => set({ pxPerSec: null }),
  zoomToSelection: () => {
    const { selection, viewWidth, fitPxPerSec } = get();
    if (!selection) return;
    const len = Math.max(0.05, (selection.endMs - selection.startMs) / 1000);
    const px = nextZoom(null, fitPxPerSec, (viewWidth * 0.8) / len / fitPxPerSec);
    set({ pxPerSec: px });
    if (px !== null) get().scrollTo(Math.max(0, selection.startMs - len * 1000 * 0.1));
  },
  scrollTo: (ms) => set((s) => ({ scrollReq: { ms: Math.max(0, ms), nonce: (s.scrollReq?.nonce ?? 0) + 1 } })),
  toggleLoudness: () =>
    set((s) => {
      writeBool("aicut:showLoudness", !s.showLoudness);
      return { showLoudness: !s.showLoudness };
    }),
  setTool: (tool) => {
    try {
      localStorage.setItem("aicut:tool", tool);
    } catch {
      /* ignore */
    }
    set({ tool });
  },
  setSelection: (sel) => {
    if (!sel) {
      set({ selection: null });
      return;
    }
    const st = get();
    // 貼齊拍點：容差取半拍與 140 ms 的較小者，避免把很短的選取吸掉
    const grid = st.snapBeats ? st.beatGrid : null;
    const tol = grid ? Math.min(140, grid.periodMs / 2) : 0;
    const startMs = Math.max(0, snapToBeat(grid, Math.min(sel.startMs, sel.endMs), tol));
    const endMs = snapToBeat(grid, Math.max(sel.startMs, sel.endMs), tol);
    set({ selection: endMs - startMs < 20 ? null : { startMs: Math.round(startMs), endMs: Math.round(endMs) } });
  },
  toggleLoop: () =>
    set((s) => {
      writeBool("aicut:loopSelection", !s.loopSelection);
      return { loopSelection: !s.loopSelection };
    }),
}));
