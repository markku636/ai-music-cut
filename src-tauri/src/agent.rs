//! AI 助手 / AI 判讀：驅動本機 `claude` CLI（使用者的 Claude 訂閱登入）、`codex` CLI，
//! 或直接以 HTTP 打 Anthropic / OpenAI 相容端點（見 `llm/`）。承襲 db-kit agent.rs。
//!
//! 四種後端由設定的 `agent_backend` 決定，共用同一組 `claude-stream` 事件，前端不必分辨：
//! - `claude`：CLI + `--mcp-config` 連本 App 的 MCP server
//! - `codex`：CLI（只走結構化產出；助手仍回 claude —— App 寫不進使用者的 config.toml）
//! - `anthropic-api` / `openai-api`：`llm::agent_loop` 自己跑工具迴圈，工具直接呼叫
//!   `mcp::call_tool`，所以那 29 支剪輯工具照樣可用。
//!
//! - 助手（agent 模式）：`-p --output-format stream-json`，NDJSON 逐行轉成 `claude-stream` 事件推給前端；
//!   透過 `--mcp-config` 連進本 App 內建的 MCP server（mcp.rs），`--allowedTools mcp__aicut` 只放行自家工具，
//!   `--permission-mode dontAsk` 讓清單外的一律自動拒絕（不卡住）。
//! - 判讀（structured）：`--output-format json --json-schema`，一次回合、零工具，回 `structured_output`。
//! - 提示由 stdin 餵入（避開 Windows 命令列長度上限與引號轉義）。
use std::path::PathBuf;
use std::process::Stdio;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::commands::AppState;
use crate::error::{AppError, AppResult};
use crate::proc;

/// 解析後的 claude 執行方式。npm 安裝的 `.cmd` shim 需透過 `cmd /C` 呼叫（但優先解析成底下的 .exe）。
struct ClaudeBin {
    program: String,
    prefix: Vec<String>,
    display: String,
}

#[derive(Serialize)]
pub struct ClaudeStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub logged_in: bool,
    pub path: Option<String>,
}

/// 推送給前端的串流事件（事件名 `claude-stream`）。
#[derive(Clone, Serialize, Default)]
struct AgentEvent {
    req_id: String,
    /// "system" | "text" | "tool" | "tool_result" | "result" | "error" | "done"
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_error: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<i32>,
}

fn classify(path: String) -> ClaudeBin {
    let lower = path.to_lowercase();
    if cfg!(windows) && (lower.ends_with(".cmd") || lower.ends_with(".bat")) {
        // npm shim → 直接找它旁邊的原生 exe（避開 cmd /C 的 8191 字元上限與引號地獄）
        if let Some(dir) = PathBuf::from(&path).parent() {
            let exe = dir.join("node_modules").join("@anthropic-ai").join("claude-code").join("bin").join("claude.exe");
            if exe.is_file() {
                let p = exe.to_string_lossy().into_owned();
                return ClaudeBin { program: p.clone(), prefix: Vec::new(), display: p };
            }
        }
        ClaudeBin { program: "cmd".to_string(), prefix: vec!["/C".to_string(), path.clone()], display: path }
    } else {
        ClaudeBin { program: path.clone(), prefix: Vec::new(), display: path }
    }
}

async fn resolve_claude_bin() -> Option<ClaudeBin> {
    if let Ok(p) = std::env::var("AICUT_CLAUDE_BIN") {
        if !p.trim().is_empty() {
            return Some(classify(p));
        }
    }
    let found = proc::which("claude").await;
    let mut fallback: Option<String> = None;
    for line in found {
        let lower = line.to_lowercase();
        if cfg!(windows) {
            if lower.ends_with(".exe") {
                return Some(classify(line));
            }
            if (lower.ends_with(".cmd") || lower.ends_with(".bat")) && fallback.is_none() {
                fallback = Some(line);
            }
        } else if fallback.is_none() {
            fallback = Some(line);
        }
    }
    if let Some(f) = fallback {
        return Some(classify(f));
    }
    if let Some(home) = proc::home_dir() {
        let cand = if cfg!(windows) { home.join(".local").join("bin").join("claude.exe") } else { home.join(".local").join("bin").join("claude") };
        if cand.exists() {
            return Some(classify(cand.to_string_lossy().to_string()));
        }
    }
    None
}

fn make_cmd(bin: &ClaudeBin) -> Command {
    let mut c = proc::cmd(&bin.program);
    for a in &bin.prefix {
        c.arg(a);
    }
    c
}

