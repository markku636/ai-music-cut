//! HTTP 供應商：Anthropic-compatible（`/v1/messages`）與 OpenAI-compatible（`/chat/completions`）。
//!
//! 與 `agent.rs`（claude CLI）、`codex.rs`（codex CLI）並列的第三、四條路：不開子程序、
//! 不需要任何外部安裝，使用者只要填 Base URL + API Key + 模型即可。兩條路徑都支援：
//! - **AI 助手**：工具迴圈直接呼叫 App 內建的 MCP bridge（`mcp::call_tool`），
//!   不經 CLI，也就沒有「codex 連不上 MCP」那個限制。
//! - **結構化產出**（判讀 / 審核 / 節目筆記）：Anthropic 走強制 tool_choice、
//!   OpenAI 走 `response_format`，各自帶降級鏈。
//!
//! 設計取捨：
//! - **不用官方 SDK crate**：重點正是「第三方相容端點」（OpenRouter / Ollama / vLLM / Kimi /
//!   GLM…），SDK 對欄位與版本的嚴格度反而是阻礙。手刻請求體只依賴兩家公開的 wire format。
//! - **錯誤一律回 `String`**：這層不認識 `AppError`，由 `agent.rs` 決定包成哪個變體。
//! - **金鑰只在 Rust 端**：前端只能寫入 / 查詢「有沒有」，永遠拿不到明文（`store::kc_*`）。

pub mod agent_loop;
pub mod anthropic;
pub mod models;
pub mod openai;
pub mod sse;

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type LlmResult<T> = Result<T, String>;

/// 共用的 HTTP client（連線池 + keep-alive）。**不設整體 timeout**：串流回應本來就會開很久，
/// 逾時交給呼叫端（結構化產出有 timeout_ms）或使用者取消（助手）。
pub fn client() -> &'static reqwest::Client {
    static HTTP: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(concat!("ai-podcast-cut/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(std::time::Duration::from_secs(20))
            .build()
            .expect("http client")
    })
}

/// 相容協定家族。字串 id 與設定檔的 `agent_backend` 一致。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LlmKind {
    Anthropic,
    OpenAi,
}

impl LlmKind {
    pub fn parse(s: &str) -> Option<LlmKind> {
        match s.trim() {
            "anthropic-api" => Some(LlmKind::Anthropic),
            "openai-api" => Some(LlmKind::OpenAi),
            _ => None,
        }
    }

    /// keychain account（service 沿用 `ai-music-cut`，改名會讓既有使用者的金鑰讀不到）。
    pub fn key_account(self) -> &'static str {
        match self {
            LlmKind::Anthropic => "llm-anthropic-key",
            LlmKind::OpenAi => "llm-openai-key",
        }
    }

    /// 環境變數覆寫（優先於 keychain；CI / 臨時切換用）。
    pub fn key_env(self) -> &'static str {
        match self {
            LlmKind::Anthropic => "ANTHROPIC_API_KEY",
            LlmKind::OpenAi => "OPENAI_API_KEY",
        }
    }

    pub fn base_env(self) -> &'static str {
        match self {
            LlmKind::Anthropic => "ANTHROPIC_BASE_URL",
            LlmKind::OpenAi => "OPENAI_BASE_URL",
        }
    }

    pub fn default_base(self) -> &'static str {
        match self {
            LlmKind::Anthropic => "https://api.anthropic.com",
            LlmKind::OpenAi => "https://api.openai.com/v1",
        }
    }
}

/// 一次呼叫所需的全部設定。`api_key` 為 `None` 時仍會送出（地端端點多半不驗）。
#[derive(Clone, Debug)]
pub struct LlmConfig {
    pub kind: LlmKind,
    /// 已正規化的 base（結尾不含 `/`，且已補上 `/v1`）。
    pub base: String,
    pub api_key: Option<String>,
    pub model: String,
}

impl LlmConfig {
    /// 由設定檔的 base_url / model 組出設定；金鑰自 env → keychain 解析。
    pub fn resolve(kind: LlmKind, base_url: Option<&str>, model: Option<&str>) -> LlmConfig {
        let raw_base = base_url
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .or_else(|| env_nonempty(kind.base_env()))
            .unwrap_or_else(|| kind.default_base().to_string());
        LlmConfig {
            kind,
            base: normalize_base(&raw_base),
            api_key: resolve_key(kind),
            model: model.map(str::trim).unwrap_or("").to_string(),
        }
    }

