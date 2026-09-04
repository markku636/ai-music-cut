//! Tauri command 薄層：`AppState` + 設定 / ffmpeg / 媒體 / ttls 金鑰 / 專案 / 開啟路徑。
//! 媒體分析、轉寫、輸出、AI 助手各自在 `media.rs` / `transcribe.rs` / `render.rs` / `agent.rs`。
use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::error::{AppError, AppResult};
use crate::{ffmpeg, project, store, ttls};

pub struct AppState {
    pub http: reqwest::Client,
    /// 解析後的 ffmpeg / ffprobe 路徑快取；設定變更時清空重解析。
    pub ffmpeg: Arc<Mutex<Option<ffmpeg::FfmpegBins>>>,
    pub settings: Arc<RwLock<store::AppSettings>>,
    /// 媒體前處理（抽音 / 波形）背景任務（key = job_id）。
    pub media_jobs: Arc<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder()
                .user_agent(concat!("ai-music-cut/", env!("CARGO_PKG_VERSION")))
                .build()
                .expect("http client"),
            ffmpeg: Arc::new(Mutex::new(None)),
            settings: Arc::new(RwLock::new(store::AppSettings::default())),
            media_jobs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 取得（並快取）ffmpeg / ffprobe。
    pub async fn ffmpeg_bins(&self) -> AppResult<ffmpeg::FfmpegBins> {
        if let Some(b) = self.ffmpeg.lock().clone() {
            return Ok(b);
        }
        let custom = self.settings.read().ffmpeg_path.clone();
        let b = ffmpeg::resolve(custom.as_deref())
            .await
            .ok_or_else(|| AppError::Ffmpeg("找不到 ffmpeg / ffprobe，請安裝或在設定指定路徑".into()))?;
        *self.ffmpeg.lock() = Some(b.clone());
        Ok(b)
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

/// 前端骨架屏完成首次繪製後呼叫：顯示主視窗（配合 tauri.conf.json 的 visible:false 消除白屏）。
#[tauri::command]
pub fn show_main_window(window: tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
}

// ---------------- 設定 ----------------

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> store::AppSettings {
    state.settings.read().clone()
}

#[tauri::command]
pub async fn settings_set(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: store::AppSettings,
) -> AppResult<store::AppSettings> {
    store::write_json(&app, store::SETTINGS_FILE, &settings).await?;
    *state.settings.write() = settings.clone();
    *state.ffmpeg.lock() = None; // ffmpeg_path 可能變了 → 下次重解析
    Ok(settings)
}

#[derive(Serialize)]
pub struct AppPaths {
    pub config_dir: String,
    pub cache_dir: String,
}

#[tauri::command]
pub fn app_paths(app: AppHandle) -> AppResult<AppPaths> {
    Ok(AppPaths {
        config_dir: store::app_config_dir(&app)?.to_string_lossy().into_owned(),
        cache_dir: store::app_cache_dir(&app)?.to_string_lossy().into_owned(),
    })
}

// ---------------- ffmpeg / 媒體 ----------------

#[derive(Serialize)]
pub struct FfmpegStatus {
    pub found: bool,
    pub ffmpeg_path: Option<String>,
    pub ffprobe_path: Option<String>,
    pub version: Option<String>,
    pub source: Option<String>,
}

#[tauri::command]
pub async fn ffmpeg_detect(state: State<'_, AppState>, custom: Option<String>) -> AppResult<FfmpegStatus> {
    let custom = custom
        .filter(|s| !s.trim().is_empty())
        .or_else(|| state.settings.read().ffmpeg_path.clone());
    match ffmpeg::resolve(custom.as_deref()).await {
        Some(b) => {
            *state.ffmpeg.lock() = Some(b.clone());
            Ok(FfmpegStatus {
                found: true,
                ffmpeg_path: Some(b.ffmpeg),
                ffprobe_path: Some(b.ffprobe),
                version: Some(b.version),
                source: Some(b.source),
            })
        }
        None => Ok(FfmpegStatus { found: false, ffmpeg_path: None, ffprobe_path: None, version: None, source: None }),
    }
}

#[tauri::command]
pub async fn media_probe(state: State<'_, AppState>, path: String) -> AppResult<ffmpeg::MediaProbe> {
    let bins = state.ffmpeg_bins().await?;
    ffmpeg::probe(&bins, &path).await
}

#[tauri::command]
pub async fn media_fingerprint(path: String) -> AppResult<String> {
    tokio::task::spawn_blocking(move || ffmpeg::fingerprint(&path))
        .await
        .map_err(|e| AppError::Io(e.to_string()))?
}

// ---------------- ttls 健康 / 金鑰 ----------------

#[tauri::command]
pub async fn ttls_health(state: State<'_, AppState>) -> AppResult<ttls::TtlsHealth> {
    let base = state.settings.read().ttls_base_url.clone();
    Ok(ttls::health(&state.http, &base).await)
}

#[derive(Serialize)]
pub struct KeyStatus {
    pub present: bool,
    /// 末 4 碼提示（不是金鑰本身）。
    pub hint: Option<String>,
}

fn tail4(k: &str) -> String {
    let chars: Vec<char> = k.chars().collect();
    let n = chars.len().saturating_sub(4);
    chars[n..].iter().collect()
}

#[tauri::command]
pub fn ttls_key_status() -> KeyStatus {
    match ttls::api_key() {
        Some(k) => KeyStatus { present: true, hint: Some(tail4(&k)) },
        None => KeyStatus { present: false, hint: None },
    }
}

#[tauri::command]
pub fn ttls_key_set(key: String) -> AppResult<KeyStatus> {
    let k = key.trim();
    if k.is_empty() {
        return Err(AppError::Invalid("金鑰不可為空".into()));
    }
    store::kc_set(store::TTLS_KEY_ACCOUNT, k)?;
    Ok(KeyStatus { present: true, hint: Some(tail4(k)) })
}

#[tauri::command]
pub fn ttls_key_clear() -> KeyStatus {
    store::kc_delete(store::TTLS_KEY_ACCOUNT);
    KeyStatus { present: false, hint: None }
}

#[tauri::command]
pub async fn ttls_key_verify(state: State<'_, AppState>) -> AppResult<bool> {
    let base = state.settings.read().ttls_base_url.clone();
    ttls::verify_key(&state.http, &base).await
}

// ---------------- 專案 ----------------

#[tauri::command]
pub async fn project_save(path: String, doc: serde_json::Value) -> AppResult<()> {
    project::save(&path, &doc).await
}

#[tauri::command]
pub async fn project_load(path: String) -> AppResult<serde_json::Value> {
    project::load(&path).await
}

// ---------------- 開啟 ----------------

#[tauri::command]
pub fn open_path(path: String) -> AppResult<()> {
    let p = std::path::PathBuf::from(&path);
    if !p.exists() {
        return Err(AppError::NotFound(path));
    }
    crate::proc::reveal(&p);
    Ok(())
}

#[tauri::command]
pub fn open_external(url: String) -> AppResult<()> {
    let u = url.trim();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err(AppError::Invalid("僅允許開啟 http / https 連結".into()));
    }
    crate::proc::open_url(u);
    Ok(())
}
