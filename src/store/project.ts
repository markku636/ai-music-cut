import { create } from "zustand";
import { useSettings } from "./settings";
import { api, type MediaProbe } from "../api";
import { APP_NAME } from "../brand";
import { buildProjectFile, parseProjectFile, type MediaAnalysisV1, type ProjectFileV1 } from "../project/format";

export type AnalysisState = "none" | "analyzing" | "ready" | "error";

export interface MediaItem {
  id: string;
  path: string;
  name: string;
  fingerprint: string;
  probe: MediaProbe | null;
  analysis: AnalysisState;
  error?: string;
}

interface ProjectStore {
  path: string | null;
  dirty: boolean;
  createdAt: string | null;
  media: MediaItem[];
  activeMediaId: string | null;
  aggressiveness: number;
  targetLufs: number;
  /** 輸出時逐段音量平衡；簡易面板的「音量弄整齊」就是它。 */
  leveling: boolean;
  /** 各媒體的分析產物（逐字稿等），由 pipeline 寫入；存檔時原樣序列化。 */
  analysis: Record<string, MediaAnalysisV1>;

  /** 開檔加進清單。`activate: false` = 只加進清單、不切 active（素材 / take / 對齊檔用，避免主角閃一下重載）。 */
  openMedia: (path: string, opts?: { activate?: boolean }) => Promise<string>;
  setActive: (id: string | null) => void;
  updateMedia: (id: string, patch: Partial<MediaItem>) => void;
  removeMedia: (id: string) => void;
  setAnalysis: (mediaId: string, data: MediaAnalysisV1 | null) => void;
  setAggressiveness: (v: number) => void;
  setTargetLufs: (v: number) => void;
  setLeveling: (v: boolean) => void;
  markDirty: () => void;
  newProject: () => void;
  loadFrom: (path: string) => Promise<ProjectFileV1>;
  saveTo: (path?: string, enrich?: (analysis: Record<string, MediaAnalysisV1>) => Record<string, MediaAnalysisV1>) => Promise<string>;
}

function fileName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

/**
 * 設定裡的預設激進度。設定還沒載入時退回 50（跟 DEFAULT_SETTINGS 一致）。
 *
 * 讀的是 store 的**當下值**而不是在模組載入時抓一次 —— 設定是非同步載入的，
 * 抓一次的話永遠拿到預設值。
 */
export function defaultAggressiveness(): number {
  const v = useSettings.getState().s.default_aggressiveness;
  return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 50;
}

export const useProject = create<ProjectStore>((set, get) => ({
  path: null,
  dirty: false,
  createdAt: null,
  media: [],
  activeMediaId: null,
  // 模組載入時設定還沒讀進來，所以這裡就是 50；真正套用預設值的地方是
  // App 啟動流程（設定載完之後）與 newProject()。
  aggressiveness: 50,
  targetLufs: -16,
  leveling: true,
  analysis: {},

  openMedia: async (path, opts) => {
    const activate = opts?.activate !== false;
    const existing = get().media.find((m) => m.path === path);
    if (existing) {
      if (activate) set({ activeMediaId: existing.id });
      return existing.id;
    }
    const probe = await api.mediaProbe(path);
    const id = probe.fingerprint.slice(0, 16);
    const dup = get().media.find((m) => m.id === id);
    if (dup) {
      if (activate) set({ activeMediaId: dup.id });
      return dup.id;
    }
    const item: MediaItem = { id, path, name: fileName(path), fingerprint: probe.fingerprint, probe, analysis: "none" };
    set((s) => ({ media: [...s.media, item], ...(activate ? { activeMediaId: id } : {}), dirty: true }));
    return id;
  },
  setActive: (id) => set({ activeMediaId: id }),
  updateMedia: (id, patch) =>
    set((s) => ({ media: s.media.map((m) => (m.id === id ? { ...m, ...patch } : m)) })),
  removeMedia: (id) =>
    set((s) => {
      const media = s.media.filter((m) => m.id !== id);
      const analysis = { ...s.analysis };
      delete analysis[id];
      return {
        media,
        analysis,
        activeMediaId: s.activeMediaId === id ? media[0]?.id ?? null : s.activeMediaId,
        dirty: true,
      };
    }),
  setAnalysis: (mediaId, data) =>
    set((s) => {
      const analysis = { ...s.analysis };
      if (data) analysis[mediaId] = data;
      else delete analysis[mediaId];
      return { analysis, dirty: true };
    }),
  setAggressiveness: (v) => set({ aggressiveness: Math.max(0, Math.min(100, Math.round(v))), dirty: true }),
  setTargetLufs: (v) => set({ targetLufs: v, dirty: true }),
  setLeveling: (v) => set({ leveling: v, dirty: true }),
  markDirty: () => set({ dirty: true }),
  newProject: () =>
    // 新專案要吃設定裡的「預設激進度」。這一條原本寫死 50，設定裡那個滑桿因此
    // **完全沒有作用** —— 使用者拉了它，每一個新專案還是 50。
    set({ path: null, dirty: false, createdAt: null, media: [], activeMediaId: null, analysis: {}, aggressiveness: defaultAggressiveness(), targetLufs: -16, leveling: true }),

  loadFrom: async (path) => {
    const doc = await api.projectLoad(path);
    const f = parseProjectFile(doc);
    set({
      path,
      dirty: false,
      createdAt: f.createdAt,
      media: f.media.map((m) => ({ ...m, analysis: f.analysis[m.id] ? "ready" : "none" })),
      activeMediaId: f.activeMediaId,
      aggressiveness: f.settings.aggressiveness,
      targetLufs: f.settings.targetLufs,
      leveling: f.settings.leveling ?? true,
      analysis: f.analysis,
    });
    return f;
  },

  saveTo: async (path, enrich) => {
    const s = get();
    const analysis = enrich ? enrich(s.analysis) : s.analysis;
    const target = path ?? s.path;
    if (!target) throw new Error("未指定專案檔路徑");
    const doc = buildProjectFile(
      { media: s.media, activeMediaId: s.activeMediaId, settings: { aggressiveness: s.aggressiveness, targetLufs: s.targetLufs, leveling: s.leveling }, analysis },
      { name: APP_NAME, version: __APP_VERSION__ },
      s.createdAt ? { createdAt: s.createdAt } : null,
    );
    await api.projectSave(target, doc);
    set({ path: target, dirty: false, createdAt: doc.createdAt, analysis });
    return target;
  },
}));

/** 目前作用中的媒體（selector helper）。 */
export function selectActiveMedia(s: ProjectStore): MediaItem | null {
  return s.media.find((m) => m.id === s.activeMediaId) ?? null;
}