    pub fn endpoint(&self) -> String {
        match self.kind {
            LlmKind::Anthropic => format!("{}/messages", self.base),
            LlmKind::OpenAi => format!("{}/chat/completions", self.base),
        }
    }

    /// 地端端點（localhost / 127.0.0.1 / 區網）不需要金鑰，UI 的「未設定金鑰」警告要跳過。
    pub fn is_local(&self) -> bool {
        is_local_base(&self.base)
    }
}

fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// 金鑰解析順序：環境變數 → OS keychain。都沒有回 `None`（地端端點仍可用）。
pub fn resolve_key(kind: LlmKind) -> Option<String> {
    if let Some(v) = env_nonempty(kind.key_env()) {
        return Some(v);
    }
    crate::store::kc_get(kind.key_account()).map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// Base URL 正規化。使用者會貼進各種寫法，全部要能用：
///
/// - `https://api.openai.com` → `https://api.openai.com/v1`
/// - `https://api.openai.com/v1/` → `https://api.openai.com/v1`
/// - `http://localhost:11434/v1` → 原樣
/// - `https://open.bigmodel.cn/api/paas/v4` → 原樣（自帶路徑者不動它）
/// - `https://api.moonshot.cn/anthropic` → 原樣
///
/// 規則：去尾斜線 → 有 path 就當成完整 base → 沒有 path 才補 `/v1`。
pub fn normalize_base(raw: &str) -> String {
    let s = raw.trim().trim_end_matches('/');
    if s.is_empty() {
        return String::new();
    }
    let after_scheme = match s.find("://") {
        Some(i) => &s[i + 3..],
        None => s,
    };
    if after_scheme.contains('/') {
        s.to_string()
    } else {
        format!("{s}/v1")
    }
}

pub fn is_local_base(base: &str) -> bool {
    let b = base.to_ascii_lowercase();
    b.contains("//localhost") || b.contains("//127.0.0.1") || b.contains("//0.0.0.0") || b.contains("//[::1]") || b.contains("//192.168.") || b.contains("//10.")
}

// ---- 供應商中立的訊息模型 ----

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub args: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolOutput {
    pub id: String,
    pub name: String,
    pub content: String,
    pub is_error: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub enum Message {
    User(String),
    /// 助理回合：文字 + 這回合要求的工具呼叫（可能兩者都有）。
    Assistant { text: String, tool_calls: Vec<ToolCall> },
    /// 工具回傳，順序與上一則 Assistant 的 tool_calls 對應。
    ToolResults(Vec<ToolOutput>),
}

/// 給模型看的工具定義（`schema` 是 JSON Schema 物件；直接來自 MCP 的 `inputSchema`）。
#[derive(Clone, Debug)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub schema: Value,
}

/// 串流過程中往外推的事件（由 `agent.rs` 轉成 `claude-stream`，欄位與 CLI 後端相同）。
pub enum StreamEvent {
    Text(String),
    ToolStart(String),
    ToolResult { text: String, is_error: bool },
}

pub type Sink<'a> = &'a (dyn Fn(StreamEvent) + Send + Sync);

#[derive(Debug, PartialEq, Eq)]
pub enum StopReason {
    End,
    ToolUse,
    Other(String),
}

pub struct TurnOutput {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
    pub stop: StopReason,
}

/// 一次請求的參數（兩家共用）。
pub struct TurnRequest<'a> {
    pub system: Option<&'a str>,
    pub messages: &'a [Message],
    pub tools: &'a [ToolSpec],
    pub max_tokens: u32,
    pub temperature: Option<f32>,
}

/// 送出一回合（串流），依 kind 分派。
pub async fn stream_turn(http: &reqwest::Client, cfg: &LlmConfig, req: &TurnRequest<'_>, sink: Sink<'_>) -> LlmResult<TurnOutput> {
    match cfg.kind {
        LlmKind::Anthropic => anthropic::stream_turn(http, cfg, req, sink).await,
        LlmKind::OpenAi => openai::stream_turn(http, cfg, req, sink).await,
    }
}

/// 一次性結構化產出（判讀 / 審核 / 節目筆記）。回傳符合 `schema` 的 JSON。
pub async fn structured(
    http: &reqwest::Client,
    cfg: &LlmConfig,
    system: Option<&str>,
    prompt: &str,
    schema: &Value,
    max_tokens: u32,
) -> LlmResult<Value> {
    match cfg.kind {
        LlmKind::Anthropic => anthropic::structured(http, cfg, system, prompt, schema, max_tokens).await,
        LlmKind::OpenAi => openai::structured(http, cfg, system, prompt, schema, max_tokens).await,
    }
}

