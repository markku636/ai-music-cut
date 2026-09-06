import { create } from "zustand";
import { applyOverride, NO_OVERRIDE, tapTempo, type BeatGrid, type GridOverride } from "../analysis/beats";
import { collectTargets, snapValue, toleranceMs, type SnapEnabled, type SnapKind, type SnapSources, type SnapTarget } from "../analysis/snap";
import { usePlayback } from "./playback";

/** 時間軸縮放與工具狀態。pxPerSec = null 代表「整段適配」（fit-to-width），由 Timeline 依容器寬度算出 fitPxPerSec。 */
export const MAX_PX_PER_SEC = 500;

export type TimelineTool = "seek" | "select" | "trim";

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
  /** seek：點擊 / 拖曳定位；select：拖曳選取一段（手動剪輯）；trim：抓接縫做漣漪 / 捲動修剪。 */
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
  /**
   * 吸附：拖曳、切刀、修剪、逐字稿選取全部吸到同一組目標。
   * enabled 是總開關（快捷鍵 N），四個子項各自可關。
   */
  snap: SnapEnabled & { enabled: boolean };
  /** 吸附目標的來源（接縫 / 句界 / 字界 / 播放線 / 長度），由 UI 在 EDL 或逐字稿變動時餵進來。 */
  snapSources: SnapSources;
  /** 由 snapSources × snap 預先攤平；拖曳過程中每一幀都要用，不能每次重算。 */
  snapTargets: SnapTarget[];
  /** 最近一次吸到哪裡（波形上畫指示線）。 */
  lastSnapHit: { ms: number; kind: SnapKind } | null;
  /** AI 偵測到的原始網格（未套人工修正）。 */
  rawGrid: BeatGrid | null;
  gridOverride: GridOverride;
  /** 敲拍的時間戳（毫秒，效能計時）。 */
  taps: number[];
  setBeatGrid: (g: BeatGrid | null) => void;
  /** 倍速 / 半速（AI 抓成半拍時一鍵修正）。 */
  scaleGrid: (factor: number) => void;
  /** 把某個時間點設成小節首拍。 */
  setDownbeatAt: (ms: number) => void;
  /** 敲一下（≥3 下就套用測到的 BPM）；回目前測到的 BPM。 */
  tap: (nowMs: number) => number | null;
  resetGrid: () => void;
  toggleBeats: () => void;
  /** 吸附總開關（N）。 */
  toggleSnap: () => void;
  setSnapKind: (kind: keyof SnapEnabled, on: boolean) => void;
  setSnapSources: (src: SnapSources) => void;
  /** 吸附一個時間值（拖曳接縫 / 切刀 / 微調都走這支），順便記下吸到哪。 */
  snapMs: (ms: number) => number;
  clearSnapHit: () => void;
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
    const v = localStorage.getItem("aicut:tool");
    return v === "seek" || v === "trim" ? v : "select";
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

/**
 * 目前縮放下的吸附設定。容差用像素換算：畫面上永遠是同樣的幾個像素寬。
 *
 * 播放線刻意不放進 snapTargets：它每秒變動 60 次，塞進去等於每一幀都要重算整份目標
 * （長檔可以有兩萬個字界）。改成算 context 時才附上去，成本是一個陣列 concat。
 */
