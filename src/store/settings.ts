import { create } from "zustand";
import { setFillerRules } from "../analysis/lexicon";
import { setPromptOverrides } from "../analysis/prompts";
import { api, type AppPaths, type AppSettings, type ClaudeStatus, type FfmpegStatus } from "../api";

export const DEFAULT_SETTINGS: AppSettings = {
  ffmpeg_path: null,
  claude_model: "sonnet",
  agent_backend: "claude",
  // 新安裝預設走本機辨識：ttls 是作者自架的伺服器，新使用者拿不到金鑰
  prompt_overrides: {},
  filler_rules: {},
  export_presets: [],
  project_templates: [],
  filler_observations: [],
  claude_review_model: "haiku",
  judge_roles: "editor+reviewer",
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
  claude: ClaudeStatus | null;
  /** 只有選了 codex 後端、或使用者打開模型選單時才探（每探一次就是開一個 process）。 */
  codex: ClaudeStatus | null;
  paths: AppPaths | null;
  probing: boolean;
  load: () => Promise<void>;
  save: (patch: Partial<AppSettings>) => Promise<void>;
  probeAll: () => Promise<void>;
  probeCodex: () => Promise<void>;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  s: DEFAULT_SETTINGS,
  loaded: false,
  ffmpeg: null,
  ttls: null,
  key: null,
  claude: null,
  codex: null,
  paths: null,
  probing: false,
  load: async () => {
    try {
      const s = await api.settingsGet();
      set({ s: { ...DEFAULT_SETTINGS, ...s }, loaded: true });
      // 提示詞與贅字詞表都是單向推進去的（那兩支是純函式，不反向讀設定）
      setPromptOverrides(s.prompt_overrides);
      setFillerRules(s.filler_rules);
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
      setPromptOverrides(saved.prompt_overrides);
      setFillerRules(saved.filler_rules);
    } catch {
      /* 寫檔失敗保留記憶體中的值；呼叫端可再試 */
    }
  },
  probeAll: async () => {
    if (get().probing) return;
    set({ probing: true });
    const [ffmpeg, claude] = await Promise.all([api.ffmpegDetect().catch(() => null), api.claudeDetect().catch(() => null)]);
    set({ ffmpeg, claude, probing: false });
    if ((get().s.agent_backend || "claude") === "codex") void get().probeCodex();
  },
  probeCodex: async () => {
    set({ codex: await api.codexDetect().catch(() => null) });
  },
}));

/**
 * 結構化產出要用哪個 CLI（"claude" 或 "codex"）。
 *
 * 只有這一條路徑吃這個設定 —— AI 助手的工具迴圈一律走 claude，
 * 因為 codex 要連上 App 的 MCP server 得靠使用者自己的 config.toml，App 寫不進去。
 */
export function agentBackend(): string {
  return useSettings.getState().s.agent_backend || "claude";
}
