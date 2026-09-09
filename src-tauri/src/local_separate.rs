//! 本機人聲分離（demucs）：把一個音檔拆成人聲與伴奏（或四軌）。
//!
//! 跟 `local_asr` 同一套模式：偵測 python 與套件 → 一鍵安裝 → 跑子行程並逐行回報。
//! 差別是這裡**不需要自己寫 python 腳本** —— demucs 本身就是一支 CLI
//! （`python -m demucs`），輸出檔名固定，我們只要負責選參數、等它跑完、把檔案搬到位。
//!
//! **模型選 htdemucs**：demucs 的預設，四軌品質最好；`--two-stems=vocals` 時它只輸出
//! vocals / no_vocals 兩個檔，比事後自己混回去準（分離器內部是四軌一起解的）。
//!
//! **實機驗證過**（demucs 4.1.0、34.5 秒的語音檔、RTX 5070 Ti，整條約 8 秒）：
//! 輸出確實落在 `<out>/htdemucs/<檔名>/{vocals,no_vocals}.wav`，兩軌長度與來源一致
//! （差 0.5 ms），進度條格式是 `NN%|…`。demucs 會帶進 torch（幾百 MB），所以不自動安裝。

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::error::{AppError, AppResult};
use crate::proc;

/// 分離出來的一軌。形狀跟前端原本吃的一樣，UI 不用改。
#[derive(Debug, Clone, Serialize)]
pub struct SeparateStem {
    /// demucs 的軌名（vocals / no_vocals / drums / bass / other）。
    pub name: String,
    /// 給人看的名字。
    pub label: String,
    pub format: String,
    pub path: String,
    pub bytes: u64,
}

#[derive(Serialize, Clone, Default)]
pub struct LocalSeparateStatus {
    pub python: bool,
    pub python_version: Option<String>,
    /// python 裡 import 得到 demucs。
    pub demucs: bool,
    /// 給使用者照著做的安裝指令。
    pub install_hint: String,
}

#[derive(Serialize, Clone)]
struct SepEvent {
    job_id: String,
    event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pct: Option<u8>,
}

/// demucs 會把 torch 一起帶進來（CPU 版就好幾百 MB），所以**不**自動安裝。
pub fn install_args() -> Vec<String> {
    ["-m", "pip", "install", "-U", "--progress-bar", "off", "--disable-pip-version-check", "demucs"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

pub fn install_command() -> String {
    format!("python {}", install_args().join(" "))
}

/// 兩軌（人聲 / 伴奏）或四軌。字串是 UI 傳進來的，這裡收斂成 demucs 認得的參數。
pub fn demucs_args(input: &str, out_dir: &str, stems: &str) -> Vec<String> {
    let mut a: Vec<String> = ["-m", "demucs", "-n", "htdemucs"].iter().map(|s| s.to_string()).collect();
    // 兩軌時交給 demucs 自己合（它內部還是四軌解，再把三軌加起來），比事後自己混準
    if stems != "4" {
        a.push("--two-stems=vocals".to_string());
    }
    a.push("-o".to_string());
    a.push(out_dir.to_string());
    a.push(input.to_string());
    a
}

/// demucs 把結果寫在 `<out>/<model>/<檔名去副檔名>/<軌>.wav`。
pub fn stem_path(out_dir: &Path, input: &Path, stem: &str) -> PathBuf {
    let stem_name = input.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    out_dir.join("htdemucs").join(stem_name).join(format!("{stem}.wav"))
}

/// 這次會產出哪幾軌（順序就是 UI 的顯示順序）。
pub fn expected_stems(stems: &str) -> Vec<(&'static str, &'static str)> {
    if stems == "4" {
        vec![("vocals", "人聲"), ("drums", "鼓"), ("bass", "貝斯"), ("other", "其他")]
    } else {
        vec![("vocals", "人聲"), ("no_vocals", "伴奏（去人聲）")]
    }
}

/// demucs 的進度是 stderr 上的百分比條（`  38%|███...`）。抽出那個數字。
pub fn parse_progress(line: &str) -> Option<u8> {
    let idx = line.find('%')?;
    let head: String = line[..idx].chars().rev().take_while(|c| c.is_ascii_digit()).collect();
    if head.is_empty() {
        return None;
    }
    let n: u32 = head.chars().rev().collect::<String>().parse().ok()?;
    if n > 100 {
        return None;
    }
    Some(n as u8)
}

async fn python_bin() -> Option<String> {
    if let Ok(p) = std::env::var("AICUT_PYTHON") {
        if !p.trim().is_empty() {
            return Some(p);
        }
    }
    for name in ["python", "python3", "py"] {
        if let Some(first) = proc::which(name).await.into_iter().next() {
            return Some(first);
        }
    }
    None
}

pub async fn detect() -> LocalSeparateStatus {
    let hint = install_command();
    let Some(py) = python_bin().await else {
        return LocalSeparateStatus { python: false, python_version: None, demucs: false, install_hint: hint };
    };
    let version = proc::cmd(&py)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .await
        .ok()
        .filter(|o| o.status.success())
        .map(|o| {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() { String::from_utf8_lossy(&o.stderr).trim().to_string() } else { s }
        });
    let has = proc::cmd(&py)
        .arg("-c")
        .arg("import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('demucs') else 1)")
        .stdin(Stdio::null())
        .status()
        .await
        .map(|s| s.success())
        .unwrap_or(false);
    LocalSeparateStatus { python: true, python_version: version, demucs: has, install_hint: hint }
}

fn emit(app: &AppHandle, job_id: &str, event: &str, message: Option<&str>, pct: Option<u8>) {
    let _ = app.emit(
        "local-separate",
        SepEvent { job_id: job_id.to_string(), event: event.to_string(), message: message.map(|s| s.to_string()), pct },
    );
}

/// 一鍵安裝 demucs（會連 torch 一起帶進來，幾百 MB）。輸出逐行送到前端。
pub async fn install(app: AppHandle, job_id: String) -> AppResult<bool> {
    let py = python_bin().await.ok_or_else(|| AppError::Agent("找不到 python，無法安裝".into()))?;
    emit(&app, &job_id, "status", Some("安裝 demucs（含 torch，會下載幾百 MB）"), None);
    let mut cmd = proc::cmd(&py);
    for a in install_args() {
        cmd.arg(a);
    }
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| AppError::Agent(format!("啟動 pip 失敗：{e}")))?;
    if let Some(out) = child.stdout.take() {
        let app2 = app.clone();
        let jid = job_id.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    emit(&app2, &jid, "line", Some(line.trim()), None);
                }
            }
        });
    }
    let status = child.wait().await.map_err(|e| AppError::Agent(format!("安裝失敗：{e}")))?;
    emit(&app, &job_id, "done", None, None);
    Ok(status.success())
}

