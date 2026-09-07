// 介面外觀狀態（右側欄分頁 / 寬度 / 密度）。存 localStorage —— 這些是「習慣」，
// 不是專案內容，不該進專案檔、也不該跟著檔案走。
import { create } from "zustand";

export type RailTab = "decisions" | "index" | "history" | "assistant" | "verify";
export type Density = "compact" | "normal" | "comfortable";
/** 簡易（小白）/ 專業。兩邊共用同一套指令與波形，只是組合不同。 */
export type UiMode = "simple" | "pro";
/** 開始畫面選的「你想做什麼」。影響預設工具、側欄與拍線偵測。 */
export type WorkProfile = "podcast" | "music" | "repair" | "convert" | "record";

/** 密度 → 根字級縮放。CSS 變數 --ui-scale 由 applyDensity 寫到 <html>。 */
export const DENSITY_SCALE: Record<Density, number> = {
  compact: 0.9,
  normal: 1,
  comfortable: 1.15,
};

const KEY = "aicut:ui";
const RAIL_MIN = 260;
const RAIL_MAX = 620;

interface Persisted {
  tab: RailTab;
  railOpen: boolean;
  railWidth: number;
  density: Density;
  mode: UiMode;
  profile: WorkProfile | null;
  /** 已經按過「知道了」的首次提示 id。 */
  hintsSeen: string[];
}

const PROFILES: WorkProfile[] = ["podcast", "music", "repair", "convert", "record"];
const DEFAULTS: Persisted = { tab: "decisions", railOpen: true, railWidth: 320, density: "normal", mode: "pro", profile: null, hintsSeen: [] };

/**
 * 從 localStorage 的字串還原（純函式，測試用）。
 * 沒存過（第一次裝）→ 簡易；有舊 blob 但沒 mode → 專業 —— 老用戶不會在升級後被丟進簡易。
 */
export function parsePersisted(raw: string | null): Persisted {
  if (!raw) return { ...DEFAULTS, mode: "simple" };
  try {
    const v = JSON.parse(raw) as Partial<Persisted>;
    return {
      tab: v.tab === "assistant" || v.tab === "verify" || v.tab === "index" ? v.tab : "decisions",
      railOpen: v.railOpen !== false,
      railWidth: Math.max(RAIL_MIN, Math.min(RAIL_MAX, Number(v.railWidth) || DEFAULTS.railWidth)),
      density: v.density === "compact" || v.density === "comfortable" ? v.density : "normal",
      mode: v.mode === "simple" ? "simple" : "pro",
      profile: PROFILES.includes(v.profile as WorkProfile) ? (v.profile as WorkProfile) : null,
      hintsSeen: Array.isArray(v.hintsSeen) ? v.hintsSeen.filter((x): x is string => typeof x === "string") : [],
    };
  } catch {
    return DEFAULTS;
  }
}

function load(): Persisted {
  try {
    return parsePersisted(localStorage.getItem(KEY));
  } catch {
    return DEFAULTS;
  }
}

function save(p: Persisted) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* 私密視窗 / 停用儲存 */
  }
}

/** 把密度寫進 <html> 的 CSS 變數（styles.css 用它縮放字級與列高）。 */
export function applyDensity(d: Density) {
  document.documentElement.style.setProperty("--ui-scale", String(DENSITY_SCALE[d]));
}

interface UiStore extends Persisted {
  /** 逐字稿搜尋列開著沒（Ctrl+F）。不持久化 —— 每次開檔案都從收起來的狀態開始。 */
  transcriptSearch: boolean;
  setTranscriptSearch: (v: boolean) => void;
  setTab: (t: RailTab) => void;
  /** 點同一個分頁 = 收合；點別的 = 切過去並展開。 */
  toggleTab: (t: RailTab) => void;
  setRailOpen: (v: boolean) => void;
  setRailWidth: (w: number) => void;
  setDensity: (d: Density) => void;
  setMode: (m: UiMode) => void;
  toggleMode: () => void;
  setProfile: (p: WorkProfile | null) => void;
  markHintSeen: (id: string) => void;
  /** 拖檔案進視窗的高亮（暫態）。 */
  dragOver: boolean;
  setDragOver: (v: boolean) => void;
}

export const useUi = create<UiStore>((set, get) => {
  const init = load();
  const persist = () => {
    const s = get();
    save({ tab: s.tab, railOpen: s.railOpen, railWidth: s.railWidth, density: s.density, mode: s.mode, profile: s.profile, hintsSeen: s.hintsSeen });
  };
  return {
    ...init,
    transcriptSearch: false,
    setTranscriptSearch: (transcriptSearch) => set({ transcriptSearch }),
    dragOver: false,
    setDragOver: (dragOver) => set({ dragOver }),
    setProfile: (profile) => {
      set({ profile });
      persist();
    },
    markHintSeen: (id) => {
      set((s) => (s.hintsSeen.includes(id) ? s : { hintsSeen: [...s.hintsSeen, id] }));
      persist();
    },
    setTab: (tab) => {
      set({ tab, railOpen: true });
      persist();
    },
    toggleTab: (tab) => {
      const s = get();
      set(s.railOpen && s.tab === tab ? { railOpen: false } : { tab, railOpen: true });
      persist();
    },
    setRailOpen: (railOpen) => {
      set({ railOpen });
      persist();
    },
    setRailWidth: (w) => {
      set({ railWidth: Math.max(RAIL_MIN, Math.min(RAIL_MAX, w)) });
      persist();
    },
    setDensity: (density) => {
      set({ density });
      applyDensity(density);
      persist();
    },
    setMode: (mode) => {
      set({ mode });
      persist();
    },
    toggleMode: () => {
      set((s) => ({ mode: s.mode === "simple" ? "pro" : "simple" }));
      persist();
    },
  };
});

export const RAIL_LIMITS = { min: RAIL_MIN, max: RAIL_MAX };
