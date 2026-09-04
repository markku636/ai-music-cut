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
