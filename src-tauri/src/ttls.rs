//! ttls（Seal-TTS REST）client：健康檢查、金鑰驗證、逐字時間戳轉寫任務（202+輪詢）。
//!
//! API key 唯一讀取點是 `api_key()`，只在組 request 時用；沒有任何 command 會把它回傳前端，
//! 錯誤訊息也只帶 HTTP status + 伺服器 detail。
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio_util::io::ReaderStream;

use crate::error::{AppError, AppResult};
use crate::store;

/// keychain 優先；debug build 才退回 `.env.local` 的 `AICUT_TTLS_API_KEY`（開發便利，release 不讀）。
pub fn api_key() -> Option<String> {
    if let Some(k) = store::kc_get(store::TTLS_KEY_ACCOUNT).filter(|k| !k.trim().is_empty()) {
        return Some(k);
    }
    #[cfg(debug_assertions)]
    {
        if let Ok(k) = std::env::var("AICUT_TTLS_API_KEY") {
            if !k.trim().is_empty() {
                return Some(k.trim().to_string());
            }
        }
    }
    None
}

pub fn base_url(s: &str) -> String {
    s.trim().trim_end_matches('/').to_string()
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct TtlsHealth {
    pub ok: bool,
    pub status: Option<String>,
    pub queue_pending: Option<u64>,
    pub max_pending: Option<u64>,
    pub gpu_locked: Option<bool>,
    pub degraded: Option<bool>,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
}

/// GET /healthz（不需金鑰；伺服器端不碰 GPU）。任何失敗都回 ok=false + error，不 throw。
pub async fn health(http: &reqwest::Client, base: &str) -> TtlsHealth {
    let t0 = Instant::now();
    let url = format!("{}/healthz", base_url(base));
    match http.get(&url).timeout(Duration::from_secs(8)).send().await {
        Ok(r) => {
            let status = r.status();
            let latency = t0.elapsed().as_millis() as u64;
            match r.json::<serde_json::Value>().await {
                Ok(v) => TtlsHealth {
                    ok: status.is_success(),
                    status: v["status"].as_str().map(String::from),
                    queue_pending: v["queue_pending"].as_u64(),
                    max_pending: v["max_pending"].as_u64(),
                    gpu_locked: v["gpu_locked"].as_bool(),
                    degraded: v["degraded"].as_bool(),
                    latency_ms: Some(latency),
                    error: None,
                },
                Err(e) => TtlsHealth {
                    ok: false,
                    latency_ms: Some(latency),
                    error: Some(format!("HTTP {status}: {}", e.without_url())),
                    ..Default::default()
                },
            }
        }
        Err(e) => TtlsHealth {
            ok: false,
            error: Some(e.without_url().to_string()),
            ..Default::default()
        },
    }
}

/// 非 2xx → AppError（401/403 → Auth；其餘帶 status + detail）。
async fn err_from(r: reqwest::Response) -> AppError {
    let status = r.status().as_u16();
    if status == 401 || status == 403 {
        return AppError::Auth;
    }
    let text = r.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v["detail"].as_str().map(String::from))
        .unwrap_or_else(|| text.chars().take(300).collect());
    AppError::Ttls { status, detail }
}

fn authed(http: &reqwest::Client, method: reqwest::Method, url: String) -> AppResult<reqwest::RequestBuilder> {
    let key = api_key().ok_or(AppError::Auth)?;
    Ok(http.request(method, url).header("X-API-Key", key))
}

/// 用 GET /v1/engines 驗證金鑰：200 → true、401/403 → false、其他 → Err。
pub async fn verify_key(http: &reqwest::Client, base: &str) -> AppResult<bool> {
    let r = authed(http, reqwest::Method::GET, format!("{}/v1/engines", base_url(base)))?
        .timeout(Duration::from_secs(10))
        .send()
        .await?;
    match r.status().as_u16() {
        200 => Ok(true),
        401 | 403 => Ok(false),
        _ => Err(err_from(r).await),
    }
}

