//! 本機語音辨識（faster-whisper）：不想／不能連 ttls 伺服器時的替代路徑。
//!
//! 為什麼要有這條路：整個「分析」流程唯一的硬依賴就是那台轉寫伺服器。
//! 沒有它，這個 App 只剩波形與手動剪輯 —— 候選、逐字稿、節目筆記、驗收全部做不了。
//! faster-whisper 在本機就跑得動同一個 large-v3 模型，輸出也有字級時間戳與
//! no_speech / avg_logprob / compression_ratio，剛好是規則層需要的那幾個訊號。
//!
//! **Python 腳本是執行期寫到設定目錄的**，不打包成資源：
//! 這樣腳本永遠跟著這個執行檔的版本走，不會出現「App 更新了但殘留舊腳本」的情況，
//! 也少一份要維護的打包清單。
//!
//! **這個檔案的實機轉寫沒有驗證過** —— 開發機上沒有安裝 faster-whisper
//! （它會帶進 ctranslate2 與約 1 GB 的模型），不會替使用者自動安裝。
//! 偵測、指令組法、輸出格式轉換都有測試，但沒有真的跑過一次轉寫。

use std::path::PathBuf;
use std::process::Stdio;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::error::{AppError, AppResult};
use crate::proc;

/// 寫到設定目錄的 sidecar。輸出**刻意做成與 ttls `/v1/transcribe` 同一個形狀**，
/// 這樣前端 `normalizeTranscript` 一行都不用改。
const SIDECAR: &str = r#"# -*- coding: utf-8 -*-
# 由 AI Music Cut 在執行期寫出；請勿手動編輯（每次啟動都會覆寫）。
# 輸出格式與 ttls /v1/transcribe 相同，前端才不必分兩套解析。
import json, sys

def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()

def main():
    audio, model_name, language, out_path = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
    try:
        from faster_whisper import WhisperModel
    except Exception as e:
        emit({"event": "error", "message": "faster-whisper 未安裝：%s" % e})
        return 2

    emit({"event": "status", "message": "載入模型 %s" % model_name})
    # int8 讓沒有 GPU 的機器也跑得動；有 CUDA 時 faster-whisper 會自己用
    try:
        model = WhisperModel(model_name, device="auto", compute_type="int8")
    except Exception as e:
        emit({"event": "error", "message": "模型載入失敗：%s" % e})
        return 3

    emit({"event": "status", "message": "轉寫中"})
    lang = None if not language or language in ("auto", "") else language
    segments, info = model.transcribe(
        audio, language=lang, word_timestamps=True, vad_filter=True,
        condition_on_previous_text=False,
    )
    total = float(getattr(info, "duration", 0.0) or 0.0)

    out_segments = []
    for i, s in enumerate(segments):
        words = []
        for w in (s.words or []):
            words.append({
                "start": float(w.start), "end": float(w.end),
                "word": w.word, "probability": float(getattr(w, "probability", 0.0) or 0.0),
            })
        out_segments.append({
            "id": i,
            "start": float(s.start), "end": float(s.end), "text": s.text,
            "avg_logprob": float(getattr(s, "avg_logprob", 0.0) or 0.0),
            "no_speech_prob": float(getattr(s, "no_speech_prob", 0.0) or 0.0),
            "compression_ratio": float(getattr(s, "compression_ratio", 0.0) or 0.0),
            "words": words,
        })
        if total > 0:
            emit({"event": "progress", "pct": min(99, int(float(s.end) / total * 100))})

    doc = {
        "model": model_name,
        "language": getattr(info, "language", None) or lang or "",
        "duration_sec": total,
        "segments": out_segments,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False)
    emit({"event": "done", "segments": len(out_segments)})
    return 0

if __name__ == "__main__":
    sys.exit(main())
"#;

#[derive(Serialize, Clone, Default)]
pub struct LocalAsrStatus {
    /// 找得到 python。
    pub python: bool,
    pub python_version: Option<String>,
    /// python 裡 import 得到 faster_whisper。
    pub faster_whisper: bool,
    /// 給使用者照著做的安裝指令。
    pub install_hint: String,
}

#[derive(Serialize, Clone)]
struct AsrEvent {
    job_id: String,
    event: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pct: Option<u8>,
}

/// pip 安裝指令。CPU 也跑得動，所以預設不提 CUDA —— 先讓人跑起來比較重要。
pub fn install_command() -> String {
    "pip install faster-whisper".to_string()
}

