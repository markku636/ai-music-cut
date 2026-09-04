//! 媒體前處理與本機分析（純 ffmpeg 串流，不把整檔 PCM 留在記憶體）：
//! - `prepare_upload`：來源 → 16k mono opus 48 kbps（30 分鐘 ≈ 11 MB），給 ttls 轉寫上傳。
//! - `analyze_local`：一趟 decode 同時算 波形 min/max/RMS（5 ms 桶）+ ebur128 momentary/short-term LUFS（100 ms hop），
//!   輸出自訂二進位（見 `pack`），快取到 `<cache>/media/<fp16>/analysis.bin`；前端以 ArrayBuffer 接收，零 JSON 開銷。
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;

use crate::error::{AppError, AppResult};
use crate::ffmpeg::FfmpegBins;
use crate::{proc, store};

/// 波形桶：每秒 200 桶（5 ms）——同時當 EDL 貼邊用的能量包絡。
pub const PPS: u32 = 200;
/// 響度視窗 hop（ms）。
pub const HOP_MS: u32 = 100;
const SR: u32 = 48_000;
pub const FORMAT_VERSION: u32 = 2;

pub const UPLOAD_FILE: &str = "upload.ogg";
pub const ANALYSIS_FILE: &str = "analysis.bin";
pub const TRANSCRIPT_FILE: &str = "transcript.json";

pub fn media_dir(app: &AppHandle, fingerprint: &str) -> AppResult<PathBuf> {
    let fp: String = fingerprint.chars().take(16).collect();
    if fp.len() < 8 {
        return Err(AppError::Invalid("fingerprint 無效".into()));
    }
    let d = store::app_cache_dir(app)?.join("media").join(fp);
    std::fs::create_dir_all(&d)?;
    Ok(d)
}

#[derive(Serialize, Clone, Debug)]
pub struct CacheStatus {
    pub upload: bool,
    pub analysis: bool,
    pub transcript: bool,
    pub dir: String,
}

fn nonempty(p: &Path) -> bool {
    std::fs::metadata(p).map(|m| m.is_file() && m.len() > 0).unwrap_or(false)
}

pub fn cache_status(dir: &Path) -> CacheStatus {
    CacheStatus {
        upload: nonempty(&dir.join(UPLOAD_FILE)),
        analysis: nonempty(&dir.join(ANALYSIS_FILE)),
        transcript: nonempty(&dir.join(TRANSCRIPT_FILE)),
        dir: dir.to_string_lossy().into_owned(),
    }
}

#[derive(Serialize, Clone)]
struct Progress<'a> {
    job_id: &'a str,
    phase: &'a str,
    pct: f32,
}

fn emit_progress(app: &AppHandle, job_id: &str, phase: &str, pct: f32) {
    let _ = app.emit("media-progress", Progress { job_id, phase, pct });
}