// ---------------- 逐字時間戳轉寫（POST /v1/transcribe/jobs → 輪詢 → /result） ----------------

pub struct TranscribeOpts {
    pub language: String,
    pub model: String,
    pub hotwords: String,
}

/// 串流上傳 opus，回 job_id。上傳逾時 180 s（30 分鐘 ≈ 11 MB）。
pub async fn transcribe_start(http: &reqwest::Client, base: &str, upload_path: &str, opts: &TranscribeOpts) -> AppResult<String> {
    let file = tokio::fs::File::open(upload_path).await?;
    let len = file.metadata().await?.len();
    let stream = ReaderStream::new(file);
    let part = reqwest::multipart::Part::stream_with_length(reqwest::Body::wrap_stream(stream), len)
        .file_name("upload.ogg")
        .mime_str("audio/ogg")?;
    let form = reqwest::multipart::Form::new()
        .part("audio", part)
        .text("language", opts.language.clone())
        .text("model", opts.model.clone())
        .text("hotwords", opts.hotwords.clone())
        .text("zh_convert", "s2twp");
    let r = authed(http, reqwest::Method::POST, format!("{}/v1/transcribe/jobs", base_url(base)))?
        .multipart(form)
        .timeout(Duration::from_secs(180))
        .send()
        .await?;
    if r.status().as_u16() != 202 {
        return Err(err_from(r).await);
    }
    let v: serde_json::Value = r.json().await?;
    v["job_id"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| AppError::Ttls { status: 202, detail: "回應缺少 job_id".into() })
}

/// GET /v1/transcribe/jobs/{id}：回 snapshot（status / progress / summary / error）。404 → NotFound（伺服器重啟，需重送）。
pub async fn transcribe_poll(http: &reqwest::Client, base: &str, job_id: &str) -> AppResult<serde_json::Value> {
    let r = authed(http, reqwest::Method::GET, format!("{}/v1/transcribe/jobs/{job_id}", base_url(base)))?
        .timeout(Duration::from_secs(30))
        .send()
        .await?;
    match r.status().as_u16() {
        200 => Ok(r.json().await?),
        404 => Err(AppError::NotFound(format!("轉寫任務 {job_id} 不存在（伺服器可能已重啟）"))),
        _ => Err(err_from(r).await),
    }
}

/// GET /v1/transcribe/jobs/{id}/result：完整逐字稿 JSON。
pub async fn transcribe_result(http: &reqwest::Client, base: &str, job_id: &str) -> AppResult<serde_json::Value> {
    let r = authed(http, reqwest::Method::GET, format!("{}/v1/transcribe/jobs/{job_id}/result", base_url(base)))?
        .timeout(Duration::from_secs(90))
        .send()
        .await?;
    if !r.status().is_success() {
        return Err(err_from(r).await);
    }
    Ok(r.json().await?)
}

pub async fn transcribe_cancel(http: &reqwest::Client, base: &str, job_id: &str) -> AppResult<()> {
    let r = authed(http, reqwest::Method::DELETE, format!("{}/v1/transcribe/jobs/{job_id}", base_url(base)))?
        .timeout(Duration::from_secs(15))
        .send()
        .await?;
    if r.status().is_success() || r.status().as_u16() == 404 {
        return Ok(());
    }
    Err(err_from(r).await)
}

// ---------------- 去人聲 / 分軌（POST /v1/separate，同步；各軌 base64 回傳） ----------------

#[derive(Debug, Clone, Serialize)]
pub struct SeparateStem {
    pub name: String,
    pub label: String,
    pub format: String,
    pub path: String,
    pub bytes: u64,
}

