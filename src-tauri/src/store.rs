//! App 設定持久化 + OS keychain。
//!
//! - `settings.json` 放 `<app_config_dir>`（原子寫入：tmp + rename）。
//! - ttls API key **只存 OS keychain**（service `ai-music-cut` / account `ttls-api-key`），
//!   永不落地磁碟、永不回傳前端（`ttls_key_status` 只回末 4 碼提示）。
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};

const KEYCHAIN_SERVICE: &str = "ai-music-cut";
pub const SETTINGS_FILE: &str = "settings.json";
pub const TTLS_KEY_ACCOUNT: &str = "ttls-api-key";

/// App 全域設定（磁碟格式）。**沒有任何 secret 欄位**——金鑰在 keychain。
/// 新安裝預設走**本機**辨識。
///
/// 為什麼不是 ttls：那是作者自架的伺服器，新使用者手上沒有金鑰，也拿不到 ——
/// 預設指過去等於一打開就是死路。本機這條路他自己裝得起來（設定裡有一鍵安裝），
/// 而且不上傳、不需要金鑰。有金鑰的人在設定裡切回 ttls 就好。
///
/// 已經有設定檔的使用者不受影響：這個預設只在欄位不存在時才生效。
fn default_asr_source() -> String {
    "local".to_string()
}

fn default_agent_backend() -> String {
    "claude".to_string()
}

/// 使用者另存的輸出預設。內建的那幾個寫在前端，**不存這裡** ——
/// 全部存下來的話，之後平台改了規範或我們修正內建值，舊使用者會被凍在舊版本。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportPreset {
    pub id: String,
    pub label: String,
    pub format: String,
    pub target_lufs: f32,
    #[serde(default)]
    pub leveling: bool,
    #[serde(default)]
    pub stems: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub ttls_base_url: String,
    /// ffmpeg 執行檔或其所在目錄；空＝自動偵測（PATH / 常見安裝路徑）。
    pub ffmpeg_path: Option<String>,
    /// claude CLI 的 --model（空＝CLI 預設）。
    pub claude_model: String,
    /// 結構化產出要用哪個 CLI："claude"（預設）或 "codex"。
    /// 助手的工具迴圈不受這個影響，一律 claude。
    #[serde(default = "default_agent_backend")]
    pub agent_backend: String,
    /// 審核 agent 用的模型（第二輪覆核；預設用比較便宜的 haiku）。
    pub claude_review_model: String,
    /// AI 判讀跑幾個角色："editor"＝只有剪輯；"editor+reviewer"＝剪輯提議、審核覆核。
    pub judge_roles: String,
    pub default_aggressiveness: u8,
    pub target_lufs: f32,
    pub output_dir: Option<String>,
    pub lang: String,
    pub judge_enabled: bool,
    /// 逐字稿來源："local"（預設，本機 faster-whisper）或 "ttls"（上傳到伺服器）。
    #[serde(default = "default_asr_source")]
    pub asr_source: String,
    pub asr_language: String,
    pub asr_model: String,
    pub hotwords: String,
    pub recent_projects: Vec<String>,
    /// 使用者改過的提示詞（id -> 內容）。**只存被改過的那幾條** ——
    /// 全部存下來的話，之後改了預設值，舊使用者永遠拿不到新的版本。
    #[serde(default)]
    pub prompt_overrides: std::collections::HashMap<String, String>,
    /// 使用者的贅字裁決（詞 -> "always" | "context" | "never"）。
    /// 同樣只存被動過的那幾個詞，內建詞表照樣會跟著版本進步。
    #[serde(default)]
    pub filler_rules: std::collections::HashMap<String, String>,
    /// 使用者另存的輸出預設（內建的不存）。
    #[serde(default)]
    pub export_presets: Vec<ExportPreset>,
    /// 專案範本，以 JSON 字串存放。
    ///
    /// 刻意**不定義結構**：範本的欄位會跟著剪輯功能一直長（角色、閃避、修聲…），
    /// 每加一個欄位就要改 Rust、對兩邊型別、再發一版，划不來。這裡只負責存取，
    /// 形狀由前端的 analysis/template.ts 定義並自己驗證（讀壞的會被濾掉）。
    #[serde(default)]
    pub project_templates: Vec<String>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            ttls_base_url: "https://ttls.markkulab.net".to_string(),
            ffmpeg_path: None,
            claude_model: "sonnet".to_string(),
            agent_backend: default_agent_backend(),
            claude_review_model: "haiku".to_string(),
            judge_roles: "editor+reviewer".to_string(),
            default_aggressiveness: 50,
            target_lufs: -16.0,
            output_dir: None,
            lang: "zh-TW".to_string(),
            judge_enabled: true,
            asr_source: default_asr_source(),
            asr_language: "zh".to_string(),
            asr_model: "auto".to_string(),
            hotwords: String::new(),
            recent_projects: Vec::new(),
            prompt_overrides: std::collections::HashMap::new(),
            filler_rules: std::collections::HashMap::new(),
            export_presets: Vec::new(),
            project_templates: Vec::new(),
        }
    }
}

pub fn app_config_dir(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_config_dir()
        .map_err(|e| AppError::Storage(format!("無法取得設定目錄：{e}")))
}

/// 媒體快取（抽出的 wav / 上傳用 opus / 波形 / 逐字稿）放 cache dir，可隨時清。
pub fn app_cache_dir(app: &AppHandle) -> AppResult<PathBuf> {
    app.path()
        .app_cache_dir()
        .map_err(|e| AppError::Storage(format!("無法取得快取目錄：{e}")))
}

async fn ensure_dir_at(dir: &Path) -> AppResult<()> {
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| AppError::Storage(format!("建立目錄失敗：{e}")))
}