fn logged_in() -> bool {
    if std::env::var("ANTHROPIC_API_KEY").map(|v| !v.trim().is_empty()).unwrap_or(false) {
        return true;
    }
    if let Some(home) = proc::home_dir() {
        if home.join(".claude").join(".credentials.json").exists() {
            return true;
        }
    }
    false
}

async fn claude_version(bin: &ClaudeBin) -> Option<String> {
    let mut c = make_cmd(bin);
    c.arg("--version");
    let out = c.output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if v.is_empty() {
        None
    } else {
        Some(v)
    }
}

/// 助手工作目錄：設定目錄下，刻意沒有 CLAUDE.md（避免使用者其他專案記憶被載入）。
pub(crate) async fn workspace_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = crate::store::app_config_dir(app)?.join("agent-workspace");
    tokio::fs::create_dir_all(&dir).await.map_err(|e| AppError::Storage(format!("建立助手工作目錄失敗：{e}")))?;
    Ok(dir)
}

fn emit(app: &AppHandle, ev: AgentEvent) {
    let _ = app.emit("claude-stream", ev);
}

/// 解析單行 NDJSON 並轉成前端事件（stream-json 外層為 system/assistant/result/stream_event 包裝）。
fn parse_and_emit(app: &AppHandle, req: &str, line: &str) {
    let v: serde_json::Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => return,
    };
    match v.get("type").and_then(|t| t.as_str()) {
        Some("system") => {
            if v.get("subtype").and_then(|s| s.as_str()) == Some("init") {
                emit(
                    app,
                    AgentEvent {
                        req_id: req.to_string(),
                        kind: "system".into(),
                        session_id: v.get("session_id").and_then(|s| s.as_str()).map(String::from),
                        model: v.get("model").and_then(|m| m.as_str()).map(String::from),
                        ..Default::default()
                    },
                );
            }
        }
        Some("stream_event") => {
            let Some(ev) = v.get("event") else { return };
            match ev.get("type").and_then(|t| t.as_str()) {
                Some("content_block_delta") => {
                    if let Some(d) = ev.get("delta") {
                        if d.get("type").and_then(|t| t.as_str()) == Some("text_delta") {
                            if let Some(t) = d.get("text").and_then(|t| t.as_str()) {
                                emit(app, AgentEvent { req_id: req.to_string(), kind: "text".into(), text: Some(t.to_string()), ..Default::default() });
                            }
                        }
                    }
                }
                Some("content_block_start") => {
                    if let Some(cb) = ev.get("content_block") {
                        if cb.get("type").and_then(|t| t.as_str()) == Some("tool_use") {
                            let name = cb.get("name").and_then(|n| n.as_str()).unwrap_or("tool").to_string();
                            emit(app, AgentEvent { req_id: req.to_string(), kind: "tool".into(), tool: Some(name), ..Default::default() });
                        }
                    }
                }
                _ => {}
            }
        }
        Some("user") => {
            // tool_result 回合：把工具回傳摘要推給面板（截 300 字）
            if let Some(content) = v.pointer("/message/content").and_then(|c| c.as_array()) {
                for c in content {
                    if c.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                        let text = match c.get("content") {
                            Some(serde_json::Value::String(s)) => s.clone(),
                            Some(serde_json::Value::Array(arr)) => arr.iter().filter_map(|x| x.get("text").and_then(|t| t.as_str())).collect::<Vec<_>>().join("\n"),
                            _ => String::new(),
                        };
                        let short: String = text.chars().take(300).collect();
                        emit(app, AgentEvent { req_id: req.to_string(), kind: "tool_result".into(), text: Some(short), is_error: c.get("is_error").and_then(|b| b.as_bool()), ..Default::default() });
                    }
                }
            }
        }
        Some("result") => {
            emit(
                app,
                AgentEvent {
                    req_id: req.to_string(),
                    kind: "result".into(),
                    session_id: v.get("session_id").and_then(|s| s.as_str()).map(String::from),
                    is_error: v.get("is_error").and_then(|b| b.as_bool()),
                    text: v.get("result").and_then(|s| s.as_str()).map(String::from),
                    duration_ms: v.get("duration_ms").and_then(|d| d.as_u64()),
                    ..Default::default()
                },
            );
        }
        _ => {}
    }
}

/// codex CLI 的狀態（設定畫面用）。
#[tauri::command]
pub async fn codex_detect() -> ClaudeStatus {
    let (installed, version, path) = crate::codex::detect().await;
    // codex 沒有「登入與否」的輕量查法（要真的送一次請求），所以裝了就當可用，
    // 沒登入的話第一次呼叫會回錯誤訊息，比在這裡假裝知道誠實。
    ClaudeStatus { installed, version, logged_in: installed, path }
}

