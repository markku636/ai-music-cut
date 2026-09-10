//! OpenAI-compatible：`POST {base}/chat/completions`。
//!
//! 相容端點的差異幾乎都落在三個欄位上，這裡各給一條降級路徑（一次請求最多重試兩次）：
//! - `max_tokens` vs `max_completion_tokens`（新版 OpenAI 模型只收後者）
//! - `temperature` 不接受非預設值（部分推理模型）
//! - `response_format: json_schema` 不支援（地端小模型、舊版代理）→ 見 `structured` 的降級鏈

use serde_json::{json, Value};

use super::{extract_json, http_error, sse, LlmConfig, LlmResult, Message, Sink, StopReason, StreamEvent, ToolCall, ToolSpec, TurnOutput, TurnRequest};

/// 結構化產出時強制呼叫的工具名（降級鏈第二段用）。
const EMIT_TOOL: &str = "emit_result";

#[derive(Clone, Copy)]
struct Compat {
    /// true = 用 `max_completion_tokens` 而非 `max_tokens`
    max_completion: bool,
    /// false = 整個不送 temperature
    temperature: bool,
}

impl Default for Compat {
    fn default() -> Self {
        Self { max_completion: false, temperature: true }
    }
}

fn build_messages(system: Option<&str>, msgs: &[Message]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    if let Some(sys) = system.filter(|s| !s.trim().is_empty()) {
        out.push(json!({ "role": "system", "content": sys }));
    }
    for m in msgs {
        match m {
            Message::User(text) => out.push(json!({ "role": "user", "content": text })),
            Message::Assistant { text, tool_calls } => {
                let mut msg = json!({ "role": "assistant", "content": text });
                if !tool_calls.is_empty() {
                    msg["tool_calls"] = Value::Array(
                        tool_calls
                            .iter()
                            .map(|tc| {
                                json!({
                                    "id": tc.id,
                                    "type": "function",
                                    "function": { "name": tc.name, "arguments": serde_json::to_string(&tc.args).unwrap_or_else(|_| "{}".into()) }
                                })
                            })
                            .collect(),
                    );
                }
                out.push(msg);
            }
            Message::ToolResults(results) => {
                for r in results {
                    out.push(json!({ "role": "tool", "tool_call_id": r.id, "content": r.content }));
                }
            }
        }
    }
    out
}

fn build_body(cfg: &LlmConfig, req: &TurnRequest<'_>, stream: bool, compat: Compat) -> Value {
    let mut body = json!({
        "model": cfg.model,
        "messages": build_messages(req.system, req.messages),
        "stream": stream,
    });
    let tokens_key = if compat.max_completion { "max_completion_tokens" } else { "max_tokens" };
    body[tokens_key] = json!(req.max_tokens);
    if compat.temperature {
        if let Some(t) = req.temperature {
            body["temperature"] = json!(t);
        }
    }
    if !req.tools.is_empty() {
        body["tools"] = Value::Array(
            req.tools
                .iter()
                .map(|t| json!({ "type": "function", "function": { "name": t.name, "description": t.description, "parameters": t.schema } }))
                .collect(),
        );
    }
    body
}

fn request(http: &reqwest::Client, cfg: &LlmConfig, body: &Value) -> reqwest::RequestBuilder {
    let mut r = http.post(cfg.endpoint()).header("content-type", "application/json").json(body);
    if let Some(k) = cfg.api_key.as_deref().filter(|k| !k.is_empty()) {
        r = r.header("authorization", format!("Bearer {k}"));
    }
    r
}

/// 由錯誤內容判斷下一步的相容性調整；回 `None` 代表沒得退了。
fn next_compat(body: &str, cur: Compat) -> Option<Compat> {
    let b = body.to_ascii_lowercase();
    if !cur.max_completion && b.contains("max_completion_tokens") {
        return Some(Compat { max_completion: true, ..cur });
    }
    if cur.temperature && b.contains("temperature") {
        return Some(Compat { temperature: false, ..cur });
    }
    None
}

/// 送出請求並在相容性問題上重試（最多兩次）。`extra` 會併進 body（結構化產出用）。
async fn send_with_compat(
    http: &reqwest::Client,
    cfg: &LlmConfig,
    req: &TurnRequest<'_>,
    stream: bool,
    extra: Option<&Value>,
) -> LlmResult<reqwest::Response> {
    let mut compat = Compat::default();
    for _ in 0..3 {
        let mut body = build_body(cfg, req, stream, compat);
        if let Some(Value::Object(map)) = extra {
            for (k, v) in map {
                body[k] = v.clone();
            }
        }
        let resp = request(http, cfg, &body).send().await.map_err(|e| format!("連線失敗：{e}"))?;
        let status = resp.status();
        if status.is_success() {
            return Ok(resp);
        }
        let text = resp.text().await.unwrap_or_default();
        match next_compat(&text, compat) {
            Some(next) => compat = next,
            None => return Err(http_error(status, &text)),
        }
    }
    Err("端點連續拒絕請求（已嘗試相容性調整）".to_string())
}