/// 讀取目錄下的 JSON 檔。檔案不存在回 `T::default()`。
pub async fn read_json_in<T: DeserializeOwned + Default>(dir: &Path, file: &str) -> AppResult<T> {
    let path = dir.join(file);
    match tokio::fs::read(&path).await {
        Ok(bytes) => serde_json::from_slice::<T>(&bytes)
            .map_err(|e| AppError::Storage(format!("解析 {file} 失敗：{e}"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
        Err(e) => Err(AppError::Storage(format!("讀取 {file} 失敗：{e}"))),
    }
}

/// 原子寫入目錄下的 JSON 檔（tmp + rename）。
pub async fn write_json_in<T: Serialize>(dir: &Path, file: &str, value: &T) -> AppResult<()> {
    ensure_dir_at(dir).await?;
    let path = dir.join(file);
    let tmp = dir.join(format!("{file}.tmp"));
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| AppError::Storage(format!("序列化 {file} 失敗：{e}")))?;
    tokio::fs::write(&tmp, &bytes)
        .await
        .map_err(|e| AppError::Storage(format!("寫入 {file} 失敗：{e}")))?;
    tokio::fs::rename(&tmp, &path)
        .await
        .map_err(|e| AppError::Storage(format!("更新 {file} 失敗：{e}")))?;
    Ok(())
}

pub async fn read_json<T: DeserializeOwned + Default>(app: &AppHandle, file: &str) -> AppResult<T> {
    read_json_in(&app_config_dir(app)?, file).await
}

pub async fn write_json<T: Serialize>(app: &AppHandle, file: &str, value: &T) -> AppResult<()> {
    write_json_in(&app_config_dir(app)?, file, value).await
}

// ---- keychain ----

/// 寫入 keychain。secret 為空字串時視為「刪除該項」。
pub fn kc_set(account: &str, secret: &str) -> AppResult<()> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account)
        .map_err(|e| AppError::Storage(format!("keychain 開啟失敗：{e}")))?;
    if secret.is_empty() {
        let _ = entry.delete_credential();
        return Ok(());
    }
    entry
        .set_password(secret)
        .map_err(|e| AppError::Storage(format!("keychain 寫入失敗：{e}")))?;
    Ok(())
}

/// 讀取 keychain。不存在或任何錯誤都回 None（log 只記 account，不記內容）。
pub fn kc_get(account: &str) -> Option<String> {
    let entry = match keyring::Entry::new(KEYCHAIN_SERVICE, account) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[store] keychain 開啟失敗 ({account})：{e}");
            return None;
        }
    };
    match entry.get_password() {
        Ok(p) => Some(p),
        Err(keyring::Error::NoEntry) => None,
        Err(e) => {
            eprintln!("[store] keychain 讀取失敗 ({account})：{e}");
            None
        }
    }
}

pub fn kc_delete(account: &str) {
    if let Ok(entry) = keyring::Entry::new(KEYCHAIN_SERVICE, account) {
        let _ = entry.delete_credential();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir() -> PathBuf {
        let d = std::env::temp_dir().join(format!("aicut-store-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[tokio::test]
    async fn fresh_install_defaults_to_local_asr() {
        // 新安裝（沒有設定檔）預設走本機辨識：ttls 是作者自架的伺服器，
        // 新使用者拿不到金鑰，預設指過去等於一打開就是死路。
        let dir = tmpdir();
        let s: AppSettings = read_json_in(&dir, SETTINGS_FILE).await.unwrap();
        assert_eq!(s.asr_source, "local");
    }

    #[tokio::test]
    async fn existing_settings_keep_their_asr_source() {
        // 已經選了 ttls 的使用者升級後不該被改掉
        let dir = tmpdir();
        let raw = r#"{"asr_source":"ttls"}"#;
        tokio::fs::write(dir.join(SETTINGS_FILE), raw).await.unwrap();
        let s: AppSettings = read_json_in(&dir, SETTINGS_FILE).await.unwrap();
        assert_eq!(s.asr_source, "ttls");
    }

    #[tokio::test]
    async fn settings_roundtrip_and_defaults() {
        let dir = tmpdir();
        let s: AppSettings = read_json_in(&dir, SETTINGS_FILE).await.unwrap();
        assert_eq!(s.ttls_base_url, "https://ttls.markkulab.net");
        assert_eq!(s.default_aggressiveness, 50);
        let mut s2 = s.clone();
        s2.target_lufs = -14.0;
        s2.recent_projects.push("x.aicut.json".into());
        write_json_in(&dir, SETTINGS_FILE, &s2).await.unwrap();
        let back: AppSettings = read_json_in(&dir, SETTINGS_FILE).await.unwrap();
        assert_eq!(back.target_lufs, -14.0);
        assert_eq!(back.recent_projects.len(), 1);
    }

    /// 舊版設定檔缺欄位 → 走預設值，不可整份讀失敗。
    #[tokio::test]
    async fn settings_tolerates_missing_fields() {
        let dir = tmpdir();
        std::fs::write(dir.join(SETTINGS_FILE), r#"{"lang":"en"}"#).unwrap();
        let s: AppSettings = read_json_in(&dir, SETTINGS_FILE).await.unwrap();
        assert_eq!(s.lang, "en");
        assert_eq!(s.asr_model, "auto");
    }

    /// 設定檔序列化後絕不能出現金鑰欄位（金鑰只在 keychain）。
    #[test]
    fn settings_have_no_secret_fields() {
        let json = serde_json::to_string(&AppSettings::default()).unwrap().to_lowercase();
        assert!(!json.contains("api_key") && !json.contains("apikey") && !json.contains("secret"));
    }
}