#[tauri::command]
pub async fn claude_detect() -> ClaudeStatus {
    match resolve_claude_bin().await {
        Some(bin) => {
            let version = claude_version(&bin).await;
            ClaudeStatus { installed: version.is_some(), version, logged_in: logged_in(), path: Some(bin.display) }
        }
        None => ClaudeStatus { installed: false, version: None, logged_in: logged_in(), path: None },
    }
}

/// 助手送出一次問答（多輪以 session_id + --resume 串接）。mode: "agent"（MCP 工具）| "advise"（純聊天）。
#[tauri::command]
pub async fn claude_send(
    app: AppHandle,
    state: State<'_, AppState>,
    req_id: String,
    prompt: String,
    session_id: Option<String>,
    model: Option<String>,
    mode: Option<String>,
    system_prompt: Option<String>,
) -> AppResult<()> {
    let mode = mode.unwrap_or_else(|| "agent".to_string());

    // HTTP 供應商：不開子程序，改跑自家的工具迴圈（工具來源同樣是內建 MCP bridge）。
    let backend = state.settings.read().agent_backend.clone();
    if let Some(kind) = crate::llm::LlmKind::parse(&backend) {
        return llm_send(app, state, req_id, prompt, session_id, model, &mode, kind, system_prompt).await;
    }

    let bin = resolve_claude_bin().await.ok_or_else(|| AppError::Agent("找不到 claude CLI，請先安裝 Claude Code 並登入".into()))?;
    let workspace = workspace_dir(&app).await?;

    let mut cmd = make_cmd(&bin);
    cmd.arg("-p")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages")
        .arg("--permission-mode")
        .arg("dontAsk");
    if mode == "agent" {
        // 內建 MCP server：每次寫最新 port/token 的設定檔（token 每次啟動隨機）
        let mcp = state.mcp.clone();
        let cfg_path = workspace.join("mcp.json");
        let cfg = serde_json::json!({
            "mcpServers": { crate::mcp::SERVER_NAME: { "type": "http", "url": mcp.url(), "headers": { "Authorization": format!("Bearer {}", mcp.token) } } }
        });
        tokio::fs::write(&cfg_path, serde_json::to_vec(&cfg).unwrap_or_default()).await?;
        cmd.arg("--mcp-config").arg(&cfg_path).arg("--strict-mcp-config").arg("--allowedTools").arg(format!("mcp__{}", crate::mcp::SERVER_NAME));
    }
    if let Some(sp) = system_prompt.as_ref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--append-system-prompt").arg(sp);
    }
    if let Some(sid) = session_id.as_ref().filter(|s| !s.is_empty()) {
        cmd.arg("--resume").arg(sid);
    }
    if let Some(m) = model.as_ref().filter(|s| !s.is_empty()) {
        cmd.arg("--model").arg(m);
    }
    cmd.current_dir(&workspace).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);

    let mut child = cmd.spawn().map_err(|e| AppError::Agent(format!("啟動 claude 失敗：{e}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        let p = prompt;
        tokio::spawn(async move {
            let _ = stdin.write_all(p.as_bytes()).await;
            let _ = stdin.shutdown().await;
        });
    }
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    if let Some(h) = state.agent_jobs.lock().remove(&req_id) {
        h.abort();
    }
    let app2 = app.clone();
    let req2 = req_id.clone();
    let jobs = state.agent_jobs.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let err_task = tokio::spawn(async move {
            let mut s = String::new();
            let mut rd = BufReader::new(stderr);
            let _ = rd.read_to_string(&mut s).await;
            s
        });
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !line.trim().is_empty() {
                parse_and_emit(&app2, &req2, &line);
            }
        }
        let status = child.wait().await;
        let err = err_task.await.unwrap_or_default();
        let code = status.ok().and_then(|s| s.code());
        if let Some(c) = code {
            if c != 0 {
                let msg = if err.trim().is_empty() { format!("claude 以結束碼 {c} 退出") } else { err.trim().to_string() };
                emit(&app2, AgentEvent { req_id: req2.clone(), kind: "error".into(), text: Some(msg), ..Default::default() });
            }
        }
        emit(&app2, AgentEvent { req_id: req2.clone(), kind: "done".into(), code, ..Default::default() });
        jobs.lock().remove(&req2);
    });
    state.agent_jobs.lock().insert(req_id, handle);
    Ok(())
}

