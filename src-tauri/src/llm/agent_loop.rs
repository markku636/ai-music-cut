//! 工具迴圈：送出 → 串流 → 有工具就執行 → 把結果接回去 → 再送，直到模型不再要工具。
//!
//! CLI 後端這一段是 Claude Code 自己在跑（透過 `--mcp-config` 連進本 App 的 MCP server），
//! 換成 HTTP 之後得自己來 —— 但工具來源完全相同：`mcp::McpBridge` 的工具目錄與呼叫機制
//! 與「誰在呼叫」無關，所以前端登記的那 29 支剪輯工具原封不動可用。
//!
//! 三個守門：
//! - 回合上限（`MAX_TURNS`）：避免無限往返燒 token
//! - 同名同參數連續三次即中止：小模型很容易卡在同一支工具上重試
//! - 對話歷史上限：HTTP 沒有伺服器端 session，整串歷史每回合都要重送，不修剪會越送越貴

use std::sync::Arc;

use tauri::AppHandle;

use super::{stream_turn, LlmConfig, LlmResult, Message, Sink, StopReason, StreamEvent, ToolOutput, ToolSpec, TurnRequest};
use crate::mcp::McpBridge;

/// 一次問答內最多來回幾次（含工具回合）。剪輯常常要「看 → 改 → 再看」，比 db-kit 那邊給得寬。
const MAX_TURNS: usize = 24;
/// 對話歷史保留的訊息則數上限。
pub const MAX_HISTORY: usize = 48;
/// 對話歷史序列化後的位元組上限（超過從最舊的開始丟）。
pub const MAX_HISTORY_BYTES: usize = 240 * 1024;
/// 每回合的輸出上限。
const MAX_TOKENS: u32 = 8192;
/// 工具結果推給面板時截斷的字數（與 CLI 後端的 `parse_and_emit` 一致）。
const TOOL_RESULT_PREVIEW: usize = 300;

/// 歷史修剪：先砍則數，再砍總量；一律從最舊的丟，且保持「Assistant 的工具呼叫」與
/// 「對應的 ToolResults」成對出現 —— 兩家 API 都會對落單的 tool_result 回 400。
pub fn trim_history(history: &mut Vec<Message>) {
    while history.len() > MAX_HISTORY {
        history.remove(0);
    }
    loop {
        // 開頭若是 ToolResults（它的 Assistant 已被丟掉）就繼續丟。
        if matches!(history.first(), Some(Message::ToolResults(_))) {
            history.remove(0);
            continue;
        }
        let size = serde_json::to_string(&history).map(|s| s.len()).unwrap_or(0);
        if size <= MAX_HISTORY_BYTES || history.len() <= 2 {
            break;
        }
        history.remove(0);
    }
}

/// MCP 工具目錄 → 模型看得懂的工具定義。三家的形狀本來就一樣（JSON Schema），
/// 差別只在包裝欄位名，那層由 anthropic.rs / openai.rs 各自處理。
pub fn tool_specs(bridge: &McpBridge) -> Vec<ToolSpec> {
    bridge
        .tools
        .read()
        .iter()
        .map(|t| ToolSpec { name: t.name.clone(), description: t.description.clone(), schema: t.input_schema.clone() })
        .collect()
}