/// 上傳原檔給 demucs（htdemucs）分離，各軌寫到 `out_dir/{base}_{stem}.{fmt}`。
/// 同步端點沒有進度；逾時 20 分鐘。cancel 旗標為真時放棄等待（伺服器端仍會跑完）。
pub async fn separate(
    http: &reqwest::Client,
    base: &str,
    src_path: &str,
    stems: &str,
    target_format: &str,
    out_dir: &std::path::Path,
    base_name: &str,
    cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> AppResult<Vec<SeparateStem>> {
    use base64::Engine as _;
    let file = tokio::fs::File::open(src_path).await?;
    let len = file.metadata().await?.len();
    let file_name = std::path::Path::new(src_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("audio.bin")
        .to_string();
    let stream = ReaderStream::new(file);
    let part = reqwest::multipart::Part::stream_with_length(reqwest::Body::wrap_stream(stream), len)
        .file_name(file_name)
        .mime_str("application/octet-stream")?;
    let form = reqwest::multipart::Form::new()
        .part("audio", part)
        .text("stems", stems.to_string())
        .text("target_format", target_format.to_string())
        .text("device", "auto");
    let req = authed(http, reqwest::Method::POST, format!("{}/v1/separate", base_url(base)))?
        .multipart(form)
        .timeout(Duration::from_secs(1200))
        .send();
    let cancel_wait = async {
        loop {
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
        }
    };
    let r = tokio::select! {
        r = req => r?,
        _ = cancel_wait => return Err(AppError::Canceled),
    };
    if !r.status().is_success() {
        return Err(err_from(r).await);
    }
    let v: serde_json::Value = r.json().await?;
    let items = v["stems"].as_array().cloned().unwrap_or_default();
    if items.is_empty() {
        return Err(AppError::Ttls { status: 200, detail: "伺服器沒有回傳任何分軌".into() });
    }
    tokio::fs::create_dir_all(out_dir).await?;
    let mut out = Vec::with_capacity(items.len());
    for it in items {
        let name = it["name"].as_str().unwrap_or("stem").to_string();
        let label = it["label"].as_str().unwrap_or(&name).to_string();
        let format = it["format"].as_str().unwrap_or("wav").to_string();
        let b64 = it["audio_b64"].as_str().unwrap_or("");
        let data = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| AppError::Ttls { status: 200, detail: format!("分軌 {name} 資料解碼失敗：{e}") })?;
        let path = out_dir.join(format!("{base_name}_{name}.{format}"));
        tokio::fs::write(&path, &data).await?;
        out.push(SeparateStem { name, label, format, path: path.to_string_lossy().to_string(), bytes: data.len() as u64 });
    }
    Ok(out)
}

// ---------------- ACE-Step 音樂生成（POST /v1/music → 輪詢 → 下載候選） ----------------

/// 送單參數（前端傳來；欄位對齊伺服器 MusicRequest）。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct MusicOpts {
    pub prompt: String,
    pub duration_sec: f64,
    /// 0 = 不指定
    pub bpm: i64,
    /// fast | fine | max（空字串 = 伺服器預設）
    pub quality: String,
    pub n_candidates: i64,
    /// mp3 | wav | flac | m4a…
    pub format: String,
    /// -1 = 隨機
    pub seed: i64,
}

/// POST /v1/music：回 job_id（202）。生成是非同步的，之後用 music_poll 輪詢。
pub async fn music_start(http: &reqwest::Client, base: &str, opts: &MusicOpts) -> AppResult<String> {
    let mut body = serde_json::json!({
        "prompt": opts.prompt,
        "duration_sec": opts.duration_sec,
        "n_candidates": opts.n_candidates.clamp(1, 4),
        "format": opts.format,
        "seed": opts.seed,
    });
    if opts.bpm > 0 {
        body["bpm"] = serde_json::json!(opts.bpm);
    }
    if !opts.quality.trim().is_empty() {
        body["quality"] = serde_json::json!(opts.quality);
    }
    let r = authed(http, reqwest::Method::POST, format!("{}/v1/music", base_url(base)))?
        .json(&body)
        .timeout(Duration::from_secs(60))
        .send()
        .await?;
    if r.status().as_u16() != 202 {
        return Err(err_from(r).await);
    }
    let v: serde_json::Value = r.json().await?;
    v["job_id"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| AppError::Ttls { status: 202, detail: "回應缺少 job_id".into() })
}