async fn python_bin() -> Option<String> {
    if let Ok(p) = std::env::var("AICUT_PYTHON") {
        if !p.trim().is_empty() {
            return Some(p);
        }
    }
    for name in ["python", "python3", "py"] {
        let found = proc::which(name).await;
        if let Some(first) = found.into_iter().next() {
            return Some(first);
        }
    }
    None
}

pub async fn detect() -> LocalAsrStatus {
    let hint = install_command();
    let Some(py) = python_bin().await else {
        return LocalAsrStatus { python: false, python_version: None, faster_whisper: false, install_hint: hint };
    };
    let mut version = None;
    let mut c = proc::cmd(&py);
    c.arg("--version").stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    if let Ok(Ok(o)) = tokio::time::timeout(std::time::Duration::from_secs(10), c.output()).await {
        let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
        let e = String::from_utf8_lossy(&o.stderr).trim().to_string();
        version = Some(if s.is_empty() { e } else { s }).filter(|x| !x.is_empty());
    }
    // 用 importlib 探測，**不要真的 import** —— import faster_whisper 會把 ctranslate2
    // 一起載進來，在沒有 GPU 的機器上要好幾秒，只是為了畫一個勾不值得。
    let mut c2 = proc::cmd(&py);
    c2.arg("-c")
        .arg("import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('faster_whisper') else 1)")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let has = matches!(tokio::time::timeout(std::time::Duration::from_secs(20), c2.status()).await, Ok(Ok(st)) if st.success());
    LocalAsrStatus { python: true, python_version: version, faster_whisper: has, install_hint: hint }
}

async fn write_sidecar(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = crate::store::app_config_dir(app)?;
    tokio::fs::create_dir_all(&dir).await.map_err(|e| AppError::Storage(format!("建立設定目錄失敗：{e}")))?;
    let p = dir.join("local_asr.py");
    tokio::fs::write(&p, SIDECAR.as_bytes()).await.map_err(|e| AppError::Io(format!("寫入本機辨識腳本失敗：{e}")))?;
    Ok(p)
}

/// 安裝套件那一步要跑的參數。**用 `python -m pip` 而不是 `pip`**：
/// 機器上常常有好幾個 python，`pip` 指到的不一定是我們偵測到的那一個 ——
/// 裝完之後 import 不到才是最難查的失敗。
pub fn install_args() -> Vec<String> {
    // --progress-bar off：pip 的進度條是 \r 覆寫的，逐行讀會變成一堆亂碼
    [
        "-m", "pip", "install", "-U", "--progress-bar", "off",
        "--disable-pip-version-check", "faster-whisper",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

/// 使用者可以挑的模型。名字直接餵給 faster-whisper，大小是給人判斷用的估計值。
pub const MODELS: &[(&str, &str)] = &[
    ("small", "~0.5 GB"),
    ("medium", "~1.5 GB"),
    ("large-v3-turbo", "~1.6 GB"),
    ("large-v3", "~3 GB"),
];

pub fn is_known_model(name: &str) -> bool {
    MODELS.iter().any(|(m, _)| *m == name)
}

/// 先下載模型的那一步。用 faster-whisper 自己的 `download_model`，
/// **不要**用 `WhisperModel(...)` 觸發下載 —— 那會順便把 ctranslate2 載進來初始化，
/// 在沒有 GPU 的機器上多花好幾十秒，而我們這一步只想要把檔案抓下來。
pub fn model_download_script(model: &str) -> String {
    format!(
        "import sys\n\
         try:\n\
         \x20   from faster_whisper.utils import download_model\n\
         except Exception as e:\n\
         \x20   print('找不到 faster_whisper：%s' % e); sys.exit(3)\n\
         print('開始下載模型 {m}（第一次會比較久）')\n\
         p = download_model('{m}')\n\
         print('模型已就緒：%s' % p)\n"
    , m = model)
}

#[derive(Serialize, Clone)]
struct InstallEvent {
    job_id: String,
    /// "step" | "line" | "done"
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    step: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    line: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ok: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<i32>,
}

fn emit(app: &AppHandle, job_id: &str, kind: &str, step: Option<&str>, line: Option<String>, ok: Option<bool>, code: Option<i32>) {
    let _ = app.emit(
        "local-asr-install",
        InstallEvent {
            job_id: job_id.to_string(),
            kind: kind.to_string(),
            step: step.map(|s| s.to_string()),
            line,
            ok,
            code,
        },
    );
}

/// 跑一個子行程，把 stdout / stderr 逐行送到前端；回傳結束碼。
async fn run_streaming(app: &AppHandle, job_id: &str, step: &str, py: &str, args: &[String]) -> AppResult<Option<i32>> {
    emit(app, job_id, "step", Some(step), None, None, None);
    let mut cmd = proc::cmd(py);
    for a in args {
        cmd.arg(a);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| AppError::Agent(format!("啟動 python 失敗：{e}")))?;

    let mut tasks = Vec::new();
    // stdout 與 stderr 都要收：pip 把警告與錯誤寫在 stderr，只讀 stdout 會漏掉失敗原因
    if let Some(out) = child.stdout.take() {
        let (a, j) = (app.clone(), job_id.to_string());
        tasks.push(tokio::spawn(async move {
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                emit(&a, &j, "line", None, Some(l), None, None);
            }
        }));
    }
    if let Some(err) = child.stderr.take() {
        let (a, j) = (app.clone(), job_id.to_string());
        tasks.push(tokio::spawn(async move {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                emit(&a, &j, "line", None, Some(l), None, None);
            }
        }));
    }
    let status = child.wait().await.map_err(|e| AppError::Agent(format!("執行失敗：{e}")))?;
    for t in tasks {
        let _ = t.await;
    }
    Ok(status.code())
}