/// 來源 → 上傳用 opus（已存在且非空則直接沿用）。
pub async fn prepare_upload(bins: &FfmpegBins, src: &str, dir: &Path) -> AppResult<(PathBuf, bool)> {
    let out = dir.join(UPLOAD_FILE);
    if nonempty(&out) {
        return Ok((out, true));
    }
    let tmp = dir.join(format!("{UPLOAD_FILE}.part"));
    let mut c = proc::cmd(&bins.ffmpeg);
    c.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i"]);
    c.arg(src);
    // 輸出先寫 .part 再 rename → 副檔名推不出容器，必須明確 -f ogg。
    c.args(["-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "48k", "-application", "voip", "-f", "ogg"]);
    c.arg(&tmp);
    let o = c.output().await.map_err(|e| AppError::Ffmpeg(format!("ffmpeg 啟動失敗：{e}")))?;
    if !o.status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(AppError::Ffmpeg(format!("轉 opus 失敗：{}", String::from_utf8_lossy(&o.stderr).trim())));
    }
    tokio::fs::rename(&tmp, &out).await?;
    Ok((out, false))
}

/// 串流分析器：每個樣本更新 5 ms 桶（min/max/平方和），每 100 ms 餵 ebur128 一次。
struct Analyzer {
    bucket_len: usize,
    hop_len: usize,
    cur_min: f32,
    cur_max: f32,
    cur_sq: f64,
    cur_n: usize,
    mins: Vec<i8>,
    maxs: Vec<i8>,
    rms: Vec<u8>,
    ebu: ebur128::EbuR128,
    hop_buf: Vec<f32>,
    win: Vec<f32>, // [momentary, shortTerm, rmsDb] × n
    total: u64,
}

fn db_to_u8(db: f64) -> u8 {
    // −60..0 dBFS → 0..255
    (((db + 60.0) / 60.0) * 255.0).round().clamp(0.0, 255.0) as u8
}

fn lufs_or_floor(v: Result<f64, ebur128::Error>) -> f32 {
    match v {
        Ok(x) if x.is_finite() => x as f32,
        _ => -100.0,
    }
}

impl Analyzer {
    fn new(sr: u32) -> AppResult<Self> {
        let ebu = ebur128::EbuR128::new(1, sr, ebur128::Mode::M | ebur128::Mode::S)
            .map_err(|e| AppError::Ffmpeg(format!("ebur128 初始化失敗：{e:?}")))?;
        Ok(Self {
            bucket_len: (sr / PPS) as usize,
            hop_len: (sr as u64 * HOP_MS as u64 / 1000) as usize,
            cur_min: f32::MAX,
            cur_max: f32::MIN,
            cur_sq: 0.0,
            cur_n: 0,
            mins: Vec::new(),
            maxs: Vec::new(),
            rms: Vec::new(),
            ebu,
            hop_buf: Vec::with_capacity((sr / 10) as usize),
            win: Vec::new(),
            total: 0,
        })
    }

    fn flush_bucket(&mut self) {
        if self.cur_n == 0 {
            return;
        }
        let q = |v: f32| (v.clamp(-1.0, 1.0) * 127.0).round() as i8;
        self.mins.push(q(self.cur_min));
        self.maxs.push(q(self.cur_max));
        let rms = (self.cur_sq / self.cur_n as f64).sqrt();
        let db = if rms > 0.0 { 20.0 * rms.log10() } else { -120.0 };
        self.rms.push(db_to_u8(db));
        self.cur_min = f32::MAX;
        self.cur_max = f32::MIN;
        self.cur_sq = 0.0;
        self.cur_n = 0;
    }

    fn flush_hop(&mut self) {
        if self.hop_buf.is_empty() {
            return;
        }
        let sq: f64 = self.hop_buf.iter().map(|v| (*v as f64) * (*v as f64)).sum();
        let rms = (sq / self.hop_buf.len() as f64).sqrt();
        let rms_db = if rms > 0.0 { 20.0 * rms.log10() } else { -120.0 } as f32;
        let _ = self.ebu.add_frames_f32(&self.hop_buf);
        let m = lufs_or_floor(self.ebu.loudness_momentary());
        let s = lufs_or_floor(self.ebu.loudness_shortterm());
        self.win.extend_from_slice(&[m, s, rms_db.max(-120.0)]);
        self.hop_buf.clear();
    }

    fn push(&mut self, samples: &[f32]) {
        for &v in samples {
            let v = if v.is_finite() { v } else { 0.0 };
            if v < self.cur_min {
                self.cur_min = v;
            }
            if v > self.cur_max {
                self.cur_max = v;
            }
            self.cur_sq += (v as f64) * (v as f64);
            self.cur_n += 1;
            if self.cur_n >= self.bucket_len {
                self.flush_bucket();
            }
            self.hop_buf.push(v);
            if self.hop_buf.len() >= self.hop_len {
                self.flush_hop();
            }
        }
        self.total += samples.len() as u64;
    }

    /// 打包：`"AIPK"` u32 version u32 pps u32 hop_ms u32 sr u32 n_buckets u32 n_win u64 total_samples
    /// → i8[n_buckets] min → i8[n_buckets] max → u8[n_buckets] rms → f32[n_win*3]（LE）。
    fn finish(mut self) -> Vec<u8> {
        self.flush_bucket();
        self.flush_hop();
        let n_b = self.mins.len() as u32;
        let n_w = (self.win.len() / 3) as u32;
        let mut out = Vec::with_capacity(4 + 4 * 6 + 8 + n_b as usize * 3 + self.win.len() * 4);
        out.extend_from_slice(b"AIPK");
        for v in [FORMAT_VERSION, PPS, HOP_MS, SR, n_b, n_w] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend_from_slice(&self.total.to_le_bytes());
        out.extend(self.mins.iter().map(|v| *v as u8));
        out.extend(self.maxs.iter().map(|v| *v as u8));
        out.extend_from_slice(&self.rms);
        for v in &self.win {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out
    }
}

/// 一趟串流 decode（f32le mono 48k）算波形 + 響度；有快取直接回。`cancel` 設 true 會殺 ffmpeg 並回 Canceled。
pub async fn analyze_local(
    app: &AppHandle,
    bins: &FfmpegBins,
    src: &str,
    dir: &Path,
    job_id: &str,
    duration_ms: u64,
    cancel: Arc<AtomicBool>,
) -> AppResult<Vec<u8>> {
    let out = dir.join(ANALYSIS_FILE);
    if nonempty(&out) {
        return Ok(tokio::fs::read(&out).await?);
    }
    let mut c = proc::cmd(&bins.ffmpeg);
    c.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-i"]);
    c.arg(src);
    c.args(["-vn", "-f", "f32le", "-ac", "1", "-ar", "48000", "pipe:1"]);
    c.stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = c.spawn().map_err(|e| AppError::Ffmpeg(format!("ffmpeg 啟動失敗：{e}")))?;
    let mut stdout = child.stdout.take().expect("stdout piped");
    let mut stderr = child.stderr.take().expect("stderr piped");
    let err_task = tokio::spawn(async move {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s).await;
        s
    });

    let mut an = Analyzer::new(SR)?;
    let mut buf = vec![0u8; 256 * 1024];
    let mut carry: Vec<u8> = Vec::new();
    let total_expected = (duration_ms as f64 / 1000.0 * SR as f64).max(1.0);
    let mut last_pct = -1.0f32;
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.start_kill();
            return Err(AppError::Canceled);
        }
        let n = stdout.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        carry.extend_from_slice(&buf[..n]);
        let usable = carry.len() / 4 * 4;
        let samples: Vec<f32> = carry[..usable]
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .collect();
        carry.drain(..usable);
        an.push(&samples);
        let pct = ((an.total as f64 / total_expected) * 100.0).min(99.0) as f32;
        if pct - last_pct >= 2.0 {
            last_pct = pct;
            emit_progress(app, job_id, "analyze", pct);
        }
    }
    let status = child.wait().await?;
    let err = err_task.await.unwrap_or_default();
    if !status.success() {
        return Err(AppError::Ffmpeg(format!("decode 失敗：{}", err.trim())));
    }
    let bytes = an.finish();
    let tmp = dir.join(format!("{ANALYSIS_FILE}.part"));
    tokio::fs::write(&tmp, &bytes).await?;
    tokio::fs::rename(&tmp, &out).await?;
    emit_progress(app, job_id, "analyze", 100.0);
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analyzer_packs_expected_layout() {
        let mut an = Analyzer::new(SR).unwrap();
        // 1 秒 440Hz 正弦 @ -6 dBFS
        let n = SR as usize;
        let samples: Vec<f32> = (0..n)
            .map(|i| 0.5 * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / SR as f32).sin())
            .collect();
        an.push(&samples);
        let bytes = an.finish();
        assert_eq!(&bytes[..4], b"AIPK");
        let u32_at = |o: usize| u32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
        assert_eq!(u32_at(4), FORMAT_VERSION);
        assert_eq!(u32_at(8), PPS);
        let n_b = u32_at(20);
        let n_w = u32_at(24);
        assert_eq!(n_b, PPS); // 1 秒 = 200 桶
        assert_eq!(n_w, 10); // 1 秒 = 10 個 100ms 視窗
        let head = 4 + 6 * 4 + 8;
        let maxs = &bytes[head + n_b as usize..head + 2 * n_b as usize];
        assert!(maxs.iter().all(|&m| (m as i8) >= 60), "峰值約 0.5 → ~63");
        let rms = &bytes[head + 2 * n_b as usize..head + 3 * n_b as usize];
        assert!(rms.iter().all(|&r| r > 200), "-9 dBFS RMS → 約 216");
        let win_off = head + 3 * n_b as usize;
        let f = |i: usize| f32::from_le_bytes(bytes[win_off + i * 4..win_off + i * 4 + 4].try_into().unwrap());
        // 最後一個視窗的 momentary 已有 400ms 資料，應接近 -9 LUFS（±3）
        let last_m = f((n_w as usize - 1) * 3);
        assert!(last_m > -14.0 && last_m < -4.0, "momentary={last_m}");
    }

    #[test]
    fn db_mapping() {
        assert_eq!(db_to_u8(0.0), 255);
        assert_eq!(db_to_u8(-60.0), 0);
        assert_eq!(db_to_u8(-120.0), 0);
        assert_eq!(db_to_u8(-30.0), 128);
    }
}
