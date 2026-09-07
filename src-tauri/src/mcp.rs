//! 內建 MCP server（Streamable HTTP，JSON-RPC 2.0）：讓 claude CLI 以 `--mcp-config` 連進來操作剪輯決策。
//!
//! - 只綁 127.0.0.1 隨機 port；每次啟動隨機 bearer token（寫進 agent workspace 的 mcp.json，只給自家 claude 子程序）。
//! - 工具目錄由前端登記（`mcp_set_tools`），呼叫時發 `mcp-tool-call` 事件給前端執行，
//!   前端以 `mcp_tool_result` 回寫 → oneshot 喚醒 HTTP 回應（60 s 逾時）。
//! - 手刻協定（initialize / notifications/initialized / tools/list / tools/call / ping）；
//!   單一 POST 端點回 application/json，GET 回 405，DELETE 回 204。
use std::collections::HashMap;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

pub const SERVER_NAME: &str = "aicut";
const PROTOCOL_VERSION: &str = "2025-06-18";
const TOOL_TIMEOUT_SECS: u64 = 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    #[serde(rename = "inputSchema")]
    pub input_schema: Value,
}

pub struct McpBridge {
    port: AtomicU16,
    pub token: String,
    pub tools: RwLock<Vec<ToolDef>>,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>,
}

impl McpBridge {
    pub fn new() -> Self {
        Self { port: AtomicU16::new(0), token: random_token(), tools: RwLock::new(Vec::new()), pending: Mutex::new(HashMap::new()) }
    }

    pub fn port(&self) -> u16 {
        self.port.load(Ordering::Relaxed)
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}/mcp", self.port())
    }

    /// 前端回寫工具結果。
    pub fn resolve(&self, id: &str, result: Result<Value, String>) -> bool {
        match self.pending.lock().remove(id) {
            Some(tx) => tx.send(result).is_ok(),
            None => false,
        }
    }
}

impl Default for McpBridge {
    fn default() -> Self {
        Self::new()
    }
}

fn random_token() -> String {
    use rand::RngCore;
    let mut b = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[derive(Clone)]
struct Ctx {
    app: AppHandle,
    bridge: Arc<McpBridge>,
}

#[derive(Serialize, Clone)]
struct ToolCallEvent {
    id: String,
    name: String,
    args: Value,
}

/// 綁定並啟動；回實際 port。
pub async fn start(app: AppHandle, bridge: Arc<McpBridge>) -> std::io::Result<u16> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    bridge.port.store(port, Ordering::Relaxed);
    let ctx = Ctx { app, bridge };
    let router = Router::new()
        .route("/mcp", post(handle).get(method_not_allowed).delete(|| async { StatusCode::NO_CONTENT }))
        .with_state(ctx);
    tauri::async_runtime::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            eprintln!("[mcp] server stopped: {e}");
        }
    });
    Ok(port)
}

async fn method_not_allowed() -> StatusCode {
    StatusCode::METHOD_NOT_ALLOWED
}

fn rpc_result(id: Value, result: Value) -> Response {
    let mut r = Json(json!({ "jsonrpc": "2.0", "id": id, "result": result })).into_response();
    r.headers_mut().insert("Mcp-Session-Id", axum::http::HeaderValue::from_static("aicut-1"));
    r
}

fn rpc_error(id: Value, code: i64, message: String) -> Response {
    Json(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })).into_response()
}

async fn handle(State(ctx): State<Ctx>, headers: HeaderMap, body: axum::body::Bytes) -> Response {
    let auth = headers.get("authorization").and_then(|v| v.to_str().ok()).unwrap_or("");
    if auth != format!("Bearer {}", ctx.bridge.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let req: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return rpc_error(Value::Null, -32700, format!("parse error: {e}")),
    };
    // 批次請求：逐一處理（罕見）
    if let Some(arr) = req.as_array() {
        let mut out = Vec::new();
        for r in arr {
            if let Some(resp) = dispatch(&ctx, r).await {
                out.push(resp);
            }
        }
        return Json(Value::Array(out)).into_response();
    }
    match dispatch(&ctx, &req).await {
        Some(v) => {
            if v.get("error").is_some() {
                return Json(v).into_response();
            }
            let id = v.get("id").cloned().unwrap_or(Value::Null);
            rpc_result(id, v.get("result").cloned().unwrap_or(Value::Null))
        }
        None => StatusCode::ACCEPTED.into_response(), // notification
    }
}