function snapContextOf(s: Pick<TimelineStore, "snap" | "snapTargets" | "beatGrid" | "pxPerSec" | "fitPxPerSec">) {
  const playhead = usePlayback.getState().currentMs;
  return {
    enabled: s.snap.enabled,
    targets: Number.isFinite(playhead) && playhead > 0 ? [...s.snapTargets, { ms: playhead, kind: "playhead" as const }] : s.snapTargets,
    grid: s.snap.beats ? s.beatGrid : null,
    tolMs: toleranceMs(s.pxPerSec ?? s.fitPxPerSec),
  };
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
  rawGrid: null,
  gridOverride: NO_OVERRIDE,
  taps: [],
  showBeats: readBool("aicut:showBeats", true),
  snap: {
    enabled: readBool("aicut:snapEnabled", true),
    beats: readBool("aicut:snapBeats", true),
    seams: readBool("aicut:snapSeams", true),
    sentences: readBool("aicut:snapSentences", true),
    words: readBool("aicut:snapWords", false),
  },
  snapSources: {},
  snapTargets: [{ ms: 0, kind: "bound" }],
  lastSnapHit: null,
  setBeatGrid: (g) => set({ rawGrid: g, gridOverride: NO_OVERRIDE, taps: [], beatGrid: g }),
  scaleGrid: (factor) =>
    set((s) => {
      const ov = { ...s.gridOverride, bpmScale: Math.max(0.25, Math.min(4, s.gridOverride.bpmScale * factor)) };
      return { gridOverride: ov, beatGrid: applyOverride(s.rawGrid, ov) };
    }),
  setDownbeatAt: (ms) =>
    set((s) => {
      const g = s.beatGrid;
      if (!g?.periodMs) return {};
      const barMs = g.periodMs * g.beatsPerBar;
      // 讓 ms 落在小節線上：位移量取 [−半小節, +半小節)
      let delta = (ms - g.offsetMs) % barMs;
      if (delta > barMs / 2) delta -= barMs;
      const ov = { ...s.gridOverride, offsetDeltaMs: s.gridOverride.offsetDeltaMs + delta };
      return { gridOverride: ov, beatGrid: applyOverride(s.rawGrid, ov) };
    }),
  tap: (nowMs) => {
    const taps = [...get().taps.filter((t) => nowMs - t < 4000), nowMs];
    const bpm = tapTempo(taps);
    if (bpm && get().rawGrid) {
      const raw = get().rawGrid!;
      const ov = { ...get().gridOverride, bpmScale: raw.periodMs / (60000 / bpm) };
      set({ taps, gridOverride: ov, beatGrid: applyOverride(raw, ov) });
    } else set({ taps });
    return bpm;
  },
  resetGrid: () => set((s) => ({ gridOverride: NO_OVERRIDE, taps: [], beatGrid: s.rawGrid })),
  toggleBeats: () =>
    set((s) => {
      writeBool("aicut:showBeats", !s.showBeats);
      return { showBeats: !s.showBeats };
    }),
  toggleSnap: () =>
    set((s) => {
      writeBool("aicut:snapEnabled", !s.snap.enabled);
      return { snap: { ...s.snap, enabled: !s.snap.enabled }, lastSnapHit: null };
    }),
  setSnapKind: (kind, on) =>
    set((s) => {
      writeBool(`aicut:snap${kind[0].toUpperCase()}${kind.slice(1)}`, on);
      const snap = { ...s.snap, [kind]: on };
      return { snap, snapTargets: collectTargets(s.snapSources, snap), lastSnapHit: null };
    }),
  setSnapSources: (src) => set((s) => ({ snapSources: src, snapTargets: collectTargets(src, s.snap) })),
  snapMs: (ms) => {
    const s = get();
    const r = snapValue(ms, snapContextOf(s));
    set({ lastSnapHit: r.kind ? { ms: r.ms, kind: r.kind } : null });
    return r.ms;
  },
  clearSnapHit: () => set({ lastSnapHit: null }),
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
    // 吸附的唯一入口：波形拖曳、逐字稿 Shift+點、右鍵、AI 工具都會經過這裡，
    // 所以同一個位置在哪個介面上操作都會停在同一個地方。
    const ctx = snapContextOf(st);
    const startMs = Math.max(0, snapValue(Math.min(sel.startMs, sel.endMs), ctx).ms);
    const endMs = snapValue(Math.max(sel.startMs, sel.endMs), ctx).ms;
    set({ selection: endMs - startMs < 20 ? null : { startMs: Math.round(startMs), endMs: Math.round(endMs) } });
  },
  toggleLoop: () =>
    set((s) => {
      writeBool("aicut:loopSelection", !s.loopSelection);
      return { loopSelection: !s.loopSelection };
    }),
}));