/// 跑完一次問答。`history` 進來是這個 session 既有的訊息，回來是加上本回合之後的完整歷史。
#[allow(clippy::too_many_arguments)]
pub async fn run(
    app: &AppHandle,
    bridge: &Arc<McpBridge>,
    http: &reqwest::Client,
    cfg: &LlmConfig,
    with_tools: bool,
    history: &mut Vec<Message>,
    prompt: String,
    system: Option<&str>,
    sink: Sink<'_>,
) -> LlmResult<String> {
    if cfg.model.trim().is_empty() {
        return Err("尚未指定模型".to_string());
    }
    let specs: Vec<ToolSpec> = if with_tools { tool_specs(bridge) } else { Vec::new() };

    history.push(Message::User(prompt));
    trim_history(history);

    let mut answer = String::new();
    let mut last_sig: Option<String> = None;
    let mut repeat = 0usize;

    for turn in 0..MAX_TURNS {
        let req = TurnRequest { system, messages: history, tools: &specs, max_tokens: MAX_TOKENS, temperature: None };
        let out = stream_turn(http, cfg, &req, sink).await?;

        if !out.text.trim().is_empty() {
            answer = out.text.clone();
        }
        history.push(Message::Assistant { text: out.text, tool_calls: out.tool_calls.clone() });

        if out.tool_calls.is_empty() || out.stop != StopReason::ToolUse {
            if let StopReason::Other(reason) = &out.stop {
                if reason == "length" || reason == "max_tokens" {
                    answer.push_str("\n\n（回應長度達上限，內容可能不完整）");
                }
            }
            return Ok(answer);
        }

        // 同一支工具、同一組參數連續三次 = 卡住了，停下來比讓它繼續燒 token 好。
        let sig = out.tool_calls.iter().map(|c| format!("{}:{}", c.name, c.args)).collect::<Vec<_>>().join("|");
        if Some(&sig) == last_sig.as_ref() {
            repeat += 1;
            if repeat >= 2 {
                return Err("模型重複呼叫同一支工具且沒有進展，已中止".to_string());
            }
        } else {
            repeat = 0;
            last_sig = Some(sig);
        }

        let mut results = Vec::new();
        for call in &out.tool_calls {
            // 目錄裡沒有的工具直接回錯給模型（不要送進 bridge 白等 60 秒逾時）。
            let (content, is_error) = if !crate::mcp::has_tool(bridge, &call.name) {
                (format!("未知的工具：{}（請只用工具清單裡的名稱）", call.name), true)
            } else {
                match crate::mcp::call_tool(app, bridge, &call.name, call.args.clone()).await {
                    Ok(text) => (text, false),
                    Err(e) => (e, true),
                }
            };
            let preview: String = content.chars().take(TOOL_RESULT_PREVIEW).collect();
            sink(StreamEvent::ToolResult { text: preview, is_error });
            results.push(ToolOutput { id: call.id.clone(), name: call.name.clone(), content, is_error });
        }
        history.push(Message::ToolResults(results));
        trim_history(history);

        if turn == MAX_TURNS - 1 {
            return Err(format!("超過 {MAX_TURNS} 回合仍未收斂，已中止"));
        }
    }
    Ok(answer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::ToolCall;
    use serde_json::json;

    #[test]
    fn trim_drops_oldest_and_never_leaves_orphan_tool_results() {
        let mut h: Vec<Message> = Vec::new();
        for i in 0..(MAX_HISTORY + 5) {
            h.push(Message::User(format!("m{i}")));
        }
        trim_history(&mut h);
        assert_eq!(h.len(), MAX_HISTORY);

        let mut h2 = vec![
            Message::ToolResults(vec![ToolOutput { id: "t".into(), name: "n".into(), content: "c".into(), is_error: false }]),
            Message::User("後面這則才是完整的".into()),
        ];
        trim_history(&mut h2);
        assert!(matches!(h2.first(), Some(Message::User(_))));
    }

    #[test]
    fn trim_keeps_pairs_when_under_limits() {
        let mut h = vec![
            Message::User("q".into()),
            Message::Assistant { text: String::new(), tool_calls: vec![ToolCall { id: "1".into(), name: "list_seams".into(), args: json!({}) }] },
            Message::ToolResults(vec![ToolOutput { id: "1".into(), name: "list_seams".into(), content: "x".into(), is_error: false }]),
        ];
        trim_history(&mut h);
        assert_eq!(h.len(), 3);
    }

    #[test]
    fn tool_specs_mirror_mcp_catalog() {
        let bridge = McpBridge::new();
        *bridge.tools.write() = vec![crate::mcp::ToolDef {
            name: "blade_at".into(),
            description: "切一刀".into(),
            input_schema: json!({ "type": "object", "properties": { "ms": { "type": "number" } } }),
        }];
        let specs = tool_specs(&bridge);
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].name, "blade_at");
        assert_eq!(specs[0].schema["properties"]["ms"]["type"], "number");
    }
}
