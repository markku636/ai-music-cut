//! 專案檔（`*.aicut.json`）讀寫：原子寫入、大小上限。內容結構由前端 `project/format.ts` 定義，
//! 後端只當 JSON 搬運工（不解析），前端 schema 升級不需動 Rust。
use std::path::PathBuf;

use crate::error::{AppError, AppResult};

const MAX_BYTES: u64 = 64 * 1024 * 1024;

pub async fn save(path: &str, value: &serde_json::Value) -> AppResult<()> {
    let p = PathBuf::from(path);
    if let Some(dir) = p.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| AppError::Storage(format!("建立專案目錄失敗：{e}")))?;
    }
    let tmp = PathBuf::from(format!("{path}.tmp"));
    let bytes = serde_json::to_vec_pretty(value)
        .map_err(|e| AppError::Storage(format!("序列化專案失敗：{e}")))?;
    tokio::fs::write(&tmp, &bytes)
        .await
        .map_err(|e| AppError::Storage(format!("寫入專案失敗：{e}")))?;
    tokio::fs::rename(&tmp, &p)
        .await
        .map_err(|e| AppError::Storage(format!("更新專案檔失敗：{e}")))?;
    Ok(())
}

pub async fn load(path: &str) -> AppResult<serde_json::Value> {
    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|e| AppError::NotFound(format!("{path}：{e}")))?;
    if meta.len() > MAX_BYTES {
        return Err(AppError::Invalid(format!("專案檔過大（{} MB），拒絕載入", meta.len() / 1024 / 1024)));
    }
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|e| AppError::Storage(format!("讀取專案失敗：{e}")))?;
    serde_json::from_slice(&bytes).map_err(|e| AppError::Storage(format!("專案檔不是合法 JSON：{e}")))
}
