//! AI 助手 / AI 判讀：驅動本機 `claude` CLI（使用者的 Claude 訂閱登入）。承襲 db-kit agent.rs。
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
async fn workspace_dir(app: &AppHandle) -> AppResult<PathBuf> {
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
    let bin = resolve_claude_bin().await.ok_or_else(|| AppError::Agent("找不到 claude CLI，請先安裝 Claude Code 並登入".into()))?;
    let workspace = workspace_dir(&app).await?;
    let mode = mode.unwrap_or_else(|| "agent".to_string());

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

/// 一次性結構化輸出（AI 判讀）：零工具、限回合；回 `structured_output`（退回解析 `result` 字串）。
#[tauri::command]
pub async fn claude_structured(
    app: AppHandle,
    prompt: String,
    schema: serde_json::Value,
    model: Option<String>,
    system_prompt: Option<String>,
    timeout_ms: Option<u64>,
) -> AppResult<serde_json::Value> {
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