pub async fn separate(
    app: AppHandle,
    job_id: String,
    path: String,
    stems: String,
    out_dir: Option<String>,
) -> AppResult<Vec<SeparateStem>> {
    let py = python_bin().await.ok_or_else(|| AppError::Agent("找不到 python，無法在本機分離".into()))?;
    let src = PathBuf::from(&path);
    let dir = match out_dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => src.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| PathBuf::from(".")),
    };
    tokio::fs::create_dir_all(&dir).await.map_err(|e| AppError::Io(format!("建不出輸出資料夾：{e}")))?;

    let args = demucs_args(&path, &dir.to_string_lossy(), &stems);
    emit(&app, &job_id, "status", Some("載入模型（第一次會先下載）"), None);

    let mut cmd = proc::cmd(&py);
    for a in &args {
        cmd.arg(a);
    }
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| AppError::Agent(format!("啟動 demucs 失敗：{e}")))?;

    // demucs 把進度印在 stderr；最後一則錯誤留著，失敗時當訊息用
    let last_line = std::sync::Arc::new(parking_lot::Mutex::new(String::new()));
    if let Some(err) = child.stderr.take() {
        let app2 = app.clone();
        let jid = job_id.clone();
        let keep = last_line.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some(p) = parse_progress(&line) {
                    emit(&app2, &jid, "progress", None, Some(p));
                } else if !line.trim().is_empty() {
                    *keep.lock() = line.trim().to_string();
                    emit(&app2, &jid, "status", Some(line.trim()), None);
                }
            }
        });
    }

    let status = child.wait().await.map_err(|e| AppError::Agent(format!("分離失敗：{e}")))?;
    if !status.success() {
        let detail = last_line.lock().clone();
        return Err(AppError::Agent(if detail.is_empty() {
            format!("本機分離以結束碼 {:?} 退出　→ {}", status.code(), install_command())
        } else {
            format!("本機分離失敗：{detail}")
        }));
    }

    let mut out = Vec::new();
    for (name, label) in expected_stems(&stems) {
        let p = stem_path(&dir, &src, name);
        let bytes = tokio::fs::metadata(&p).await.map(|m| m.len()).unwrap_or(0);
        if bytes == 0 {
            return Err(AppError::Agent(format!("分離完成但找不到 {label} 那一軌（{}）", p.display())));
        }
        out.push(SeparateStem {
            name: name.to_string(),
            label: label.to_string(),
            format: "wav".to_string(),
            path: p.to_string_lossy().to_string(),
            bytes,
        });
    }
    emit(&app, &job_id, "done", None, Some(100));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_stems_asks_demucs_to_merge_the_accompaniment() {
        // 兩軌交給 demucs 自己合（--two-stems），不要事後把三軌相加 —— 那樣會多一層量化誤差
        let a = demucs_args("in.wav", "out", "2");
        assert!(a.iter().any(|x| x == "--two-stems=vocals"), "{a:?}");
        let four = demucs_args("in.wav", "out", "4");
        assert!(!four.iter().any(|x| x == "--two-stems=vocals"), "{four:?}");
    }

    #[test]
    fn always_pins_the_model() {
        // 不釘模型的話 demucs 換預設就換聲音，而且輸出資料夾名字會跟著變 → 找不到檔案
        let a = demucs_args("in.wav", "out", "2");
        let i = a.iter().position(|x| x == "-n").expect("要指定模型");
        assert_eq!(a[i + 1], "htdemucs");
    }

    #[test]
    fn output_path_matches_what_demucs_writes() {
        let p = stem_path(Path::new("D:/out"), Path::new("D:/in/voice0612.m4a"), "no_vocals");
        let s = p.to_string_lossy().replace('\\', "/");
        assert_eq!(s, "D:/out/htdemucs/voice0612/no_vocals.wav");
    }

    #[test]
    fn expected_stems_by_mode() {
        assert_eq!(expected_stems("2").len(), 2);
        assert_eq!(expected_stems("4").len(), 4);
        assert_eq!(expected_stems("2")[1].0, "no_vocals");
    }

    #[test]
    fn reads_the_percentage_off_the_progress_bar() {
        assert_eq!(parse_progress(" 38%|###       | 38/100"), Some(38));
        assert_eq!(parse_progress("100%|##########|"), Some(100));
        assert_eq!(parse_progress("Selected model is a bag of 1 models"), None);
        assert_eq!(parse_progress("no percent here"), None);
        // 不是進度的百分比（例如 120%）不要當成進度
        assert_eq!(parse_progress("120%|"), None);
    }
}
