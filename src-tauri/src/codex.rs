//! Codex CLI 後端：結構化產出（判讀 / 審核 / 節目筆記）的第二個選擇。
//!
//! 為什麼只做結構化這一段：`codex exec --output-schema` 正好對得上 App 既有的
//! 「給 schema、要一份 JSON 回來」的用法。至於 AI 助手那條**工具迴圈**，
//! codex 要走 `$CODEX_HOME/config.toml` 的 `[mcp_servers]` 才連得到我們的 MCP server，
//! 那是使用者環境的設定、不是 App 能替他寫的，所以助手仍然只走 claude。
//! 這件事在設定畫面要講清楚，不要讓人以為切過去什麼都能用。
//!
//! **這個檔案的實機往返沒有驗證過** —— 開發機上沒有安裝 codex。
//! 指令組法照官方文件（`codex exec` / `--json` / `--output-schema` / `-o`），
//! 組指令與解析輸出的部分有單元測試，但沒跑過真的 codex。

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::io::AsyncWriteExt;

use crate::error::{AppError, AppResult};
use crate::proc;

/// 找得到的 codex 執行檔。
pub struct CodexBin {
    pub program: String,
    pub prefix: Vec<String>,
    pub display: String,
}

fn classify(path: String) -> CodexBin {
    let lower = path.to_lowercase();
    if cfg!(windows) && (lower.ends_with(".cmd") || lower.ends_with(".bat")) {
        // 跟 claude 同一個處理：npm shim 走 cmd /C 會撞上 8191 字元上限，
        // 但 codex 的提示是走 stdin 的，所以這裡只要能啟動就好。
        CodexBin { program: "cmd".to_string(), prefix: vec!["/C".to_string(), path.clone()], display: path }
    } else {
        CodexBin { program: path.clone(), prefix: Vec::new(), display: path }
    }
}

pub async fn resolve_codex_bin() -> Option<CodexBin> {
    if let Ok(p) = std::env::var("AICUT_CODEX_BIN") {
        if !p.trim().is_empty() {
            return Some(classify(p));
        }
    }
    let found = proc::which("codex").await;
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
    fallback.map(classify)
}

fn make_cmd(bin: &CodexBin) -> tokio::process::Command {
    let mut c = proc::cmd(&bin.program);
    for a in &bin.prefix {
        c.arg(a);
    }
    c
}

/// `codex exec` 的旗標組法。抽出來是為了能在沒有安裝 codex 的機器上測。
///
/// - `--json`：JSONL 事件流（我們不靠它取結果，但它讓失敗時的 stderr/stdout 好讀）
/// - `--output-schema`：要求回應符合這份 schema
/// - `-o`：把最後一則訊息寫到檔案 —— **結果從這個檔案讀**，不從 stdout 撈，
///   因為 stdout 混著事件流，硬撈容易撿到別的 JSON。
/// - `--skip-git-repo-check`：使用者的音檔資料夾通常不是 git repo
pub fn exec_args(schema_path: &Path, out_path: &Path, model: Option<&str>) -> Vec<String> {
    let mut v = vec![
        "exec".to_string(),
        "--json".to_string(),
        "--skip-git-repo-check".to_string(),
        "--output-schema".to_string(),
        schema_path.to_string_lossy().into_owned(),
        "-o".to_string(),
        out_path.to_string_lossy().into_owned(),
    ];
    // 模型走 codex 自己的設定（`$CODEX_HOME/config.toml` 的 model）。
    // 只有使用者在我們這裡明確指定時才覆寫，否則不要多送旗標去賭它存在。
    if let Some(m) = model.filter(|s| !s.trim().is_empty()) {
        v.push("-c".to_string());
        v.push(format!("model=\"{m}\""));
    }
    v
}

/// 把 `-o` 寫出來的那份最後訊息解析成 JSON（容忍 ```json 圍欄）。
pub fn parse_last_message(text: &str) -> Option<serde_json::Value> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(t) {
        return Some(v);
    }
    // 有些模型會把 JSON 包在 markdown 圍欄裡
    let stripped = t
        .trim_start_matches("```json")
        .trim_start_matches("```JSON")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    serde_json::from_str::<serde_json::Value>(stripped).ok().or_else(|| {
        // 最後一招：抓第一個 { 到最後一個 } 之間
        let s = t.find('{')?;
        let e = t.rfind('}')?;
        if e > s { serde_json::from_str::<serde_json::Value>(&t[s..=e]).ok() } else { None }
    })
}

pub async fn detect() -> (bool, Option<String>, Option<String>) {
    let Some(bin) = resolve_codex_bin().await else {
        return (false, None, None);
    };
    let mut c = make_cmd(&bin);
    c.arg("--version").stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let ver = match tokio::time::timeout(std::time::Duration::from_secs(10), c.output()).await {
        Ok(Ok(o)) => {
            let s = String::from_utf8_lossy(&o.stdout);
            s.lines().next().map(|l| l.trim().to_string()).filter(|l| !l.is_empty())
        }
        _ => None,
    };
    (true, ver, Some(bin.display.clone()))
}

