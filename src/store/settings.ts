import { create } from "zustand";
import { setFillerRules } from "../analysis/lexicon";
import { setPromptOverrides } from "../analysis/prompts";
import { api, type AppPaths, type AppSettings, type ClaudeStatus, type FfmpegStatus, type LlmStatus } from "../api";
import { isApiBackendId } from "../llm/presets";

export const DEFAULT_SETTINGS: AppSettings = {
  ffmpeg_path: null,
  claude_model: "sonnet",
  agent_backend: "claude",
  llm_anthropic_base_url: "https://api.anthropic.com",
  llm_anthropic_model: "claude-sonnet-5",
  llm_openai_base_url: "https://api.openai.com/v1",
  llm_openai_model: "",
  assistant_skills: [],
  assistant_skills_on: [],
  // 新安裝預設走本機辨識：ttls 是作者自架的伺服器，新使用者拿不到金鑰
  prompt_overrides: {},
  filler_rules: {},
  export_presets: [],
  project_templates: [],
  filler_observations: [],
  filler_dismissed: [],
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
  /** HTTP AI 後端的狀態（key = "anthropic-api" / "openai-api"）。不開 process，隨時可重探。 */
  llm: Record<string, LlmStatus>;
  paths: AppPaths | null;
  probing: boolean;
  load: () => Promise<void>;
  save: (patch: Partial<AppSettings>) => Promise<void>;
  probeAll: () => Promise<void>;
  probeCodex: () => Promise<void>;
  /** 重探一個 HTTP 後端（改完 Base URL / 金鑰 / 模型之後呼叫）。 */
  probeLlm: (kind: string) => Promise<void>;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  s: DEFAULT_SETTINGS,
  loaded: false,
  ffmpeg: null,
  ttls: null,
  key: null,
  claude: null,
  codex: null,
  llm: {},
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
    const backend = get().s.agent_backend || "claude";
    if (backend === "codex") void get().probeCodex();
    if (isApiBackendId(backend)) void get().probeLlm(backend);
  },
  probeCodex: async () => {
    set({ codex: await api.codexDetect().catch(() => null) });
  },
  probeLlm: async (kind) => {
    const st = await api.llmStatus(kind).catch(() => null);
    if (st) set({ llm: { ...get().llm, [kind]: st } });
  },
}));

/**
 * AI 後端：`"claude"` / `"codex"`（本機 CLI）或 `"anthropic-api"` / `"openai-api"`（HTTP 相容端點）。
 *
 * codex 只吃結構化產出那條路 —— 它要連上 App 的 MCP server 得靠使用者自己的 config.toml，
 * App 寫不進去，所以選 codex 時助手仍走 claude。API 供應商沒有這個限制：
 * 助手的工具迴圈在 Rust 端自己跑（`llm::agent_loop`），直接呼叫內建 MCP bridge。
 */
export function agentBackend(): string {
  return useSettings.getState().s.agent_backend || "claude";
}

/** 目前後端是 HTTP API 供應商嗎。 */
export function isApiBackend(backend = agentBackend()): boolean {
  return isApiBackendId(backend);
}

/**
 * 判讀 / 助手 / 節目筆記用的模型。
 *
 * API 供應商回 `null`：模型名存在後端設定裡（`llm_*_model`），把 claude 的別名
 * （sonnet / haiku）餵給 OpenAI 端點只會換得一個 404。
 */
export function primaryModel(): string | null {
  const s = useSettings.getState().s;
  if (isApiBackend(s.agent_backend || "claude")) return null;
  return s.claude_model || "sonnet";
}

/** 審核 agent 的模型；同 primaryModel，API 供應商回 null。 */
export function reviewModel(): string | null {
  const s = useSettings.getState().s;
  if (isApiBackend(s.agent_backend || "claude")) return null;
  return s.claude_review_model || "haiku";
}

/**
 * 顯示 / 存證用的模型名稱（判讀意見會把它寫進專案檔）。
 *
 * 跟 `primaryModel()` 的差別：那個是「要不要把模型名送給後端」，這個是「這次是誰判的」，
 * API 供應商也一定要有值，不然專案檔裡會出現一堆 null。
 */
export function modelLabel(): string {
  const s = useSettings.getState().s;
  const b = s.agent_backend || "claude";
  if (b === "anthropic-api") return s.llm_anthropic_model || "anthropic-api";
  if (b === "openai-api") return s.llm_openai_model || "openai-api";
  if (b === "codex") return "codex";
  return s.claude_model || "sonnet";
}

/** 審核那一輪的模型名稱（存證用）。CLI 後端才有獨立的審核模型。 */
export function reviewModelLabel(): string {
  const s = useSettings.getState().s;
  const b = s.agent_backend || "claude";
  if (b === "claude") return s.claude_review_model || "haiku";
  return modelLabel();
}