/// 回 Some(JSON-RPC 回應物件) 或 None（通知，不回應）。
async fn dispatch(ctx: &Ctx, req: &Value) -> Option<Value> {
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let id = req.get("id").cloned();
    if id.is_none() || method.starts_with("notifications/") {
        return None;
    }
    let id = id.unwrap();
    let result = match method {
        "initialize" => {
            let requested = req.pointer("/params/protocolVersion").and_then(|v| v.as_str()).unwrap_or(PROTOCOL_VERSION);
            json!({
                "protocolVersion": requested,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": SERVER_NAME, "version": env!("CARGO_PKG_VERSION") },
                "instructions": "你正在操作 AI Music Cut（podcast 自動粗剪）。以自然順暢為最高原則：先用 get_project_summary 看狀態（沒有逐字稿也能用；analyzed=false 就是還沒分析，這時沒有候選可判讀，但刀片 / 修剪 / 標記 / 章節 / 配樂都能直接做）、list_candidates 看候選，再用 set_decisions 接受或拒絕；unclear/rambling 類只建議不自動剪。要動剪輯手法時：list_seams 看有哪些接縫 → trim_seam 修剪（ripple 會改變成品長度、roll 不會）、blade_at 切一刀、insert_pause 在切點補呼吸。要拿掉雜音但保留節奏就用 set_selection + lift_selection（提起不關洞），不要用 add_cut。口頭禪 / 重複的詞用 find_text 先看幾次、再用 cut_text 一次剪掉（一次 undo 就能全還原），不要用 add_cut 逐段剪；find_text 沒命中時會附上這集真正的口頭禪。afterKeepId 只在下一次修剪前有效，連續操作請每次重新呼叫 list_seams。配樂：list_media → place_overlay（位置用成品時間）→ duck_overlay 讓它在人聲下自動閃避；閃避是看得見的音量控制點，不是壓縮器。章節用 set_chapters（會寫進成品檔案，標題要具體）。錄音本身有底噪 / 隆隆聲時先 get_cleanup 看量測結果，值得做才 set_cleanup（齒音沒有量測依據，不要自己開）。使用者說「這句可以放預告」就 add_highlight，之後那些會串成一支預告輸出。要節目筆記用 write_show_notes（讀逐字稿產摘要 / 章節 / 節錄，時間戳自動換算成成品時間），已經產過的用 get_show_notes 拿就好，不要重跑。你聽不到聲音，所以「哪裡小聲 / 這集吵不吵 / 要不要修聲」一律先用 get_loudness_profile 看響度輪廓，不要憑逐字稿猜、也不要叫使用者自己去聽。多人節目先 list_speakers 看有沒有講者標籤（一人一軌用 sync_mics 合併時會自動指派；單軌只能用 assign_speaker 手動標，不要自己猜）。「來賓的口頭禪剪掉、主持人的留著」用 cut_fillers_by_speaker，不要用 cut_text —— 那個不分是誰講的；不確定會剪到什麼就先 dryRun。要字幕或逐字稿用 export_captions（時間戳是成品時間，被剪掉的字整個不出現）。要把一次錄的多集切開先用 list_split_parts 看會切成幾段，分割輸出本身在 App 的「依章節分割輸出」裡做。使用者做完一輪判斷之後，可以用 learn_filler_decisions 把「他親手做過的贅字裁決」記起來（同一集重複呼叫是覆蓋），累積幾集之後 suggest_filler_rules 會建議哪些詞該進詞表 —— 那是**使用者自己的做法**，不是你的意見，所以照著回報就好，不要自己加碼。詞表只影響下一次分析要不要提出這個詞，不會動到已經做好的剪輯決策。"
            })
        }
        "ping" => json!({}),
        "tools/list" => {
            let tools = ctx.bridge.tools.read().clone();
            json!({ "tools": tools })
        }
        "tools/call" => {
            let name = req.pointer("/params/name").and_then(|n| n.as_str()).unwrap_or("").to_string();
            let args = req.pointer("/params/arguments").cloned().unwrap_or(json!({}));
            if !ctx.bridge.tools.read().iter().any(|t| t.name == name) {
                return Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32602, "message": format!("unknown tool {name}") } }));
            }
            let call_id = uuid::Uuid::new_v4().to_string();
            let (tx, rx) = oneshot::channel();
            ctx.bridge.pending.lock().insert(call_id.clone(), tx);
            let _ = ctx.app.emit("mcp-tool-call", ToolCallEvent { id: call_id.clone(), name: name.clone(), args });
            match tokio::time::timeout(std::time::Duration::from_secs(TOOL_TIMEOUT_SECS), rx).await {
                Ok(Ok(Ok(v))) => {
                    let text = match v {
                        Value::String(s) => s,
                        other => serde_json::to_string(&other).unwrap_or_default(),
                    };
                    json!({ "content": [{ "type": "text", "text": text }], "isError": false })
                }
                Ok(Ok(Err(msg))) => json!({ "content": [{ "type": "text", "text": msg }], "isError": true }),
                Ok(Err(_)) => json!({ "content": [{ "type": "text", "text": "tool handler dropped" }], "isError": true }),
                Err(_) => {
                    ctx.bridge.pending.lock().remove(&call_id);
                    json!({ "content": [{ "type": "text", "text": format!("tool {name} timed out after {TOOL_TIMEOUT_SECS}s") }], "isError": true })
                }
            }
        }
        _ => return Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("method not found: {method}") } })),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

// ---------------- commands ----------------

#[tauri::command]
pub fn mcp_set_tools(state: tauri::State<'_, crate::commands::AppState>, tools: Vec<ToolDef>) -> usize {
    let n = tools.len();
    *state.mcp.tools.write() = tools;
    n
}

#[tauri::command]
pub fn mcp_tool_result(state: tauri::State<'_, crate::commands::AppState>, id: String, result: Option<Value>, error: Option<String>) -> bool {
    match error {
        Some(e) => state.mcp.resolve(&id, Err(e)),
        None => state.mcp.resolve(&id, Ok(result.unwrap_or(Value::Null))),
    }
}

#[derive(Serialize)]
pub struct McpInfo {
    pub port: u16,
    pub url: String,
    pub tools: usize,
}

#[tauri::command]
pub fn mcp_info(state: tauri::State<'_, crate::commands::AppState>) -> McpInfo {
    McpInfo { port: state.mcp.port(), url: state.mcp.url(), tools: state.mcp.tools.read().len() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_hex_48() {
        let t = random_token();
        assert_eq!(t.len(), 48);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