/// 結構化產出：給 schema、要一份符合它的 JSON 回來。
pub async fn structured(
    workspace: PathBuf,
    prompt: String,
    schema: serde_json::Value,
    model: Option<String>,
    system_prompt: Option<String>,
    timeout_ms: Option<u64>,
) -> AppResult<serde_json::Value> {
    let bin = resolve_codex_bin()
        .await
        .ok_or_else(|| AppError::Agent("找不到 codex CLI。安裝：npm i -g @openai/codex，然後執行 codex login".into()))?;

    // schema 與輸出都用暫存檔：schema 太長塞不進命令列，輸出從檔案讀才不會撈到事件流裡的別的 JSON
    let dir = std::env::temp_dir().join(format!("aicut-codex-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&dir).await.map_err(|e| AppError::Io(format!("建立暫存資料夾失敗：{e}")))?;
    let schema_path = dir.join("schema.json");
    let out_path = dir.join("out.txt");
    tokio::fs::write(&schema_path, serde_json::to_vec(&schema).unwrap_or_default())
        .await
        .map_err(|e| AppError::Io(format!("寫入 schema 失敗：{e}")))?;

    let mut cmd = make_cmd(&bin);
    for a in exec_args(&schema_path, &out_path, model.as_deref()) {
        cmd.arg(a);
    }
    cmd.current_dir(&workspace).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| AppError::Agent(format!("啟動 codex 失敗：{e}")))?;

    // codex 沒有 --append-system-prompt，所以把系統提示接在使用者提示前面一起送進 stdin
    let full = match system_prompt.as_ref().filter(|s| !s.trim().is_empty()) {
        Some(sp) => format!("{sp}\n\n{prompt}"),
        None => prompt,
    };
    if let Some(mut stdin) = child.stdin.take() {
        tokio::spawn(async move {
            let _ = stdin.write_all(full.as_bytes()).await;
            let _ = stdin.shutdown().await;
        });
    }

    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(240_000));
    let out = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(r) => r.map_err(|e| AppError::Agent(format!("codex 執行失敗：{e}")))?,
        Err(_) => {
            let _ = tokio::fs::remove_dir_all(&dir).await;
            return Err(AppError::Timeout(timeout.as_millis() as u64));
        }
    };

    let last = tokio::fs::read_to_string(&out_path).await.unwrap_or_default();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let _ = tokio::fs::remove_dir_all(&dir).await;

    if let Some(v) = parse_last_message(&last) {
        return Ok(v);
    }
    if !out.status.success() {
        let msg = if stderr.trim().is_empty() { stdout.trim().to_string() } else { stderr.trim().to_string() };
        return Err(AppError::Agent(if msg.is_empty() {
            format!("codex 以結束碼 {:?} 退出", out.status.code())
        } else {
            msg.chars().take(400).collect::<String>()
        }));
    }
    Err(AppError::Agent("codex 沒有回出符合 schema 的 JSON".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exec_args_uses_output_file_not_stdout() {
        let a = exec_args(Path::new("/tmp/s.json"), Path::new("/tmp/o.txt"), None);
        assert!(a.contains(&"exec".to_string()));
        assert!(a.contains(&"--output-schema".to_string()));
        // 結果一定要從 -o 的檔案讀：stdout 混著 --json 的事件流，硬撈會撿到別的 JSON
        assert!(a.contains(&"-o".to_string()));
        assert!(a.contains(&"/tmp/o.txt".to_string()));
        // 使用者的音檔資料夾通常不是 git repo
        assert!(a.contains(&"--skip-git-repo-check".to_string()));
    }

    #[test]
    fn model_flag_only_when_asked() {
        let none = exec_args(Path::new("s"), Path::new("o"), None);
        assert!(!none.iter().any(|x| x.starts_with("model=")));
        let some = exec_args(Path::new("s"), Path::new("o"), Some("gpt-5.5"));
        assert!(some.contains(&"model=\"gpt-5.5\"".to_string()));
        // 空字串等於沒指定，不要送一個 model="" 出去
        let empty = exec_args(Path::new("s"), Path::new("o"), Some("  "));
        assert!(!empty.iter().any(|x| x.starts_with("model=")));
    }

    #[test]
    fn parses_plain_json() {
        let v = parse_last_message(r#"{"a":1}"#).unwrap();
        assert_eq!(v["a"], 1);
    }

    #[test]
    fn parses_fenced_json() {
        let v = parse_last_message("```json\n{\"a\":2}\n```").unwrap();
        assert_eq!(v["a"], 2);
    }

    #[test]
    fn parses_json_with_surrounding_prose() {
        // 模型有時候會多寫一句話，schema 模式下不該發生，但別為此整個失敗
        let v = parse_last_message("這是結果：\n{\"a\":3}\n希望有幫助").unwrap();
        assert_eq!(v["a"], 3);
    }

    #[test]
    fn empty_is_none() {
        assert!(parse_last_message("").is_none());
        assert!(parse_last_message("   \n ").is_none());
        assert!(parse_last_message("完全沒有 JSON").is_none());
    }
}
