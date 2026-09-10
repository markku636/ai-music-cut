// HTTP AI 後端（Anthropic / OpenAI 相容）的前端常數與純函式。
//
// 後端有一份同規則的 `normalize_base`（src-tauri/src/llm/mod.rs）。這裡這份只是為了
// 讓設定畫面即時顯示「實際會打哪個網址」，**真正送出的網址一律由 Rust 端算**，
// 兩邊的測試案例刻意寫成同一組（見 presets.test.ts）。

export type LlmBackend = "anthropic-api" | "openai-api";

export const LLM_BACKENDS: readonly LlmBackend[] = ["anthropic-api", "openai-api"];

export function isApiBackendId(b: string): b is LlmBackend {
  return b === "anthropic-api" || b === "openai-api";
}

export interface LlmPreset {
  id: string;
  label: string;
  backend: LlmBackend;
  baseUrl: string;
  /** 地端端點不需要金鑰。 */
  local?: boolean;
}

/** 常見服務的 Base URL 一鍵帶入。模型名一律自己填 / 現抓 —— 寫死只會過期。 */
export const LLM_PRESETS: readonly LlmPreset[] = [
  { id: "anthropic", label: "Anthropic", backend: "anthropic-api", baseUrl: "https://api.anthropic.com" },
  { id: "kimi-anthropic", label: "Moonshot Kimi", backend: "anthropic-api", baseUrl: "https://api.moonshot.cn/anthropic" },
  { id: "glm-anthropic", label: "智譜 GLM", backend: "anthropic-api", baseUrl: "https://open.bigmodel.cn/api/anthropic" },
  { id: "deepseek-anthropic", label: "DeepSeek", backend: "anthropic-api", baseUrl: "https://api.deepseek.com/anthropic" },
  { id: "openai", label: "OpenAI", backend: "openai-api", baseUrl: "https://api.openai.com/v1" },
  { id: "openrouter", label: "OpenRouter", backend: "openai-api", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "deepseek", label: "DeepSeek", backend: "openai-api", baseUrl: "https://api.deepseek.com/v1" },
  { id: "groq", label: "Groq", backend: "openai-api", baseUrl: "https://api.groq.com/openai/v1" },
  { id: "ollama", label: "Ollama", backend: "openai-api", baseUrl: "http://localhost:11434/v1", local: true },
  { id: "lmstudio", label: "LM Studio", backend: "openai-api", baseUrl: "http://localhost:1234/v1", local: true },
  { id: "vllm", label: "vLLM", backend: "openai-api", baseUrl: "http://localhost:8000/v1", local: true },
];

export function presetsFor(backend: LlmBackend): LlmPreset[] {
  return LLM_PRESETS.filter((p) => p.backend === backend);
}

/**
 * Base URL 正規化（與 Rust 端同規則）：去尾斜線 → 有 path 就當完整 base → 沒 path 才補 `/v1`。
 * 所以 `https://api.openai.com` → `…/v1`，而 `https://api.moonshot.cn/anthropic` 原樣不動。
 */
export function normalizeBase(raw: string): string {
  const s = (raw ?? "").trim().replace(/\/+$/, "");
  if (!s) return "";
  const i = s.indexOf("://");
  const afterScheme = i >= 0 ? s.slice(i + 3) : s;
  return afterScheme.includes("/") ? s : `${s}/v1`;
}

/** 實際會打的端點，設定畫面直接顯示給人看。 */
export function endpointOf(backend: LlmBackend, baseUrl: string): string {
  const base = normalizeBase(baseUrl);
  if (!base) return "";
  return backend === "anthropic-api" ? `${base}/messages` : `${base}/chat/completions`;
}
