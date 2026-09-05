//! ffmpeg / ffprobe：偵測、探測媒體資訊、媒體指紋。
//!
//! 所有子程序走 `proc::cmd`（不彈黑窗）；路徑一律以 OsStr 傳參（不經 shell），中文 / 空白安全。
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::proc;

#[derive(Debug, Clone, Serialize)]
pub struct FfmpegBins {
    pub ffmpeg: String,
    pub ffprobe: String,
    pub version: String,
    /// custom / path / bundled / common
    pub source: String,
}

/// 安裝檔內建的 ffmpeg 在 resource_dir 底下的相對位置。
/// tauri 的 `bundle.resources` 會保留來源目錄結構，所以 `src-tauri/resources/ffmpeg/`
/// 進到安裝目錄後就是 `<resource_dir>/resources/ffmpeg/`。
const BUNDLED_SUBDIR: [&str; 2] = ["resources", "ffmpeg"];

/// 內建版的候選目錄。抽成純函式才測得到 —— 這條路徑對不上時的症狀是
/// 「安裝完還是說找不到 ffmpeg」，而且完全沒有錯誤訊息可查。
pub fn bundled_candidate(resource_dir: &Path) -> PathBuf {
    let mut p = resource_dir.to_path_buf();
    for seg in BUNDLED_SUBDIR {
        p.push(seg);
    }
    p
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

fn sibling_probe(ffmpeg: &Path) -> Option<PathBuf> {
    let p = ffmpeg.parent()?.join(exe("ffprobe"));
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

async fn version_of(ffmpeg: &Path) -> Option<String> {
    let mut c = proc::cmd(&ffmpeg.to_string_lossy());
    c.arg("-version");
    let out = c.output().await.ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let first = s.lines().next()?;
    // "ffmpeg version 7.1-essentials_build-www.gyan.dev Copyright ..."
    let v = first.strip_prefix("ffmpeg version ").unwrap_or(first);
    Some(v.split_whitespace().next().unwrap_or(v).to_string())
}

async fn try_candidate(path: PathBuf, source: &str) -> Option<FfmpegBins> {
    let ffmpeg = if path.is_dir() { path.join(exe("ffmpeg")) } else { path };
    if !ffmpeg.is_file() {
        return None;
    }
    let ffprobe = sibling_probe(&ffmpeg)?;
    let version = version_of(&ffmpeg).await?;
    Some(FfmpegBins {
        ffmpeg: ffmpeg.to_string_lossy().into_owned(),
        ffprobe: ffprobe.to_string_lossy().into_owned(),
        version,
        source: source.to_string(),
    })
}

fn common_dirs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if cfg!(windows) {
        for root in ["C:\\", "D:\\"] {
            if let Ok(rd) = std::fs::read_dir(root) {
                for e in rd.flatten() {
                    let n = e.file_name().to_string_lossy().to_lowercase();
                    if n.starts_with("ffmpeg") {
                        v.push(e.path().join("bin"));
                        v.push(e.path());
                    }
                }
            }
        }
        if let Some(la) = std::env::var_os("LOCALAPPDATA") {
            v.push(PathBuf::from(la).join("Microsoft").join("WinGet").join("Links"));
        }
        if let Some(pf) = std::env::var_os("ProgramFiles") {
            v.push(PathBuf::from(pf).join("ffmpeg").join("bin"));
        }
    } else {
        for p in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
            v.push(PathBuf::from(p));
        }
    }
    v
}

/// 解析順序：使用者自訂路徑 → PATH（where/which）→ 安裝檔內建 → 常見安裝目錄。
/// ffprobe 必須與 ffmpeg 同目錄（`sibling_probe`）。
///
/// 內建版刻意排在 PATH 之後：使用者自己裝了新版 / 自訂 build 就該用他的，
/// 內建的只是「什麼都沒有時也能開箱即用」的保底。
pub async fn resolve(custom: Option<&str>, bundled_dir: Option<&Path>) -> Option<FfmpegBins> {
    if let Some(c) = custom.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(b) = try_candidate(PathBuf::from(c), "custom").await {
            return Some(b);
        }
    }
    for p in proc::which("ffmpeg").await {
        if let Some(b) = try_candidate(PathBuf::from(p), "path").await {
            return Some(b);
        }
    }
    if let Some(d) = bundled_dir {
        if let Some(b) = try_candidate(d.to_path_buf(), "bundled").await {
            return Some(b);
        }
    }
    for dir in common_dirs() {
        if let Some(b) = try_candidate(dir, "common").await {
            return Some(b);
        }
    }
    None
}