#[tauri::command]
pub async fn claude_cancel(state: State<'_, AppState>, req_id: String) -> AppResult<()> {
    if let Some(h) = state.agent_jobs.lock().remove(&req_id) {
        h.abort();
    }
    Ok(())
}

// ---- HTTP 供應商（Anthropic / OpenAI 相容） ----

/// 從設定取這個供應商的 Base URL 與模型。
fn llm_endpoint(state: &AppState, kind: crate::llm::LlmKind) -> (String, String) {
    let s = state.settings.read();
    match kind {
        crate::llm::LlmKind::Anthropic => (s.llm_anthropic_base_url.clone(), s.llm_anthropic_model.clone()),
        crate::llm::LlmKind::OpenAi => (s.llm_openai_base_url.clone(), s.llm_openai_model.clone()),
    }
}

/// 助手的 HTTP 路徑：先回應前端（`system` 事件帶自產的 session id），
/// 再於背景跑工具迴圈，逐字送 `text`、每支工具送 `tool` / `tool_result`，收尾送 `result` + `done`。
#[allow(clippy::too_many_arguments)]
async fn llm_send(
    app: AppHandle,
    state: State<'_, AppState>,
    req_id: String,
    prompt: String,
    session_id: Option<String>,
    model: Option<String>,
    mode: &str,
    kind: crate::llm::LlmKind,
    system_prompt: Option<String>,
) -> AppResult<()> {
    let (base_url, cfg_model) = llm_endpoint(&state, kind);
    let model = model.filter(|m| !m.trim().is_empty()).unwrap_or(cfg_model);
    let cfg = crate::llm::LlmConfig::resolve(kind, Some(&base_url), Some(&model));
    if cfg.base.is_empty() {
        return Err(AppError::Agent("尚未設定 API Base URL".into()));
    }
    if cfg.model.trim().is_empty() {
        return Err(AppError::Agent("尚未指定模型（請在設定的 AI 區塊填模型名稱）".into()));
    }

    let with_tools = mode == "agent";
    // HTTP 沒有伺服器端 session，對話歷史存在 App 記憶體裡，id 由這裡產。
    let sid = session_id.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let mut history = state.llm_sessions.lock().get(&sid).cloned().unwrap_or_default();

    // CLI 會從 MCP handshake 拿到剪輯守則，HTTP 沒有 handshake，所以接在系統提示後面。
    let system = match system_prompt.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(sp) if with_tools => format!("{sp}\n\n{}", crate::mcp::INSTRUCTIONS),
        Some(sp) => sp.to_string(),
        None if with_tools => crate::mcp::INSTRUCTIONS.to_string(),
        None => String::new(),
    };

    emit(
        &app,
        AgentEvent {
            req_id: req_id.clone(),
            kind: "system".into(),
            session_id: Some(sid.clone()),
            model: Some(cfg.model.clone()),
            ..Default::default()
        },
    );

    if let Some(h) = state.agent_jobs.lock().remove(&req_id) {
        h.abort();
    }

    let app2 = app.clone();
    let req2 = req_id.clone();
    let jobs = state.agent_jobs.clone();
    let sessions = state.llm_sessions.clone();
    let bridge = state.mcp.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let started = std::time::Instant::now();
        let sink_app = app2.clone();
        let sink_req = req2.clone();
        let sink = move |ev: crate::llm::StreamEvent| match ev {
            crate::llm::StreamEvent::Text(t) => {
                emit(&sink_app, AgentEvent { req_id: sink_req.clone(), kind: "text".into(), text: Some(t), ..Default::default() })
            }
            crate::llm::StreamEvent::ToolStart(name) => {
                emit(&sink_app, AgentEvent { req_id: sink_req.clone(), kind: "tool".into(), tool: Some(name), ..Default::default() })
            }
            crate::llm::StreamEvent::ToolResult { text, is_error } => emit(
                &sink_app,
                AgentEvent { req_id: sink_req.clone(), kind: "tool_result".into(), text: Some(text), is_error: Some(is_error), ..Default::default() },
            ),
        };

        let sys = if system.trim().is_empty() { None } else { Some(system.as_str()) };
        let result = crate::llm::agent_loop::run(
            &app2,
            &bridge,
            crate::llm::client(),
            &cfg,
            with_tools,
            &mut history,
            prompt,
            sys,
            &sink,
        )
        .await;

        let ms = started.elapsed().as_millis() as u64;
        let code = match result {
            Ok(text) => {
                sessions.lock().insert(sid.clone(), history);
                emit(
                    &app2,
                    AgentEvent {
                        req_id: req2.clone(),
                        kind: "result".into(),
                        session_id: Some(sid.clone()),
                        is_error: Some(false),
                        text: Some(text),
                        duration_ms: Some(ms),
                        ..Default::default()
                    },
                );
                0
            }
            Err(e) => {
                // 失敗的那一輪不寫回歷史：留著壞掉的 tool_use / tool_result，
                // 下一次送出會整串被端點拒絕。
                emit(&app2, AgentEvent { req_id: req2.clone(), kind: "error".into(), text: Some(e), ..Default::default() });
                emit(
                    &app2,
                    AgentEvent {
                        req_id: req2.clone(),
                        kind: "result".into(),
                        session_id: Some(sid.clone()),
                        is_error: Some(true),
                        duration_ms: Some(ms),
                        ..Default::default()
                    },
                );
                1
            }
        };
        emit(&app2, AgentEvent { req_id: req2.clone(), kind: "done".into(), code: Some(code), ..Default::default() });
        jobs.lock().remove(&req2);
    });
    state.agent_jobs.lock().insert(req_id, handle);
    Ok(())
}