/// GET /v1/music/jobs/{id}：狀態快照（status / outputs / seed / running_sec）。
pub async fn music_poll(http: &reqwest::Client, base: &str, job_id: &str) -> AppResult<serde_json::Value> {
    let r = authed(http, reqwest::Method::GET, format!("{}/v1/music/jobs/{job_id}", base_url(base)))?
        .timeout(Duration::from_secs(30))
        .send()
        .await?;
    if !r.status().is_success() {
        return Err(err_from(r).await);
    }
    Ok(r.json().await?)
}

/// GET /v1/music/jobs/{id}/audio?i=N → 寫成檔案，回實際路徑。
pub async fn music_fetch(
    http: &reqwest::Client,
    base: &str,
    job_id: &str,
    index: i64,
    out_dir: &std::path::Path,
    file_stem: &str,
    ext: &str,
) -> AppResult<String> {
    let r = authed(http, reqwest::Method::GET, format!("{}/v1/music/jobs/{job_id}/audio?i={index}", base_url(base)))?
        .timeout(Duration::from_secs(300))
        .send()
        .await?;
    if !r.status().is_success() {
        return Err(err_from(r).await);
    }
    let bytes = r.bytes().await?;
    tokio::fs::create_dir_all(out_dir).await?;
    let path = out_dir.join(format!("{file_stem}.{ext}"));
    tokio::fs::write(&path, &bytes).await?;
    Ok(path.to_string_lossy().to_string())
}

/// DELETE /v1/music/jobs/{id}：取消（排隊中立即、生成中 best-effort）。
pub async fn music_cancel(http: &reqwest::Client, base: &str, job_id: &str) -> AppResult<()> {
    let r = authed(http, reqwest::Method::DELETE, format!("{}/v1/music/jobs/{job_id}", base_url(base)))?
        .timeout(Duration::from_secs(20))
        .send()
        .await?;
    if r.status().is_success() || r.status().as_u16() == 404 {
        return Ok(());
    }
    Err(err_from(r).await)
}

/// 曲風轉換送單參數（POST /v1/music/style，audio2audio）。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct MusicStyleOpts {
    pub prompt: String,
    /// 參考音檔（通常是編輯器裡選取那段切出來的 wav）
    pub audio_path: String,
    /// 0–1：越高越貼近參考的旋律 / 結構
    pub cover_strength: f64,
    /// 0 = 跟隨參考長度
    pub duration_sec: f64,
    pub n_candidates: i64,
    pub format: String,
    pub seed: i64,
}

/// POST /v1/music/style：上傳參考音檔 + 目標風格，回 job_id（與 /v1/music 共用任務列表）。
pub async fn music_style_start(http: &reqwest::Client, base: &str, opts: &MusicStyleOpts) -> AppResult<String> {
    let file = tokio::fs::File::open(&opts.audio_path).await?;
    let len = file.metadata().await?.len();
    let name = std::path::Path::new(&opts.audio_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("source.wav")
        .to_string();
    let stream = ReaderStream::new(file);
    let part = reqwest::multipart::Part::stream_with_length(reqwest::Body::wrap_stream(stream), len)
        .file_name(name)
        .mime_str("audio/wav")?;
    let form = reqwest::multipart::Form::new()
        .part("audio", part)
        .text("prompt", opts.prompt.clone())
        .text("cover_strength", opts.cover_strength.clamp(0.0, 1.0).to_string())
        .text("duration_sec", opts.duration_sec.max(0.0).to_string())
        .text("n_candidates", opts.n_candidates.clamp(1, 4).to_string())
        .text("target_format", opts.format.clone())
        .text("seed", opts.seed.to_string());
    let r = authed(http, reqwest::Method::POST, format!("{}/v1/music/style", base_url(base)))?
        .multipart(form)
        .timeout(Duration::from_secs(300))
        .send()
        .await?;
    if r.status().as_u16() != 202 {
        return Err(err_from(r).await);
    }
    let v: serde_json::Value = r.json().await?;
    v["job_id"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| AppError::Ttls { status: 202, detail: "回應缺少 job_id".into() })
}
