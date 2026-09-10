//! Anthropic-compatible：`POST {base}/messages`（Messages API）。
//!
//! 相容端點（Kimi 的 `/anthropic`、GLM 的 `/api/anthropic`、自架代理）走的是同一份 wire format，
//! 差別只在 base URL，所以這裡不做任何廠商分支。

use serde_json::{json, Value};

use super::{extract_json, http_error, sse, LlmConfig, LlmResult, Message, Sink, StopReason, StreamEvent, ToolCall, ToolSpec, TurnOutput, TurnRequest};

const API_VERSION: &str = "2023-06-01";
/// 結構化產出時強制呼叫的工具名。
const EMIT_TOOL: &str = "emit_result";

/// 訊息模型 → Anthropic `messages[]`。
fn build_messages(msgs: &[Message]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for m in msgs {
        match m {
            Message::User(text) => out.push(json!({ "role": "user", "content": [{ "type": "text", "text": text }] })),
            Message::Assistant { text, tool_calls } => {
                let mut content: Vec<Value> = Vec::new();
                if !text.trim().is_empty() {
                    content.push(json!({ "type": "text", "text": text }));
                }
                for tc in tool_calls {
                    content.push(json!({ "type": "tool_use", "id": tc.id, "name": tc.name, "input": tc.args }));
                }
                // 內容不可為空陣列（API 會 400）。
                if content.is_empty() {
                    content.push(json!({ "type": "text", "text": "" }));
                }
                out.push(json!({ "role": "assistant", "content": content }));
            }
            Message::ToolResults(results) => {
                let content: Vec<Value> = results
                    .iter()
                    .map(|r| json!({ "type": "tool_result", "tool_use_id": r.id, "content": r.content, "is_error": r.is_error }))
                    .collect();
                out.push(json!({ "role": "user", "content": content }));
            }
        }
    }
    out
}

fn build_body(cfg: &LlmConfig, req: &TurnRequest<'_>, stream: bool) -> Value {
    let mut body = json!({
        "model": cfg.model,
        "max_tokens": req.max_tokens,
        "messages": build_messages(req.messages),
        "stream": stream,
    });
    if let Some(sys) = req.system.filter(|s| !s.trim().is_empty()) {
        body["system"] = json!(sys);
    }
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }
    if !req.tools.is_empty() {
        body["tools"] = Value::Array(
            req.tools
                .iter()
                .map(|t| json!({ "name": t.name, "description": t.description, "input_schema": t.schema }))
                .collect(),
        );
    }
    body
}

fn request(http: &reqwest::Client, cfg: &LlmConfig, body: &Value) -> reqwest::RequestBuilder {
    let mut r = http
        .post(cfg.endpoint())
        .header("content-type", "application/json")
        .header("anthropic-version", API_VERSION)
        .json(body);
    if let Some(k) = cfg.api_key.as_deref().filter(|k| !k.is_empty()) {
        r = r.header("x-api-key", k);
        // 部分代理只認 Authorization（以 gateway 轉發到官方 API 的自架服務）。
        r = r.header("authorization", format!("Bearer {k}"));
    }
    r
}

/// 串流累積中的一個 content block。
#[derive(Default)]
struct Block {
    kind: String,
    id: String,
    name: String,
    json_buf: String,
}