/// 寫入 / 刪除 API 金鑰（空字串 = 刪除）。金鑰只進 OS keychain，不落地到設定檔。
#[tauri::command]
pub async fn llm_key_set(kind: String, key: String) -> AppResult<()> {
    let k = crate::llm::LlmKind::parse(&kind).ok_or_else(|| AppError::Agent(format!("未知的供應商：{kind}")))?;
    crate::store::kc_set(k.key_account(), key.trim())
}

/// 只回「有沒有金鑰」，永不回傳明文。env 有設也算有。
#[tauri::command]
pub async fn llm_key_status(kind: String) -> bool {
    match crate::llm::LlmKind::parse(&kind) {
        Some(k) => crate::llm::resolve_key(k).is_some(),
        None => false,
    }
}

/// 供應商狀態（狀態列的燈與設定畫面用）。
///
/// 刻意由後端算：Base URL 正規化與「是不是地端端點」這兩條規則只能有一份，
/// 前端再實作一次就會兩邊不一致。
#[derive(Serialize)]
pub struct LlmStatus {
    /// 正規化後的 Base URL（空 = 沒設定）。
    pub base: String,
    pub model: String,
    pub has_key: bool,
    /// 地端端點（localhost / 127.0.0.1 / 區網）不需要金鑰。
    pub local: bool,
    /// 可以跑了：有 Base URL、有模型，且有金鑰或是地端端點。
    pub ready: bool,
}

#[tauri::command]
pub async fn llm_status(app: AppHandle, kind: String) -> LlmStatus {
    let Some(k) = crate::llm::LlmKind::parse(&kind) else {
        return LlmStatus { base: String::new(), model: String::new(), has_key: false, local: false, ready: false };
    };
    let (base_url, model) = {
        let state = app.state::<AppState>();
        llm_endpoint(&state, k)
    };
    let cfg = crate::llm::LlmConfig::resolve(k, Some(&base_url), Some(&model));
    let has_key = cfg.api_key.is_some();
    let local = cfg.is_local();
    LlmStatus {
        ready: !cfg.base.is_empty() && !cfg.model.trim().is_empty() && (has_key || local),
        base: cfg.base,
        model: cfg.model,
        has_key,
        local,
    }
}

/// 取模型清單（順便當「測試連線」用）。抓不到回空陣列，前端退回手填。
#[tauri::command]
pub async fn llm_list_models(kind: String, base_url: Option<String>) -> Vec<String> {
    match crate::llm::LlmKind::parse(&kind) {
        Some(k) => crate::llm::models::list(crate::llm::client(), k, base_url.as_deref()).await,
        None => Vec::new(),
    }
}