/// 從模型的純文字回應裡取 JSON：先剝 ```json 圍籬，再退一步找第一個 `{` 到最後一個 `}`。
/// 相容端點不支援 schema 時只能靠這條路，所以要寬容一點。
pub fn extract_json(text: &str) -> Option<Value> {
    let t = text.trim();
    let stripped = t
        .trim_start_matches("```json")
        .trim_start_matches("```JSON")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    if let Ok(v) = serde_json::from_str::<Value>(stripped) {
        return Some(v);
    }
    let start = stripped.find(['{', '['])?;
    let end = stripped.rfind(['}', ']'])?;
    if end <= start {
        return None;
    }
    serde_json::from_str::<Value>(&stripped[start..=end]).ok()
}

/// HTTP 錯誤轉人話。body 只取前 300 字，且**不回傳送出去的內容**（避免金鑰 / 資料外流到 UI）。
pub(crate) fn http_error(status: reqwest::StatusCode, body: &str) -> String {
    let short: String = body.trim().chars().take(300).collect();
    let hint = match status.as_u16() {
        401 | 403 => "（金鑰無效或沒有權限）",
        404 => "（Base URL 可能不對，或這個服務沒有這個端點）",
        429 => "（額度或速率上限）",
        _ => "",
    };
    if short.is_empty() {
        format!("HTTP {status}{hint}")
    } else {
        format!("HTTP {status}{hint}：{short}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_base_cases() {
        assert_eq!(normalize_base("https://api.openai.com"), "https://api.openai.com/v1");
        assert_eq!(normalize_base("https://api.openai.com/"), "https://api.openai.com/v1");
        assert_eq!(normalize_base("https://api.openai.com/v1"), "https://api.openai.com/v1");
        assert_eq!(normalize_base("https://api.openai.com/v1/"), "https://api.openai.com/v1");
        assert_eq!(normalize_base("http://localhost:11434/v1"), "http://localhost:11434/v1");
        assert_eq!(normalize_base("http://localhost:11434"), "http://localhost:11434/v1");
        assert_eq!(normalize_base("https://open.bigmodel.cn/api/paas/v4"), "https://open.bigmodel.cn/api/paas/v4");
        assert_eq!(normalize_base("https://api.moonshot.cn/anthropic"), "https://api.moonshot.cn/anthropic");
        assert_eq!(normalize_base("  https://api.anthropic.com  "), "https://api.anthropic.com/v1");
        assert_eq!(normalize_base(""), "");
    }

    #[test]
    fn endpoints() {
        let a = LlmConfig { kind: LlmKind::Anthropic, base: normalize_base("https://api.anthropic.com"), api_key: None, model: "m".into() };
        assert_eq!(a.endpoint(), "https://api.anthropic.com/v1/messages");
        let o = LlmConfig { kind: LlmKind::OpenAi, base: normalize_base("http://127.0.0.1:1234/v1"), api_key: None, model: "m".into() };
        assert_eq!(o.endpoint(), "http://127.0.0.1:1234/v1/chat/completions");
        assert!(o.is_local());
        assert!(!a.is_local());
    }

    #[test]
    fn kind_parse() {
        assert_eq!(LlmKind::parse("anthropic-api"), Some(LlmKind::Anthropic));
        assert_eq!(LlmKind::parse(" openai-api "), Some(LlmKind::OpenAi));
        assert_eq!(LlmKind::parse("claude"), None);
        assert_eq!(LlmKind::parse("codex"), None);
    }

    #[test]
    fn extract_json_handles_fences_and_prose() {
        assert_eq!(extract_json("{\"a\":1}").unwrap()["a"], 1);
        assert_eq!(extract_json("```json\n{\"a\":2}\n```").unwrap()["a"], 2);
        assert_eq!(extract_json("好的，結果如下：\n{\"a\":3}\n希望有幫助").unwrap()["a"], 3);
        assert!(extract_json("完全沒有 JSON").is_none());
    }

    #[test]
    fn http_error_truncates_and_hints() {
        let msg = http_error(reqwest::StatusCode::UNAUTHORIZED, &"x".repeat(500));
        assert!(msg.contains("401") && msg.contains("金鑰無效"));
        assert!(msg.chars().count() < 360);
    }
}
