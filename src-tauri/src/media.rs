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
pub const FORMAT_VERSION: u32 = 3;
/// analysis.bin 的 magic。v3 起每個桶多一個 byte：桶內第一個上升零交越的樣本位移（無則 255）。
pub const MAGIC: &[u8; 4] = b"AIPK";

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

/// 把來源的 [start, end] 切成 44.1k 立體聲 wav（曲風轉換 / 上傳參考用）。回輸出路徑。
pub async fn clip_wav(bins: &FfmpegBins, src: &str, start_ms: f64, end_ms: f64, out: &Path) -> AppResult<()> {
    let start = (start_ms.max(0.0)) / 1000.0;
    let dur = ((end_ms - start_ms).max(50.0)) / 1000.0;
    if let Some(parent) = out.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut c = proc::cmd(&bins.ffmpeg);
    c.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y"]);
    // -ss 放 -i 前是 fast seek，精度靠 -accurate_seek（預設開）；再用 -t 限長度
    c.args(["-ss", &format!("{start:.3}"), "-t", &format!("{dur:.3}"), "-i"]);
    c.arg(src);
    c.args(["-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", "-f", "wav"]);
    c.arg(out);
    let o = c.output().await.map_err(|e| AppError::Ffmpeg(format!("ffmpeg 啟動失敗：{e}")))?;
    if !o.status.success() {
        return Err(AppError::Ffmpeg(format!("切片失敗：{}", String::from_utf8_lossy(&o.stderr).trim())));
    }
    Ok(())
}