#[derive(Default)]
struct PartialCall {
    id: String,
    name: String,
    args: String,
}

pub async fn stream_turn(http: &reqwest::Client, cfg: &LlmConfig, req: &TurnRequest<'_>, sink: Sink<'_>) -> LlmResult<TurnOutput> {
    let resp = send_with_compat(http, cfg, req, true, None).await?;

    let mut text = String::new();
    let mut calls: std::collections::BTreeMap<u64, PartialCall> = std::collections::BTreeMap::new();
    let mut announced: std::collections::BTreeSet<u64> = std::collections::BTreeSet::new();
    let mut finish: Option<String> = None;
    let mut err: Option<String> = None;

    sse::read_sse(resp, |data| {
        let v: Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => return Ok(true),
        };
        if let Some(msg) = v.pointer("/error/message").and_then(|m| m.as_str()) {
            err = Some(msg.to_string());
            return Ok(false);
        }
        let Some(choice) = v.pointer("/choices/0") else { return Ok(true) };
        if let Some(t) = choice.pointer("/delta/content").and_then(|c| c.as_str()) {
            if !t.is_empty() {
                text.push_str(t);
                sink(StreamEvent::Text(t.to_string()));
            }
        }
        if let Some(tcs) = choice.pointer("/delta/tool_calls").and_then(|c| c.as_array()) {
            for tc in tcs {
                let idx = tc.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
                let slot = calls.entry(idx).or_default();
                if let Some(id) = tc.get("id").and_then(|i| i.as_str()) {
                    if !id.is_empty() {
                        slot.id = id.to_string();
                    }
                }
                if let Some(n) = tc.pointer("/function/name").and_then(|n| n.as_str()) {
                    if !n.is_empty() {
                        slot.name.push_str(n);
                    }
                }
                if let Some(a) = tc.pointer("/function/arguments").and_then(|a| a.as_str()) {
                    slot.args.push_str(a);
                }
                // 名字湊齊了就先報一次工具事件（面板要即時看到「正在用哪支工具」）。
                if !slot.name.is_empty() && !announced.contains(&idx) {
                    announced.insert(idx);
                    sink(StreamEvent::ToolStart(slot.name.clone()));
                }
            }
        }
        if let Some(f) = choice.get("finish_reason").and_then(|f| f.as_str()) {
            if !f.is_empty() {
                finish = Some(f.to_string());
            }
        }
        Ok(true)
    })
    .await?;

    if let Some(e) = err {
        return Err(e);
    }

    let tool_calls: Vec<ToolCall> = calls
        .into_values()
        .filter(|c| !c.name.is_empty())
        .enumerate()
        .map(|(i, c)| ToolCall {
            id: if c.id.is_empty() { format!("call_{i}") } else { c.id },
            name: c.name,
            args: if c.args.trim().is_empty() { json!({}) } else { serde_json::from_str(&c.args).unwrap_or_else(|_| json!({})) },
        })
        .collect();

    let stop = match finish.as_deref() {
        Some("tool_calls") | Some("function_call") => StopReason::ToolUse,
        Some("stop") | None => {
            if tool_calls.is_empty() {
                StopReason::End
            } else {
                StopReason::ToolUse
            }
        }
        Some(other) => StopReason::Other(other.to_string()),
    };

    Ok(TurnOutput { text, tool_calls, stop })
}

/// 非串流回應的第一個 choice 文字。
fn text_of(resp: &Value) -> String {
    resp.pointer("/choices/0/message/content").and_then(|c| c.as_str()).unwrap_or("").to_string()
}

/// 非串流回應的第一個 function call 參數（降級鏈第二段用）。
fn tool_args(resp: &Value) -> Option<Value> {
    let raw = resp.pointer("/choices/0/message/tool_calls/0/function/arguments")?.as_str()?;
    serde_json::from_str(raw).ok()
}

async fn post_json(http: &reqwest::Client, cfg: &LlmConfig, req: &TurnRequest<'_>, extra: Option<&Value>) -> LlmResult<Value> {
    let resp = send_with_compat(http, cfg, req, false, extra).await?;
    let text = resp.text().await.unwrap_or_default();
    serde_json::from_str(&text).map_err(|e| format!("回應不是 JSON：{e}"))
}

