import { create } from "zustand";
import { api, type AppPaths, type AppSettings, type ClaudeStatus, type FfmpegStatus, type KeyStatus, type TtlsHealth } from "../api";

export const DEFAULT_SETTINGS: AppSettings = {
  ttls_base_url: "https://ttls.markkulab.net",
  ffmpeg_path: null,
  claude_model: "sonnet",
  default_aggressiveness: 50,
  target_lufs: -16,
  output_dir: null,
  lang: "zh-TW",
  judge_enabled: true,
  asr_language: "zh",
  asr_model: "auto",
  hotwords: "",
  recent_projects: [],
};

interface SettingsStore {
  s: AppSettings;
  loaded: boolean;
  ffmpeg: FfmpegStatus | null;
  ttls: TtlsHealth | null;
  key: KeyStatus | null;
  claude: ClaudeStatus | null;
  paths: AppPaths | null;
  probing: boolean;
  load: () => Promise<void>;
  save: (patch: Partial<AppSettings>) => Promise<void>;
  probeAll: () => Promise<void>;
  refreshKey: () => Promise<void>;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  s: DEFAULT_SETTINGS,
  loaded: false,
  ffmpeg: null,
  ttls: null,
  key: null,
  claude: null,
  paths: null,
  probing: false,
  load: async () => {
    try {
      const s = await api.settingsGet();
      set({ s: { ...DEFAULT_SETTINGS, ...s }, loaded: true });
    } catch {
      set({ loaded: true });
    }
    try {
      set({ paths: await api.appPaths() });
    } catch {
      /* 非 Tauri 環境（vite preview）略過 */
    }
    void get().probeAll();
  },
  save: async (patch) => {
    const next = { ...get().s, ...patch };
    set({ s: next }); // 樂觀更新，UI 立即反映
    try {
      const saved = await api.settingsSet(next);
      set({ s: { ...DEFAULT_SETTINGS, ...saved } });
    } catch {
      /* 寫檔失敗保留記憶體中的值；呼叫端可再試 */
    }
  },
  probeAll: async () => {
    if (get().probing) return;
    set({ probing: true });
    const [ffmpeg, ttls, key, claude] = await Promise.all([
      api.ffmpegDetect().catch(() => null),
      api.ttlsHealth().catch(() => null),
      api.ttlsKeyStatus().catch(() => null),
      api.claudeDetect().catch(() => null),
    ]);
    set({ ffmpeg, ttls, key, claude, probing: false });
  },
  refreshKey: async () => {
    set({ key: await api.ttlsKeyStatus().catch(() => null) });
  },
}));