/// 多支麥克風對齊後併成一軌。
///
/// `delays_ms` 與 `srcs` 一一對應，且**都必須 ≥ 0** —— ffmpeg 的 `adelay` 只能把聲音
/// 往後推，不能往前拉。呼叫端（analysis/sync.ts 的 `delaysFromOffsets`）已經把整組
/// 平移到「最早的那一軌 = 0」。
///
/// `normalize=0`：amix 預設會把每一路除以路數，兩支麥就各小 6 dB，聽起來像整體變小聲。
/// 這裡要的是單純相加，音量交給後面的 loudnorm 處理。
pub async fn combine_tracks(bins: &FfmpegBins, srcs: &[String], delays_ms: &[i64], out: &Path) -> AppResult<()> {
    if srcs.len() < 2 || srcs.len() != delays_ms.len() {
        return Err(AppError::Invalid("至少要兩軌，而且每一軌都要有對應的延遲".into()));
    }
    if let Some(parent) = out.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut c = proc::cmd(&bins.ffmpeg);
    c.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y"]);
    for s in srcs {
        c.arg("-i");
        c.arg(s);
    }
    let mut parts: Vec<String> = Vec::new();
    let mut labels = String::new();
    for (i, d) in delays_ms.iter().enumerate() {
        let ms = (*d).max(0);
        // adelay 要為每個聲道各給一個值，`all=1` 讓它套用到全部聲道
        parts.push(format!("[{i}:a]aresample=48000,aformat=channel_layouts=mono,adelay={ms}:all=1[a{i}]"));
        labels.push_str(&format!("[a{i}]"));
    }
    parts.push(format!("{labels}amix=inputs={}:normalize=0:duration=longest[mix]", srcs.len()));
    let filter = parts.join(";");
    c.args(["-filter_complex", &filter, "-map", "[mix]"]);
    c.args(["-vn", "-ac", "1", "-ar", "48000", "-c:a", "pcm_s16le", "-f", "wav"]);
    c.arg(out);
    let o = c.output().await.map_err(|e| AppError::Ffmpeg(format!("ffmpeg 啟動失敗：{e}")))?;
    if !o.status.success() {
        let err = String::from_utf8_lossy(&o.stderr);
        let tail: Vec<&str> = err.lines().map(str::trim).filter(|l| !l.is_empty()).rev().take(3).collect();
        return Err(AppError::Ffmpeg(format!("合併麥克風失敗：{}", tail.into_iter().rev().collect::<Vec<_>>().join(" / "))));
    }
    Ok(())
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
    /// 每個桶內第一個上升零交越的樣本位移（255 = 這個桶裡沒有）。
    zx: Vec<u8>,
    cur_zx: u8,
    prev: f32,
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
            zx: Vec::new(),
            cur_zx: u8::MAX,
            prev: 0.0,
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
        self.zx.push(self.cur_zx);
        self.cur_min = f32::MAX;
        self.cur_max = f32::MIN;
        self.cur_sq = 0.0;
        self.cur_n = 0;
        self.cur_zx = u8::MAX;
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
            // 桶內第一個「上升零交越」（負→非負）的樣本位移。
            // 剪點對到這裡才不會在波形中間硬切出 click；5 ms 桶（240 sample）
            // 對 100 Hz 基頻（週期 10 ms）根本定位不到，所以要記到樣本層級。
            if self.cur_zx == u8::MAX && self.prev < 0.0 && v >= 0.0 && self.cur_n < 255 {
                self.cur_zx = self.cur_n as u8;
            }
            self.prev = v;
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
    /// → i8[n_buckets] min → i8[n_buckets] max → u8[n_buckets] rms → u8[n_buckets] zero-cross
    /// → f32[n_win*3]（LE）。
    ///
    /// v3 起多了 zero-cross 那一段（每個桶 1 byte，30 分鐘約 +360 KB）：
    /// 桶內第一個上升零交越的樣本位移，剪點對到它才不會硬切出 click。
    fn finish(mut self) -> Vec<u8> {
        self.flush_bucket();
        self.flush_hop();
        let n_b = self.mins.len() as u32;
        let n_w = (self.win.len() / 3) as u32;
        let mut out = Vec::with_capacity(4 + 4 * 6 + 8 + n_b as usize * 4 + self.win.len() * 4);
        out.extend_from_slice(b"AIPK");
        for v in [FORMAT_VERSION, PPS, HOP_MS, SR, n_b, n_w] {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out.extend_from_slice(&self.total.to_le_bytes());
        out.extend(self.mins.iter().map(|v| *v as u8));
        out.extend(self.maxs.iter().map(|v| *v as u8));
        out.extend_from_slice(&self.rms);
        out.extend_from_slice(&self.zx);
        for v in &self.win {
            out.extend_from_slice(&v.to_le_bytes());
        }
        out
    }
}

/// header 長度：magic 4 + 6 個 u32 + total_samples u64。
const HEADER_LEN: usize = 4 + 6 * 4 + 8;

/// 快取檔的 header 是不是這一版能讀的：magic 對、版本對、長度湊得起來。
/// 任何一項不符就當成要重算 —— 寧可多花 20–40 秒，也不要拿錯位的資料去算剪點。
pub fn analysis_header_ok(bytes: &[u8]) -> bool {
    if bytes.len() < HEADER_LEN || &bytes[..4] != MAGIC {
        return false;
    }
    let u32_at = |i: usize| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
    if u32_at(4) != FORMAT_VERSION {
        return false;
    }
    let n_b = u32_at(20) as usize;
    let n_w = u32_at(24) as usize;
    // v3 版面：header + 每桶 4 byte（min/max/rms/zero-cross）+ 每個響度視窗 3×f32
    bytes.len() == HEADER_LEN + n_b * 4 + n_w * 12
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
        let bytes = tokio::fs::read(&out).await?;
        // **一定要驗 header**：舊版只看「檔案非空」就直接回傳。
        // 版面一改（v2 → v3 每個桶多一個 byte），新解析器讀到舊快取會整個錯位，
        // 而且**完全不報錯** —— 症狀是波形亂掉、剪點全錯，最難查的那種。
        if analysis_header_ok(&bytes) {
            return Ok(bytes);
        }
        eprintln!("[media] analysis.bin 版本不符（或損毀），重新分析：{}", out.display());
        let _ = tokio::fs::remove_file(&out).await;
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
        // v3：桶 rms 之後多一段零交越位移
        let zx = &bytes[head + 3 * n_b as usize..head + 4 * n_b as usize];
        // 440 Hz、5 ms 桶（240 sample）→ 每個桶內都會有 2～3 次上升零交越
        assert!(zx.iter().all(|&z| z != u8::MAX), "每個桶都該找得到上升零交越");
        assert!(zx.iter().all(|&z| (z as usize) < SR as usize / PPS as usize), "位移必須落在桶內");

        let win_off = head + 4 * n_b as usize;
        let f = |i: usize| f32::from_le_bytes(bytes[win_off + i * 4..win_off + i * 4 + 4].try_into().unwrap());
        // 最後一個視窗的 momentary 已有 400ms 資料，應接近 -9 LUFS（±3）
        let last_m = f((n_w as usize - 1) * 3);
        assert!(last_m > -14.0 && last_m < -4.0, "momentary={last_m}");

        // 整份長度要跟 header 對得起來（analysis_header_ok 就是靠這個擋掉舊快取）
        assert!(analysis_header_ok(&bytes));
    }

    #[test]
    fn old_v2_cache_is_rejected_so_it_gets_rebuilt() {
        // 手工造一份 v2 的 header：magic 對、版本不對 → 一定要判為不可用。
        // 沒有這道檢查的話，v3 的解析器讀 v2 快取會整個錯位而且不報錯。
        let mut v2 = Vec::new();
        v2.extend_from_slice(MAGIC);
        for v in [2u32, PPS, HOP_MS, SR, 10u32, 1u32] {
            v2.extend_from_slice(&v.to_le_bytes());
        }
        v2.extend_from_slice(&0u64.to_le_bytes());
        v2.extend_from_slice(&vec![0u8; 10 * 3 + 12]); // v2 版面：每桶 3 byte
        assert!(!analysis_header_ok(&v2), "v2 快取必須被拒絕");

        // magic 不對、太短、長度湊不起來也都要拒絕
        assert!(!analysis_header_ok(b"NOPE"));
        assert!(!analysis_header_ok(&[]));
        let mut truncated = Analyzer::new(SR).unwrap().finish();
        truncated.truncate(truncated.len() - 1);
        assert!(!analysis_header_ok(&truncated));
    }

    #[test]
    fn db_mapping() {
        assert_eq!(db_to_u8(0.0), 255);
        assert_eq!(db_to_u8(-60.0), 0);
        assert_eq!(db_to_u8(-120.0), 0);
        assert_eq!(db_to_u8(-30.0), 128);
    }
}