/// 依使用者在設定裡勾的項目安裝。**選什麼是 UI 決定的，這裡只負責執行** ——
/// 把「要裝什麼」寫死在 Rust 裡的話，換一個模型就得重新發一版。
///
/// - `package`：裝 / 更新 faster-whisper 套件（會帶進 ctranslate2、tokenizers 等，幾百 MB）
/// - `model`：順便把模型抓下來。不指定的話，第一次分析時才下載 ——
///   那時候使用者正等著看結果，卻卡在一個沒有進度的下載上。
pub async fn install(app: AppHandle, job_id: String, package: bool, model: Option<String>) -> AppResult<bool> {
    let py = python_bin().await.ok_or_else(|| AppError::Agent("找不到 python，無法安裝".into()))?;
    let mut ok = true;

    if package {
        let code = run_streaming(&app, &job_id, "package", &py, &install_args()).await?;
        if code != Some(0) {
            emit(&app, &job_id, "done", None, None, Some(false), code);
            return Ok(false);
        }
    }

    if let Some(m) = model.as_deref().filter(|m| !m.trim().is_empty()) {
        if !is_known_model(m) {
            return Err(AppError::Agent(format!("不認得的模型：{m}")));
        }
        let args = vec!["-c".to_string(), model_download_script(m)];
        let code = run_streaming(&app, &job_id, "model", &py, &args).await?;
        ok = code == Some(0);
        if !ok {
            emit(&app, &job_id, "done", None, None, Some(false), code);
            return Ok(false);
        }
    }

    emit(&app, &job_id, "done", None, None, Some(ok), Some(0));
    Ok(ok)
}