/// 一次性結構化輸出（AI 判讀）：零工具、限回合；回 `structured_output`（退回解析 `result` 字串）。
#[tauri::command]
/// 結構化產出。`backend` 只認 "codex"，其他一律走 claude ——
/// 不認得的字串當成 claude 而不是報錯：後端是使用者設定，設錯不該讓整個判讀掛掉。
pub async fn claude_structured(
    app: AppHandle,
    prompt: String,
    schema: serde_json::Value,
    model: Option<String>,
    system_prompt: Option<String>,
    timeout_ms: Option<u64>,
    backend: Option<String>,
) -> AppResult<serde_json::Value> {
    if backend.as_deref() == Some("codex") {
        let workspace = workspace_dir(&app).await?;
        return crate::codex::structured(workspace, prompt, schema, model, system_prompt, timeout_ms).await;
    }
    // HTTP 供應商：走 llm::structured（Anthropic 強制 tool_choice、OpenAI response_format，各有降級鏈）。
    if let Some(kind) = backend.as_deref().and_then(crate::llm::LlmKind::parse) {
        let state = app.state::<AppState>();
        let (base_url, cfg_model) = llm_endpoint(&state, kind);
        let model = model.filter(|m| !m.trim().is_empty()).unwrap_or(cfg_model);
        let cfg = crate::llm::LlmConfig::resolve(kind, Some(&base_url), Some(&model));
        if cfg.base.is_empty() {
            return Err(AppError::Agent("尚未設定 API Base URL".into()));
        }
        if cfg.model.trim().is_empty() {
            return Err(AppError::Agent("尚未指定模型".into()));
        }
        let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(240_000));
        let fut = crate::llm::structured(crate::llm::client(), &cfg, system_prompt.as_deref(), &prompt, &schema, 8192);
        return match tokio::time::timeout(timeout, fut).await {
            Ok(r) => r.map_err(AppError::Agent),
            Err(_) => Err(AppError::Timeout(timeout.as_millis() as u64)),
        };
    }
    let bin = resolve_claude_bin().await.ok_or_else(|| AppError::Agent("找不到 claude CLI，請先安裝 Claude Code 並登入".into()))?;
    let workspace = workspace_dir(&app).await?;
    let mut cmd = make_cmd(&bin);
    cmd.arg("-p")
        .arg("--output-format")
        .arg("json")
        .arg("--json-schema")
        .arg(serde_json::to_string(&schema).unwrap_or_default())
        .arg("--permission-mode")
        .arg("dontAsk")
        .arg("--max-turns")
        .arg("3");
    if let Some(sp) = system_prompt.as_ref().filter(|s| !s.trim().is_empty()) {
        cmd.arg("--append-system-prompt").arg(sp);
    }
    if let Some(m) = model.as_ref().filter(|s| !s.is_empty()) {
        cmd.arg("--model").arg(m);
    }
    cmd.current_dir(&workspace).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| AppError::Agent(format!("啟動 claude 失敗：{e}")))?;
    if let Some(mut stdin) = child.stdin.take() {
        tokio::spawn(async move {
            let _ = stdin.write_all(prompt.as_bytes()).await;
            let _ = stdin.shutdown().await;
        });
    }
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(240_000));
    let out = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(r) => r.map_err(|e| AppError::Agent(format!("claude 執行失敗：{e}")))?,
        Err(_) => return Err(AppError::Timeout(timeout.as_millis() as u64)),
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if !out.status.success() && stdout.trim().is_empty() {
        return Err(AppError::Agent(if stderr.trim().is_empty() { format!("claude 以結束碼 {:?} 退出", out.status.code()) } else { stderr.trim().to_string() }));
    }
    // stdout 可能夾雜非 JSON 行：取最後一個完整 JSON 物件
    let v: serde_json::Value = stdout
        .lines()
        .rev()
        .find_map(|l| serde_json::from_str::<serde_json::Value>(l.trim()).ok())
        .or_else(|| serde_json::from_str(stdout.trim()).ok())
        .ok_or_else(|| AppError::Agent(format!("claude 回應不是 JSON：{}", stdout.chars().take(300).collect::<String>())))?;
    if v.get("is_error").and_then(|b| b.as_bool()) == Some(true) {
        return Err(AppError::Agent(v.get("result").and_then(|s| s.as_str()).unwrap_or("claude 回報錯誤").to_string()));
    }
    if let Some(so) = v.get("structured_output") {
        if !so.is_null() {
            return Ok(so.clone());
        }
    }
    if let Some(s) = v.get("result").and_then(|s| s.as_str()) {
        let trimmed = s.trim().trim_start_matches("```json").trim_start_matches("```").trim_end_matches("```").trim();
        if let Ok(j) = serde_json::from_str::<serde_json::Value>(trimmed) {
            return Ok(j);
        }
    }
    Err(AppError::Agent("claude 未回結構化輸出".into()))
}

/// 前端用：helper 讓 commands::AppState 拿得到 app handle 相關資訊（保留擴充）。
#[allow(dead_code)]
pub fn app_state(app: &AppHandle) -> tauri::State<'_, AppState> {
    app.state::<AppState>()
}