/// 結構化產出，三段降級：
/// 1. `response_format: json_schema`（官方與大多數代理支援，最可靠）
/// 2. 強制 function call（老一點的端點吃這套）
/// 3. 把 schema 寫進提示 + 剝圍籬（地端小模型的最後一招）
pub async fn structured(
    http: &reqwest::Client,
    cfg: &LlmConfig,
    system: Option<&str>,
    prompt: &str,
    schema: &Value,
    max_tokens: u32,
) -> LlmResult<Value> {
    let msgs = vec![Message::User(prompt.to_string())];
    let req = TurnRequest { system, messages: &msgs, tools: &[], max_tokens, temperature: None };

    // 1) response_format
    let rf = json!({
        "response_format": {
            "type": "json_schema",
            "json_schema": { "name": "result", "schema": schema, "strict": false }
        }
    });
    let first = post_json(http, cfg, &req, Some(&rf)).await;
    if let Ok(v) = &first {
        if let Some(j) = extract_json(&text_of(v)) {
            return Ok(j);
        }
    }

    // 2) 強制 function call
    let tools = vec![ToolSpec {
        name: EMIT_TOOL.to_string(),
        description: "把結果依 schema 交回來。只能用這支工具回覆。".to_string(),
        schema: schema.clone(),
    }];
    let req2 = TurnRequest { system, messages: &msgs, tools: &tools, max_tokens, temperature: None };
    let forced = json!({ "tool_choice": { "type": "function", "function": { "name": EMIT_TOOL } } });
    if let Ok(v) = post_json(http, cfg, &req2, Some(&forced)).await {
        if let Some(args) = tool_args(&v) {
            return Ok(args);
        }
        if let Some(j) = extract_json(&text_of(&v)) {
            return Ok(j);
        }
    }

    // 3) 純提示 + 剝圍籬
    let schema_text = serde_json::to_string(schema).unwrap_or_default();
    let fallback_prompt = format!("{prompt}\n\n只輸出符合以下 JSON Schema 的 JSON，不要任何解釋或程式碼圍籬：\n{schema_text}");
    let msgs3 = vec![Message::User(fallback_prompt)];
    let req3 = TurnRequest { system, messages: &msgs3, tools: &[], max_tokens, temperature: None };
    let v = post_json(http, cfg, &req3, None).await.map_err(|e| match &first {
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
        LlmConfig { kind: LlmKind::OpenAi, base: "https://x/v1".into(), api_key: Some("k".into()), model: "m".into() }
    }

    #[test]
    fn messages_shape_with_tools() {
        let msgs = vec![
            Message::User("hi".into()),
            Message::Assistant { text: "".into(), tool_calls: vec![ToolCall { id: "c1".into(), name: "blade_at".into(), args: json!({"ms":1}) }] },
            Message::ToolResults(vec![ToolOutput { id: "c1".into(), name: "blade_at".into(), content: "ok".into(), is_error: false }]),
        ];
        let built = build_messages(Some("sys"), &msgs);
        assert_eq!(built[0]["role"], "system");
        assert_eq!(built[2]["tool_calls"][0]["function"]["name"], "blade_at");
        // arguments 必須是字串化的 JSON，不是物件
        assert!(built[2]["tool_calls"][0]["function"]["arguments"].is_string());
        assert_eq!(built[3]["role"], "tool");
        assert_eq!(built[3]["tool_call_id"], "c1");
    }

    #[test]
    fn compat_downgrade_chain() {
        let c = Compat::default();
        let next = next_compat("Unsupported parameter: 'max_tokens' is not supported, use 'max_completion_tokens'", c).unwrap();
        assert!(next.max_completion);
        let next2 = next_compat("temperature does not support 0.0 with this model", next).unwrap();
        assert!(!next2.temperature);
        assert!(next_compat("some other error", next2).is_none());
    }

    #[test]
    fn body_uses_max_completion_when_downgraded() {
        let msgs = vec![Message::User("hi".into())];
        let req = TurnRequest { system: None, messages: &msgs, tools: &[], max_tokens: 64, temperature: Some(0.2) };
        let body = build_body(&cfg(), &req, true, Compat { max_completion: true, temperature: false });
        assert_eq!(body["max_completion_tokens"], 64);
        assert!(body.get("max_tokens").is_none());
        assert!(body.get("temperature").is_none());
    }

    #[test]
    fn structured_extractors() {
        let rf = json!({ "choices": [{ "message": { "content": "{\"ok\":1}" } }] });
        assert_eq!(extract_json(&text_of(&rf)).unwrap()["ok"], 1);
        let fc = json!({ "choices": [{ "message": { "tool_calls": [{ "function": { "name": EMIT_TOOL, "arguments": "{\"ok\":2}" } }] } }] });
        assert_eq!(tool_args(&fc).unwrap()["ok"], 2);
        assert!(tool_args(&rf).is_none());
    }
}