pub async fn stream_turn(http: &reqwest::Client, cfg: &LlmConfig, req: &TurnRequest<'_>, sink: Sink<'_>) -> LlmResult<TurnOutput> {
    let body = build_body(cfg, req, true);
    let resp = request(http, cfg, &body).send().await.map_err(|e| format!("連線失敗：{e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(http_error(status, &text));
    }

    let mut text = String::new();
    let mut blocks: std::collections::HashMap<u64, Block> = std::collections::HashMap::new();
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    let mut stop = StopReason::End;
    let mut err: Option<String> = None;

    sse::read_sse(resp, |data| {
        let v: Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => return Ok(true), // 非 JSON 的心跳行直接略過
        };
        match v.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "content_block_start" => {
                let idx = v.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
                let cb = v.get("content_block").cloned().unwrap_or(Value::Null);
                let kind = cb.get("type").and_then(|t| t.as_str()).unwrap_or("").to_string();
                let name = cb.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                if kind == "tool_use" {
                    sink(StreamEvent::ToolStart(name.clone()));
                }
                blocks.insert(
                    idx,
                    Block { kind, id: cb.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string(), name, json_buf: String::new() },
                );
            }
            "content_block_delta" => {
                let idx = v.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
                let Some(d) = v.get("delta") else { return Ok(true) };
                match d.get("type").and_then(|t| t.as_str()).unwrap_or("") {
                    "text_delta" => {
                        if let Some(t) = d.get("text").and_then(|t| t.as_str()) {
                            text.push_str(t);
                            sink(StreamEvent::Text(t.to_string()));
                        }
                    }
                    "input_json_delta" => {
                        if let Some(p) = d.get("partial_json").and_then(|p| p.as_str()) {
                            blocks.entry(idx).or_default().json_buf.push_str(p);
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                let idx = v.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
                if let Some(b) = blocks.remove(&idx) {
                    if b.kind == "tool_use" {
                        let args = if b.json_buf.trim().is_empty() {
                            json!({})
                        } else {
                            serde_json::from_str(&b.json_buf).unwrap_or_else(|_| json!({}))
                        };
                        tool_calls.push(ToolCall { id: b.id, name: b.name, args });
                    }
                }
            }
            "message_delta" => {
                if let Some(sr) = v.pointer("/delta/stop_reason").and_then(|s| s.as_str()) {
                    stop = match sr {
                        "tool_use" => StopReason::ToolUse,
                        "end_turn" | "stop_sequence" => StopReason::End,
                        other => StopReason::Other(other.to_string()),
                    };
                }
            }
            "error" => {
                err = Some(v.pointer("/error/message").and_then(|m| m.as_str()).unwrap_or("stream error").to_string());
                return Ok(false);
            }
            "message_stop" => return Ok(false),
            _ => {}
        }
        Ok(true)
    })
    .await?;

    if let Some(e) = err {
        return Err(e);
    }
    // 有工具呼叫但 stop_reason 沒收到（部分相容端點省略 message_delta）→ 當成 tool_use。
    if !tool_calls.is_empty() && stop == StopReason::End {
        stop = StopReason::ToolUse;
    }
    Ok(TurnOutput { text, tool_calls, stop })
}

async fn post_json(http: &reqwest::Client, cfg: &LlmConfig, body: &Value) -> LlmResult<Value> {
    let resp = request(http, cfg, body).send().await.map_err(|e| format!("連線失敗：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(http_error(status, &text));
    }
    serde_json::from_str(&text).map_err(|e| format!("回應不是 JSON：{e}"))
}

/// 從非串流回應取出 `tool_use` 的 input（結構化產出的正路）。
fn tool_use_input(resp: &Value) -> Option<Value> {
    resp.get("content")?
        .as_array()?
        .iter()
        .find(|c| c.get("type").and_then(|t| t.as_str()) == Some("tool_use"))
        .and_then(|c| c.get("input").cloned())
}

/// 從非串流回應取出純文字（降級路徑用）。
fn text_of(resp: &Value) -> String {
    resp.get("content")
        .and_then(|c| c.as_array())
        .map(|arr| arr.iter().filter_map(|c| c.get("text").and_then(|t| t.as_str())).collect::<Vec<_>>().join(""))
        .unwrap_or_default()
}

/// 結構化產出。
///
/// 正路是「只給一支工具 + 強制 tool_choice」—— 比在提示裡拜託模型回 JSON 可靠得多。
/// 相容端點若不支援 tool_choice（400，或回了文字而不是 tool_use），
/// 退成「把 schema 附在提示裡 + 剝圍籬」。
pub async fn structured(
    http: &reqwest::Client,
    cfg: &LlmConfig,
    system: Option<&str>,
    prompt: &str,
    schema: &Value,
    max_tokens: u32,
) -> LlmResult<Value> {
    let tools = vec![ToolSpec {
        name: EMIT_TOOL.to_string(),
        description: "把結果依 schema 交回來。只能用這支工具回覆。".to_string(),
        schema: schema.clone(),
    }];
    let msgs = vec![Message::User(prompt.to_string())];
    let req = TurnRequest { system, messages: &msgs, tools: &tools, max_tokens, temperature: None };
    let mut body = build_body(cfg, &req, false);
    body["tool_choice"] = json!({ "type": "tool", "name": EMIT_TOOL });

    let first = post_json(http, cfg, &body).await;
    if let Ok(v) = &first {
        if let Some(input) = tool_use_input(v) {
            return Ok(input);
        }
        if let Some(j) = extract_json(&text_of(v)) {
            return Ok(j);
        }
    }

    // 降級：不用工具，改把 schema 寫進提示。
    let schema_text = serde_json::to_string(schema).unwrap_or_default();
    let fallback_prompt = format!("{prompt}\n\n只輸出符合以下 JSON Schema 的 JSON，不要任何解釋或程式碼圍籬：\n{schema_text}");
    let msgs2 = vec![Message::User(fallback_prompt)];
    let req2 = TurnRequest { system, messages: &msgs2, tools: &[], max_tokens, temperature: None };
    let body2 = build_body(cfg, &req2, false);
    let v = post_json(http, cfg, &body2).await.map_err(|e| match &first {
        // 兩次都失敗時，回報第一次（帶 tool_choice）的錯誤比較有診斷價值。
        Err(first_err) => format!("{first_err}（改用純文字重試也失敗：{e}）"),
        Ok(_) => e,
    })?;
    extract_json(&text_of(&v)).ok_or_else(|| "模型沒有回出可解析的 JSON".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::{LlmKind, ToolOutput};

    fn cfg() -> LlmConfig {
        LlmConfig { kind: LlmKind::Anthropic, base: "https://x/v1".into(), api_key: Some("k".into()), model: "m".into() }
    }

    #[test]
    fn tool_round_trip_shape() {
        let msgs = vec![
            Message::User("hi".into()),
            Message::Assistant { text: "".into(), tool_calls: vec![ToolCall { id: "t1".into(), name: "blade_at".into(), args: json!({"ms":100}) }] },
            Message::ToolResults(vec![ToolOutput { id: "t1".into(), name: "blade_at".into(), content: "ok".into(), is_error: false }]),
        ];
        let built = build_messages(&msgs);
        assert_eq!(built.len(), 3);
        assert_eq!(built[1]["content"][0]["type"], "tool_use");
        assert_eq!(built[2]["role"], "user");
        assert_eq!(built[2]["content"][0]["tool_use_id"], "t1");
    }

    #[test]
    fn body_carries_system_and_tools() {
        let tools = vec![ToolSpec { name: "list_seams".into(), description: "d".into(), schema: json!({"type":"object"}) }];
        let msgs = vec![Message::User("hi".into())];
        let req = TurnRequest { system: Some("persona"), messages: &msgs, tools: &tools, max_tokens: 256, temperature: Some(0.0) };
        let body = build_body(&cfg(), &req, true);
        assert_eq!(body["system"], "persona");
        assert_eq!(body["tools"][0]["input_schema"]["type"], "object");
        assert_eq!(body["max_tokens"], 256);
        assert_eq!(body["stream"], true);
    }

    #[test]
    fn structured_extractors() {
        let resp = json!({ "content": [{ "type": "tool_use", "name": EMIT_TOOL, "input": { "ok": true } }] });
        assert_eq!(tool_use_input(&resp).unwrap()["ok"], true);
        let textual = json!({ "content": [{ "type": "text", "text": "```json\n{\"ok\":false}\n```" }] });
        assert!(tool_use_input(&textual).is_none());
        assert_eq!(extract_json(&text_of(&textual)).unwrap()["ok"], false);
    }
}
