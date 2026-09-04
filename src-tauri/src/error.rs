use serde::Serialize;

/// 統一錯誤型別。對前端序列化成 `{ kind, code, message, status? }`。
///
/// `#[error(...)]` 為中性英文（Display / log 用）；使用者可見的 `message` 由 `message()` 產生（繁中）。
/// 刻意不攜帶任何 request header / API key（ttls 錯誤只帶 HTTP status + 伺服器 detail）。
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("not found: {0}")]
    NotFound(String),

    #[error("io error: {0}")]
    Io(String),

    #[error("ffmpeg error: {0}")]
    Ffmpeg(String),

    /// ttls 伺服器回非 2xx（status=0 表示連線層錯誤）。
    #[error("ttls {status}: {detail}")]
    Ttls { status: u16, detail: String },

    /// 缺 API key 或 key 不對（401 / 403）。
    #[error("ttls auth failed")]
    Auth,

    #[error("storage error: {0}")]
    Storage(String),

    #[error("agent error: {0}")]
    Agent(String),

    #[error("canceled")]
    Canceled,

    #[error("timed out after {0} ms")]
    Timeout(u64),

    #[error("invalid: {0}")]
    Invalid(String),
}

impl AppError {
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::NotFound(_) => "not_found",
            AppError::Io(_) => "io",
            AppError::Ffmpeg(_) => "ffmpeg",
            AppError::Ttls { .. } => "ttls",
            AppError::Auth => "auth",
            AppError::Storage(_) => "storage",
            AppError::Agent(_) => "agent",
            AppError::Canceled => "canceled",
            AppError::Timeout(_) => "timeout",
            AppError::Invalid(_) => "invalid",
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            AppError::NotFound(_) => "ERR_NOT_FOUND",
            AppError::Io(_) => "ERR_IO",
            AppError::Ffmpeg(_) => "ERR_FFMPEG",
            AppError::Ttls { .. } => "ERR_TTLS",
            AppError::Auth => "ERR_AUTH",
            AppError::Storage(_) => "ERR_STORAGE",
            AppError::Agent(_) => "ERR_AGENT",
            AppError::Canceled => "ERR_CANCELED",
            AppError::Timeout(_) => "ERR_TIMEOUT",
            AppError::Invalid(_) => "ERR_INVALID",
        }
    }

    /// HTTP status（僅 ttls / auth 有；前端據此決定 backoff 或開設定）。
    pub fn status(&self) -> Option<u16> {
        match self {
            AppError::Ttls { status, .. } => Some(*status),
            AppError::Auth => Some(401),
            _ => None,
        }
    }

    pub fn message(&self) -> String {
        match self {
            AppError::NotFound(s) => format!("找不到：{s}"),
            AppError::Io(s) => format!("檔案讀寫錯誤：{s}"),
            AppError::Ffmpeg(s) => format!("ffmpeg 錯誤：{s}"),
            AppError::Ttls { status: 0, detail } => format!("無法連線 ttls 伺服器：{detail}"),
            AppError::Ttls { status, detail } => format!("ttls 伺服器回 HTTP {status}：{detail}"),
            AppError::Auth => "ttls API 金鑰缺少或錯誤，請到設定重新輸入".to_string(),
            AppError::Storage(s) => format!("儲存錯誤：{s}"),
            AppError::Agent(s) => format!("AI 助手錯誤：{s}"),
            AppError::Canceled => "已取消".to_string(),
            AppError::Timeout(ms) => format!("逾時（{ms} ms）"),
            AppError::Invalid(s) => s.clone(),
        }
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut s = serializer.serialize_struct("AppError", 4)?;
        s.serialize_field("kind", self.kind())?;
        s.serialize_field("code", self.code())?;
        s.serialize_field("message", &self.message())?;
        s.serialize_field("status", &self.status())?;
        s.end()
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e.to_string())
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        if e.is_timeout() {
            return AppError::Timeout(0);
        }
        // without_url：錯誤訊息不夾帶 URL（避免 query 或路徑洩漏到 log / toast）。
        AppError::Ttls { status: 0, detail: e.without_url().to_string() }
    }
}

pub type AppResult<T> = Result<T, AppError>;
