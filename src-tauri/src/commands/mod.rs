//! Tauri command 薄層：`AppState` + 設定 / ffmpeg / 媒體 / ttls / 專案 / 開啟路徑。
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::error::{AppError, AppResult};
use crate::{ffmpeg, media, project, store, ttls};

pub struct AppState {
    pub http: reqwest::Client,
    /// 解析後的 ffmpeg / ffprobe 路徑快取；設定變更時清空重解析。
    pub ffmpeg: Arc<Mutex<Option<ffmpeg::FfmpegBins>>>,
    pub settings: Arc<RwLock<store::AppSettings>>,
    /// 可取消工作的旗標（key = job_id）：分析 / 輸出等長跑 ffmpeg 迴圈定期檢查。
    pub cancel_flags: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    /// AI 助手進行中的問答背景任務（key = req_id）。取消時 abort 即終止 claude 子程序。
    pub agent_jobs: Arc<Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>>,
    /// 內建 MCP server 橋接（port / token / 工具目錄 / 等待中的工具呼叫）。
    pub mcp: Arc<crate::mcp::McpBridge>,
    /// 安裝檔內建的 ffmpeg 目錄（setup 時從 resource_dir 算出；dev / 未內建時為 None）。
    pub bundled_ffmpeg: Arc<RwLock<Option<std::path::PathBuf>>>,
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
            cancel_flags: Arc::new(Mutex::new(HashMap::new())),
            agent_jobs: Arc::new(Mutex::new(HashMap::new())),
            mcp: Arc::new(crate::mcp::McpBridge::new()),
            bundled_ffmpeg: Arc::new(RwLock::new(None)),
        }
    }

    /// 取得（並快取）ffmpeg / ffprobe。
    pub async fn ffmpeg_bins(&self) -> AppResult<ffmpeg::FfmpegBins> {
        if let Some(b) = self.ffmpeg.lock().clone() {
            return Ok(b);
        }
        let custom = self.settings.read().ffmpeg_path.clone();
        let bundled = self.bundled_ffmpeg.read().clone();
        let b = ffmpeg::resolve(custom.as_deref(), bundled.as_deref())
            .await
            .ok_or_else(|| AppError::Ffmpeg("找不到 ffmpeg / ffprobe，請安裝或在設定指定路徑".into()))?;
        *self.ffmpeg.lock() = Some(b.clone());
        Ok(b)
    }

    pub fn cancel_flag(&self, job_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.cancel_flags.lock().insert(job_id.to_string(), flag.clone());
        flag
    }

    pub fn clear_flag(&self, job_id: &str) {
        self.cancel_flags.lock().remove(job_id);
    }

    fn base_url(&self) -> String {
        self.settings.read().ttls_base_url.clone()
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

/// 前端錯誤 / 除錯訊息 → stderr（tauri dev 終端可見）。
#[tauri::command]
pub fn client_log(msg: String) {
    eprintln!("[client] {msg}");
}

/// dev 煙霧測試用：只在 debug build 回環境變數（AICUT_DEV_OPEN / AICUT_DEV_ANALYZE）；release 一律 None。
#[tauri::command]
pub fn dev_env(name: String) -> Option<String> {
    if cfg!(debug_assertions) {
        std::env::var(name).ok().filter(|v| !v.trim().is_empty())
    } else {
        None
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
    let bundled = state.bundled_ffmpeg.read().clone();
    match ffmpeg::resolve(custom.as_deref(), bundled.as_deref()).await {
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

#[tauri::command]
pub fn media_cache_status(app: AppHandle, fingerprint: String) -> AppResult<media::CacheStatus> {
    Ok(media::cache_status(&media::media_dir(&app, &fingerprint)?))
}

#[derive(Serialize)]
pub struct PrepareResult {
    pub upload_path: String,
    pub cached: bool,
}

#[tauri::command]
pub async fn media_prepare(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    fingerprint: String,
) -> AppResult<PrepareResult> {
    let bins = state.ffmpeg_bins().await?;
    let dir = media::media_dir(&app, &fingerprint)?;
    let (p, cached) = media::prepare_upload(&bins, &path, &dir).await?;
    Ok(PrepareResult { upload_path: p.to_string_lossy().into_owned(), cached })
}

/// 回二進位（ArrayBuffer）：格式見 media.rs `Analyzer::finish`。
#[tauri::command]
pub async fn media_analyze_local(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
    path: String,
    fingerprint: String,
    duration_ms: u64,
) -> AppResult<tauri::ipc::Response> {
    let bins = state.ffmpeg_bins().await?;
    let dir = media::media_dir(&app, &fingerprint)?;
    let flag = state.cancel_flag(&job_id);
    let r = media::analyze_local(&app, &bins, &path, &dir, &job_id, duration_ms, flag).await;
    state.clear_flag(&job_id);
    Ok(tauri::ipc::Response::new(r?))
}

#[tauri::command]
pub fn media_cancel(state: State<'_, AppState>, job_id: String) {
    if let Some(f) = state.cancel_flags.lock().get(&job_id) {
        f.store(true, Ordering::Relaxed);
    }
}

#[tauri::command]
pub async fn media_cache_write_transcript(app: AppHandle, fingerprint: String, doc: serde_json::Value) -> AppResult<()> {
    let dir = media::media_dir(&app, &fingerprint)?;
    store::write_json_in(&dir, media::TRANSCRIPT_FILE, &doc).await
}

#[tauri::command]
pub async fn media_cache_read_transcript(app: AppHandle, fingerprint: String) -> AppResult<Option<serde_json::Value>> {
    let dir = media::media_dir(&app, &fingerprint)?;
    let p = dir.join(media::TRANSCRIPT_FILE);
    match tokio::fs::read(&p).await {
        Ok(b) => Ok(serde_json::from_slice(&b).ok()),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
pub async fn media_cache_clear(app: AppHandle, fingerprint: Option<String>) -> AppResult<()> {
    let root = store::app_cache_dir(&app)?.join("media");
    let target = match fingerprint {
        Some(fp) => media::media_dir(&app, &fp)?,
        None => root,
    };
    if target.exists() {
        tokio::fs::remove_dir_all(&target).await?;
    }
    Ok(())
}

// ---------------- ttls 健康 / 金鑰 ----------------

#[tauri::command]
pub async fn ttls_health(state: State<'_, AppState>) -> AppResult<ttls::TtlsHealth> {
    let base = state.base_url();
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
    let base = state.base_url();
    ttls::verify_key(&state.http, &base).await
}

// ---------------- ttls 轉寫任務 ----------------

#[tauri::command]
pub async fn ttls_transcribe_start(
    state: State<'_, AppState>,
    upload_path: String,
    language: String,
    model: String,
    hotwords: String,
) -> AppResult<String> {
    let base = state.base_url();
    let opts = ttls::TranscribeOpts { language, model, hotwords };
    ttls::transcribe_start(&state.http, &base, &upload_path, &opts).await
}

#[tauri::command]
pub async fn ttls_transcribe_poll(state: State<'_, AppState>, job_id: String) -> AppResult<serde_json::Value> {
    let base = state.base_url();
    ttls::transcribe_poll(&state.http, &base, &job_id).await
}

#[tauri::command]
pub async fn ttls_transcribe_result(state: State<'_, AppState>, job_id: String) -> AppResult<serde_json::Value> {
    let base = state.base_url();
    ttls::transcribe_result(&state.http, &base, &job_id).await
}

#[tauri::command]
pub async fn ttls_transcribe_cancel(state: State<'_, AppState>, job_id: String) -> AppResult<()> {
    let base = state.base_url();
    ttls::transcribe_cancel(&state.http, &base, &job_id).await
}

#[tauri::command]
pub async fn ttls_separate(
    state: State<'_, AppState>,
    job_id: String,
    path: String,
    stems: String,
    target_format: String,
    out_dir: Option<String>,
) -> AppResult<Vec<ttls::SeparateStem>> {
    let base = state.base_url();
    let src = std::path::Path::new(&path);
    let dir = match out_dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(d) => std::path::PathBuf::from(d),
        None => src.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| std::path::PathBuf::from(".")),
    };
    let base_name = src.file_stem().and_then(|s| s.to_str()).unwrap_or("audio").to_string();
    let flag = state.cancel_flag(&job_id);
    let r = ttls::separate(&state.http, &base, &path, &stems, &target_format, &dir, &base_name, flag).await;
    state.cancel_flags.lock().remove(&job_id);
    r
}

/// 把選取的一段切成 wav（放媒體快取目錄），給曲風轉換上傳用。
#[tauri::command]
pub async fn media_clip(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    fingerprint: String,
    start_ms: f64,
    end_ms: f64,
) -> AppResult<String> {
    let bins = state.ffmpeg_bins().await?;
    let dir = media::media_dir(&app, &fingerprint)?;
    let out = dir.join(format!("clip-{}-{}.wav", start_ms.round() as i64, end_ms.round() as i64));
    media::clip_wav(&bins, &path, start_ms, end_ms, &out).await?;
    Ok(out.to_string_lossy().into_owned())
}

/// 顯存不夠時請伺服器釋放（停音樂服務 / 清快取）。
#[tauri::command]
pub async fn ttls_gpu_release(state: State<'_, AppState>, music_action: Option<String>) -> AppResult<ttls::GpuRelease> {
    let base = state.base_url();
    ttls::gpu_release(&state.http, &base, music_action.as_deref().unwrap_or("stop")).await
}

// ---------------- ACE-Step 音樂生成 ----------------

#[tauri::command]
pub async fn ttls_music_start(state: State<'_, AppState>, opts: ttls::MusicOpts) -> AppResult<String> {
    let base = state.base_url();
    ttls::music_start(&state.http, &base, &opts).await
}

#[tauri::command]
pub async fn ttls_music_style_start(state: State<'_, AppState>, opts: ttls::MusicStyleOpts) -> AppResult<String> {
    let base = state.base_url();
    ttls::music_style_start(&state.http, &base, &opts).await
}

#[tauri::command]
pub async fn ttls_music_poll(state: State<'_, AppState>, job_id: String) -> AppResult<serde_json::Value> {
    let base = state.base_url();
    ttls::music_poll(&state.http, &base, &job_id).await
}

#[tauri::command]
pub async fn ttls_music_fetch(
    state: State<'_, AppState>,
    job_id: String,
    index: i64,
    out_dir: String,
    file_stem: String,
    ext: String,
) -> AppResult<String> {
    let base = state.base_url();
    ttls::music_fetch(&state.http, &base, &job_id, index, std::path::Path::new(&out_dir), &file_stem, &ext).await
}

#[tauri::command]
pub async fn ttls_music_cancel(state: State<'_, AppState>, job_id: String) -> AppResult<()> {
    let base = state.base_url();
    ttls::music_cancel(&state.http, &base, &job_id).await
}

// ---------------- 輸出 ----------------

#[tauri::command]
pub async fn render_start(app: AppHandle, state: State<'_, AppState>, job_id: String, src: String, plan: crate::render::RenderPlan) -> AppResult<()> {
    let bins = state.ffmpeg_bins().await?;
    let work_dir = store::app_cache_dir(&app)?.join("render");
    tokio::fs::create_dir_all(&work_dir).await?;
    let flag = state.cancel_flag(&job_id);
    let flags = state.cancel_flags.clone();
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let done = crate::render::run(app2.clone(), bins, src, plan, work_dir, job_id.clone(), flag).await;
        flags.lock().remove(&job_id);
        let _ = app2.emit("render-done", done);
    });
    Ok(())
}

#[tauri::command]
pub fn render_cancel(state: State<'_, AppState>, job_id: String) {
    if let Some(f) = state.cancel_flags.lock().get(&job_id) {
        f.store(true, Ordering::Relaxed);
    }
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
