import { create } from "zustand";
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
  /** 各媒體的分析產物（逐字稿等），由 pipeline 寫入；存檔時原樣序列化。 */
  analysis: Record<string, MediaAnalysisV1>;

  openMedia: (path: string) => Promise<string>;
  setActive: (id: string | null) => void;
  updateMedia: (id: string, patch: Partial<MediaItem>) => void;
  removeMedia: (id: string) => void;
  setAnalysis: (mediaId: string, data: MediaAnalysisV1 | null) => void;
  setAggressiveness: (v: number) => void;
  setTargetLufs: (v: number) => void;
  markDirty: () => void;
  newProject: () => void;
  loadFrom: (path: string) => Promise<ProjectFileV1>;
  saveTo: (path?: string) => Promise<string>;
}

function fileName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

export const useProject = create<ProjectStore>((set, get) => ({
  path: null,
  dirty: false,
  createdAt: null,
  media: [],
  activeMediaId: null,
  aggressiveness: 50,
  targetLufs: -16,
  analysis: {},

  openMedia: async (path) => {
    const existing = get().media.find((m) => m.path === path);
    if (existing) {
      set({ activeMediaId: existing.id });
      return existing.id;
    }
    const probe = await api.mediaProbe(path);
    const id = probe.fingerprint.slice(0, 16);
    const dup = get().media.find((m) => m.id === id);
    if (dup) {
      set({ activeMediaId: dup.id });
      return dup.id;
    }
    const item: MediaItem = { id, path, name: fileName(path), fingerprint: probe.fingerprint, probe, analysis: "none" };
    set((s) => ({ media: [...s.media, item], activeMediaId: id, dirty: true }));
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
  markDirty: () => set({ dirty: true }),
  newProject: () =>
    set({ path: null, dirty: false, createdAt: null, media: [], activeMediaId: null, analysis: {}, aggressiveness: 50, targetLufs: -16 }),

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
      analysis: f.analysis,
    });
    return f;
  },

  saveTo: async (path) => {
    const s = get();
    const target = path ?? s.path;
    if (!target) throw new Error("未指定專案檔路徑");
    const doc = buildProjectFile(
      { media: s.media, activeMediaId: s.activeMediaId, settings: { aggressiveness: s.aggressiveness, targetLufs: s.targetLufs }, analysis: s.analysis },
      { name: APP_NAME, version: __APP_VERSION__ },
      s.createdAt ? { createdAt: s.createdAt } : null,
    );
    await api.projectSave(target, doc);
    set({ path: target, dirty: false, createdAt: doc.createdAt });
    return target;
  },
}));

/** 目前作用中的媒體（selector helper）。 */
export function selectActiveMedia(s: ProjectStore): MediaItem | null {
  return s.media.find((m) => m.id === s.activeMediaId) ?? null;
}