/// 跑一次本機轉寫。事件走 `local-asr` （與 ttls 那條路的進度分開，前端各自處理）。
pub async fn transcribe(app: AppHandle, job_id: String, audio_path: String, model: String, language: String) -> AppResult<serde_json::Value> {
    let py = python_bin().await.ok_or_else(|| AppError::Agent("找不到 python，無法用本機辨識".into()))?;
    let script = write_sidecar(&app).await?;
    let out = std::env::temp_dir().join(format!("aicut-asr-{}.json", uuid::Uuid::new_v4()));

    let mut cmd = proc::cmd(&py);
    cmd.arg(&script)
        .arg(&audio_path)
        .arg(if model.trim().is_empty() { "large-v3" } else { model.trim() })
        .arg(&language)
        .arg(&out)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| AppError::Agent(format!("啟動 python 失敗：{e}")))?;

    if let Some(stdout) = child.stdout.take() {
        let app2 = app.clone();
        let jid = job_id.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                let ev = v.get("event").and_then(|x| x.as_str()).unwrap_or("").to_string();
                let _ = app2.emit(
                    "local-asr",
                    AsrEvent {
                        job_id: jid.clone(),
                        event: ev,
                        message: v.get("message").and_then(|x| x.as_str()).map(|s| s.to_string()),
                        pct: v.get("pct").and_then(|x| x.as_u64()).map(|n| n.min(100) as u8),
                    },
                );
            }
        });
    }

    let status = child.wait().await.map_err(|e| AppError::Agent(format!("本機辨識失敗：{e}")))?;
    if !status.success() {
        let _ = tokio::fs::remove_file(&out).await;
        return Err(AppError::Agent(format!("本機辨識以結束碼 {:?} 退出（{}）", status.code(), install_command())));
    }
    let text = tokio::fs::read_to_string(&out).await.map_err(|e| AppError::Io(format!("讀不到本機辨識結果：{e}")))?;
    let _ = tokio::fs::remove_file(&out).await;
    serde_json::from_str(&text).map_err(|e| AppError::Agent(format!("本機辨識輸出不是合法 JSON：{e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_emits_the_same_shape_as_ttls() {
        // 前端的 normalizeTranscript 只認這幾個欄位；少一個規則層就會失去一種訊號
        for key in ["\"id\":", "\"start\":", "\"end\":", "\"text\":", "\"avg_logprob\":", "\"no_speech_prob\":", "\"compression_ratio\":", "\"words\":"] {
            assert!(SIDECAR.contains(key), "sidecar 少了欄位 {key}");
        }
        for key in ["\"probability\":", "\"duration_sec\":", "\"language\":", "\"model\":"] {
            assert!(SIDECAR.contains(key), "sidecar 少了欄位 {key}");
        }
    }

    #[test]
    fn sidecar_asks_for_word_timestamps() {
        // 沒有字級時間戳，贅字 / 口吃那些規則整個做不了
        assert!(SIDECAR.contains("word_timestamps=True"));
    }

    #[test]
    fn sidecar_reports_missing_package_instead_of_crashing() {
        // 沒安裝時要回一個看得懂的訊息，不是 traceback
        assert!(SIDECAR.contains("faster-whisper 未安裝"));
    }

    #[test]
    fn install_uses_python_dash_m_pip() {
        // 裸 `pip` 可能指到另一個 python —— 裝完 import 不到是最難查的失敗
        let a = install_args();
        assert_eq!(a[0], "-m");
        assert_eq!(a[1], "pip");
        assert!(a.contains(&"faster-whisper".to_string()));
    }

    #[test]
    fn install_turns_off_the_progress_bar() {
        // pip 的進度條是 \r 覆寫的，逐行讀會變成亂碼
        let a = install_args();
        let i = a.iter().position(|x| x == "--progress-bar").expect("要有 --progress-bar");
        assert_eq!(a[i + 1], "off");
    }

    #[test]
    fn model_list_is_ordered_small_to_large() {
        // 畫面上要讓人一眼看出「越下面越大越準」
        let names: Vec<&str> = MODELS.iter().map(|(m, _)| *m).collect();
        assert_eq!(names, vec!["small", "medium", "large-v3-turbo", "large-v3"]);
        assert!(MODELS.iter().all(|(_, size)| size.contains("GB")));
    }

    #[test]
    fn only_known_models_are_accepted() {
        assert!(is_known_model("large-v3"));
        assert!(!is_known_model("large-v3; rm -rf /"));
        assert!(!is_known_model(""));
    }

    #[test]
    fn download_script_uses_download_model_not_whispermodel() {
        // WhisperModel(...) 會順便把 ctranslate2 載進來初始化，這一步只想抓檔案
        let sc = model_download_script("large-v3");
        assert!(sc.contains("download_model"));
        assert!(!sc.contains("WhisperModel"));
        assert!(sc.contains("large-v3"));
    }

    #[test]
    fn download_script_reports_a_missing_package_instead_of_a_traceback() {
        assert!(model_download_script("small").contains("\u{627e}\u{4e0d}\u{5230} faster_whisper"));
    }

    #[test]
    fn install_hint_matches_what_we_actually_run() {
        // 畫面上給人看的那一行，跟真的跑的東西不能不一樣
        let hint = install_command();
        for token in ["pip", "install", "faster-whisper"] {
            assert!(hint.contains(token), "install_hint 少了 {token}");
        }
    }

    #[test]
    fn install_hint_is_actionable() {
        let c = install_command();
        assert!(c.starts_with("pip install"));
        assert!(c.contains("faster-whisper"));
    }
}