#[derive(Debug, Clone, Serialize)]
pub struct AudioStream {
    pub codec: String,
    pub sample_rate: u32,
    pub channels: u32,
    pub bit_rate: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VideoStream {
    pub codec: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct MediaProbe {
    pub path: String,
    pub size_bytes: u64,
    pub duration_ms: u64,
    pub container: String,
    pub audio: Option<AudioStream>,
    /// mp3 封面圖（attached_pic）不算影片。
    pub video: Option<VideoStream>,
    pub fingerprint: String,
}

fn parse_num<T: std::str::FromStr>(v: &serde_json::Value) -> Option<T> {
    v.as_str().and_then(|s| s.parse::<T>().ok())
}

pub async fn probe(bins: &FfmpegBins, path: &str) -> AppResult<MediaProbe> {
    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|e| AppError::NotFound(format!("{path}：{e}")))?;
    let mut c = proc::cmd(&bins.ffprobe);
    c.args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"]);
    c.arg(path);
    let out = c
        .output()
        .await
        .map_err(|e| AppError::Ffmpeg(format!("ffprobe 啟動失敗：{e}")))?;
    if !out.status.success() {
        return Err(AppError::Ffmpeg(format!(
            "ffprobe 失敗：{}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| AppError::Ffmpeg(format!("ffprobe 輸出解析失敗：{e}")))?;
    let fmt = &v["format"];
    let duration_ms = parse_num::<f64>(&fmt["duration"])
        .map(|d| (d * 1000.0).round() as u64)
        .unwrap_or(0);
    let container = fmt["format_name"].as_str().unwrap_or("").to_string();
    let mut audio = None;
    let mut video = None;
    for s in v["streams"].as_array().cloned().unwrap_or_default() {
        match s["codec_type"].as_str() {
            Some("audio") if audio.is_none() => {
                audio = Some(AudioStream {
                    codec: s["codec_name"].as_str().unwrap_or("").to_string(),
                    sample_rate: parse_num::<u32>(&s["sample_rate"]).unwrap_or(0),
                    channels: s["channels"].as_u64().unwrap_or(0) as u32,
                    bit_rate: parse_num::<u64>(&s["bit_rate"]),
                });
            }
            Some("video") if video.is_none() => {
                let attached = s["disposition"]["attached_pic"].as_u64().unwrap_or(0) == 1;
                if !attached {
                    video = Some(VideoStream {
                        codec: s["codec_name"].as_str().unwrap_or("").to_string(),
                        width: s["width"].as_u64().unwrap_or(0) as u32,
                        height: s["height"].as_u64().unwrap_or(0) as u32,
                    });
                }
            }
            _ => {}
        }
    }
    if audio.is_none() {
        return Err(AppError::Invalid("這個檔案沒有音軌".into()));
    }
    let p = path.to_string();
    let fingerprint = tokio::task::spawn_blocking(move || fingerprint(&p))
        .await
        .map_err(|e| AppError::Io(e.to_string()))??;
    Ok(MediaProbe {
        path: path.to_string(),
        size_bytes: meta.len(),
        duration_ms,
        container,
        audio,
        video,
        fingerprint,
    })
}

/// 媒體指紋：blake3(size ‖ 首 4 MiB ‖ 尾 4 MiB)。不讀整檔（60 分鐘 wav 可達 600 MB）。
pub fn fingerprint(path: &str) -> AppResult<String> {
    const CHUNK: u64 = 4 * 1024 * 1024;
    let mut f = std::fs::File::open(path)?;
    let size = f.metadata()?.len();
    let mut h = blake3::Hasher::new();
    h.update(&size.to_le_bytes());
    let mut head = vec![0u8; CHUNK.min(size) as usize];
    f.read_exact(&mut head)?;
    h.update(&head);
    if size > CHUNK {
        f.seek(SeekFrom::Start(size - CHUNK))?;
        let mut tail = vec![0u8; CHUNK as usize];
        f.read_exact(&mut tail)?;
        h.update(&tail);
    }
    Ok(h.finalize().to_hex().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_stable_and_size_sensitive() {
        let dir = std::env::temp_dir().join(format!("aicut-fp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.bin");
        std::fs::write(&a, vec![7u8; 10_000]).unwrap();
        let f1 = fingerprint(a.to_str().unwrap()).unwrap();
        let f2 = fingerprint(a.to_str().unwrap()).unwrap();
        assert_eq!(f1, f2);
        std::fs::write(&a, vec![7u8; 10_001]).unwrap();
        assert_ne!(f1, fingerprint(a.to_str().unwrap()).unwrap());
        let empty = dir.join("e.bin");
        std::fs::write(&empty, b"").unwrap();
        assert_eq!(fingerprint(empty.to_str().unwrap()).unwrap().len(), 64);
    }

    #[test]
    fn bundled_candidate_matches_tauri_resource_layout() {
        // bundle.resources 保留來源目錄結構 → <resource_dir>/resources/ffmpeg
        let got = bundled_candidate(Path::new("C:/Program Files/AI Music Cut"));
        assert!(got.ends_with(Path::new("resources").join("ffmpeg")), "{got:?}");
        assert!(got.starts_with("C:/Program Files/AI Music Cut"));
    }

    #[tokio::test]
    async fn bundled_is_skipped_when_dir_has_no_ffmpeg() {
        // 目錄存在但裡面沒有 ffmpeg → 不能回傳半套結果，要往下一個候選找
        let dir = std::env::temp_dir().join(format!("aicut-bundled-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(try_candidate(dir.clone(), "bundled").await.is_none());
        // 只有 ffmpeg 沒有 ffprobe 也一樣不算數（sibling_probe）
        std::fs::write(dir.join(exe("ffmpeg")), b"not a real exe").unwrap();
        assert!(try_candidate(dir, "bundled").await.is_none());
    }
}
