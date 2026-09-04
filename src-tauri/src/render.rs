//! 輸出：Rust 串流剪接（依保留段切、逐段增益、等功率 crossfade、room tone gap）→ concat.wav
//! → ffmpeg loudnorm 兩趟（量測 → 線性套用）+ alimiter → 編碼 mp3 / m4a / wav。
//!
//! 記憶體 O(crossfade)：PCM 由 ffmpeg 串流吐出，逐 frame 決定丟 / 寫；不把整檔留在記憶體。
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

use crate::error::{AppError, AppResult};
use crate::ffmpeg::FfmpegBins;
use crate::proc;

const SR: u32 = 48_000;
const ROOM_TONE_AMP: f32 = 0.001; // −60 dBFS

#[derive(Debug, Clone, Deserialize)]
pub struct RenderSeg {
    pub src_start_ms: f64,
    pub src_end_ms: f64,
    pub gain_db: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RenderJoin {
    /// crossfade | gap | seam（同一保留段內的響度單元接縫：直接接、不淡）
    pub kind: String,
    pub ms: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RenderPlan {
    pub segs: Vec<RenderSeg>,
    /// len = segs.len() − 1
    pub joins: Vec<RenderJoin>,
    pub crossfade_ms: f64,
    pub target_lufs: f64,
    pub true_peak_dbtp: f64,
    /// mp3 | m4a | wav
    pub format: String,
    pub out_path: String,
    pub channels: u32,
}

#[derive(Serialize, Clone)]
struct Progress<'a> {
    job_id: &'a str,
    /// cut | measure | encode
    stage: &'a str,
    pct: f32,
}

#[derive(Serialize, Clone)]
pub struct RenderDone {
    pub job_id: String,
    pub ok: bool,
    pub out_path: Option<String>,
    pub error: Option<String>,
    pub input_lufs: Option<f64>,
    pub output_lufs: Option<f64>,
    pub output_tp: Option<f64>,
    pub elapsed_ms: u64,
}

fn emit_progress(app: &AppHandle, job_id: &str, stage: &str, pct: f32) {
    let _ = app.emit("render-progress", Progress { job_id, stage, pct: pct.clamp(0.0, 100.0) });
}

fn ms_to_frames(ms: f64) -> u64 {
    ((ms.max(0.0) / 1000.0) * SR as f64).round() as u64
}

/// 串流剪接器：frame 逐一進來，依 plan 決定寫 / 丟；接點做等功率 crossfade 或 room tone gap。
struct Cutter<W: std::io::Write + std::io::Seek> {
    ch: usize,
    segs: Vec<(u64, u64, f32)>, // (start_frame, end_frame, gain_lin)
    joins: Vec<(String, u64)>,  // (kind, frames)
    xf: u64,
    si: usize,
    t: u64,
    /// 上一段被扣住的尾巴（crossfade 長度），寫下一段開頭時混入。
    tail: Vec<f32>,
    /// 目前段還剩幾個 frame 要與 tail 混（0=不在 crossfade 中）
    mixing_left: u64,
    mix_total: u64,
    written: u64,
    writer: hound::WavWriter<W>,
}

impl<W: std::io::Write + std::io::Seek> Cutter<W> {
    fn new(plan: &RenderPlan, writer: hound::WavWriter<W>) -> Self {
        let segs = plan
            .segs
            .iter()
            .map(|s| (ms_to_frames(s.src_start_ms), ms_to_frames(s.src_end_ms), 10f32.powf((s.gain_db / 20.0) as f32)))
            .collect();
        let joins = plan.joins.iter().map(|j| (j.kind.clone(), ms_to_frames(j.ms))).collect();
        Self {
            ch: plan.channels.max(1) as usize,
            segs,
            joins,
            xf: ms_to_frames(plan.crossfade_ms.max(1.0)),
            si: 0,
            t: 0,
            tail: Vec::new(),
            mixing_left: 0,
            mix_total: 0,
            written: 0,
            writer,
        }
    }

    fn write_frame(&mut self, frame: &[f32]) -> AppResult<()> {
        for v in frame {
            self.writer.write_sample(v.clamp(-1.0, 1.0)).map_err(|e| AppError::Io(format!("寫 wav 失敗：{e}")))?;
        }
        self.written += 1;
        Ok(())
    }

    /// 把 tail 以淡出寫出（gap / 結尾用）。
    fn flush_tail_fade_out(&mut self) -> AppResult<()> {
        let n = self.tail.len() / self.ch;
        let tail = std::mem::take(&mut self.tail);
        for k in 0..n {
            let w = 1.0 - (k as f32 + 1.0) / (n as f32 + 1.0);
            let frame: Vec<f32> = tail[k * self.ch..(k + 1) * self.ch].iter().map(|v| v * w).collect();
            self.write_frame(&frame)?;
        }
        Ok(())
    }

    fn write_room_tone(&mut self, frames: u64, seed: &mut u32) -> AppResult<()> {
        for _ in 0..frames {
            let mut frame = Vec::with_capacity(self.ch);
            for _ in 0..self.ch {
                // xorshift 白噪，夠當 room tone
                *seed ^= *seed << 13;
                *seed ^= *seed >> 17;
                *seed ^= *seed << 5;
                let r = (*seed as f32 / u32::MAX as f32) * 2.0 - 1.0;
                frame.push(r * ROOM_TONE_AMP);
            }
            self.write_frame(&frame)?;
        }
        Ok(())
    }

    /// 進入第 si 段前的接點處理（依 join kind）。
    fn begin_segment(&mut self, seed: &mut u32) -> AppResult<()> {
        if self.si == 0 {
            return Ok(());
        }
        let (kind, frames) = self.joins.get(self.si - 1).cloned().unwrap_or(("crossfade".into(), 0));
        match kind.as_str() {
            "gap" => {
                self.flush_tail_fade_out()?;
                self.write_room_tone(frames.max(1), seed)?;
                // 下一段開頭用 tail 為零的 crossfade ＝ 淡入
                self.tail = vec![0.0; (self.xf as usize) * self.ch];
                self.mix_total = self.xf;
                self.mixing_left = self.xf;
            }
            "seam" => {
                // 直接接：tail 原樣寫出
                let tail = std::mem::take(&mut self.tail);
                for k in 0..tail.len() / self.ch {
                    let f = tail[k * self.ch..(k + 1) * self.ch].to_vec();
                    self.write_frame(&f)?;
                }
                self.mixing_left = 0;
            }
            _ => {
                let n = (self.tail.len() / self.ch) as u64;
                self.mix_total = n;
                self.mixing_left = n;
            }
        }
        Ok(())
    }

    /// 餵一個 frame（來源時間 t）。
    fn push(&mut self, frame: &[f32], seed: &mut u32) -> AppResult<()> {
        let t = self.t;
        self.t += 1;
        // 跳過已完成的段
        while self.si < self.segs.len() && t >= self.segs[self.si].1 {
            self.end_segment()?;
            self.si += 1;
            if self.si < self.segs.len() {
                self.begin_segment(seed)?;
            }
        }
        if self.si >= self.segs.len() {
            return Ok(());
        }
        let (s, e, g) = self.segs[self.si];
        if t < s {
            return Ok(());
        }
        if t == s && self.tail.is_empty() && self.si > 0 {
            // begin_segment 尚未被呼叫（上一段結束於此段開始前，已在 while 內處理）→ no-op
        }
        let mut cur: Vec<f32> = frame.iter().map(|v| v * g).collect();
        // 本段最後 xf 個 frame 扣住當 tail（若段夠長）
        let len = e - s;
        let hold = self.xf.min(len / 2);
        if t + hold >= e && hold > 0 {
            self.tail.extend_from_slice(&cur);
            return Ok(());
        }
        if self.mixing_left > 0 {
            let k = (self.mix_total - self.mixing_left) as usize;
            let theta = (k as f32 + 0.5) / self.mix_total as f32 * std::f32::consts::FRAC_PI_2;
            let (w_in, w_out) = (theta.sin(), theta.cos());
            let base = k * self.ch;
            for c in 0..self.ch {
                let prev = self.tail.get(base + c).copied().unwrap_or(0.0);
                cur[c] = prev * w_out + cur[c] * w_in;
            }
            self.mixing_left -= 1;
            if self.mixing_left == 0 {
                self.tail.clear();
            }
        }
        self.write_frame(&cur)
    }

    fn end_segment(&mut self) -> AppResult<()> {
        // 段結束時若還在 mixing（段比 tail 短），把剩餘 tail 直接寫出
        if self.mixing_left > 0 {
            let k0 = (self.mix_total - self.mixing_left) as usize;
            let tail = std::mem::take(&mut self.tail);
            for k in k0..tail.len() / self.ch {
                let f = tail[k * self.ch..(k + 1) * self.ch].to_vec();
                self.write_frame(&f)?;
            }
            self.mixing_left = 0;
        }
        Ok(())
    }

    fn finish(mut self) -> AppResult<u64> {
        self.end_segment()?;
        self.flush_tail_fade_out()?;
        self.writer.finalize().map_err(|e| AppError::Io(format!("wav finalize 失敗：{e}")))?;
        Ok(self.written)
    }
}

fn total_out_frames(plan: &RenderPlan) -> u64 {
    let mut n: u64 = plan.segs.iter().map(|s| ms_to_frames(s.src_end_ms).saturating_sub(ms_to_frames(s.src_start_ms))).sum();
    for j in &plan.joins {
        if j.kind == "gap" {
            n += ms_to_frames(j.ms);
        }
    }
    n
}

/// 第一階段：來源 → concat.wav（f32、48k、ch）。
pub async fn cut_to_wav(app: &AppHandle, bins: &FfmpegBins, src: &str, plan: &RenderPlan, wav_path: &Path, job_id: &str, cancel: &AtomicBool) -> AppResult<u64> {
    let ch = plan.channels.max(1);
    let spec = hound::WavSpec { channels: ch as u16, sample_rate: SR, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
    let file = std::fs::File::create(wav_path)?;
    let writer = hound::WavWriter::new(std::io::BufWriter::new(file), spec).map_err(|e| AppError::Io(format!("建立 wav 失敗：{e}")))?;
    let mut cutter = Cutter::new(plan, writer);
    let last_end = plan.segs.iter().map(|s| ms_to_frames(s.src_end_ms)).max().unwrap_or(0);

    let mut c = proc::cmd(&bins.ffmpeg);
    c.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-i"]);
    c.arg(src);
    c.args(["-vn", "-f", "f32le", "-ar", "48000", "-ac", &ch.to_string(), "pipe:1"]);
    c.stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = c.spawn().map_err(|e| AppError::Ffmpeg(format!("ffmpeg 啟動失敗：{e}")))?;
    let mut stdout = child.stdout.take().expect("stdout");
    let mut stderr = child.stderr.take().expect("stderr");
    let err_task = tokio::spawn(async move {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s).await;
        s
    });
    let mut buf = vec![0u8; 256 * 1024];
    let mut carry: Vec<u8> = Vec::new();
    let frame_bytes = 4 * ch as usize;
    let mut seed: u32 = 0x9E37_79B9;
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
        let usable = carry.len() / frame_bytes * frame_bytes;
        let mut frame = vec![0f32; ch as usize];
        for fb in carry[..usable].chunks_exact(frame_bytes) {
            for (i, sb) in fb.chunks_exact(4).enumerate() {
                frame[i] = f32::from_le_bytes([sb[0], sb[1], sb[2], sb[3]]);
            }
            cutter.push(&frame, &mut seed)?;
        }
        carry.drain(..usable);
        if cutter.t >= last_end {
            let _ = child.start_kill(); // 後面用不到，提早結束 decode
            break;
        }
        let pct = (cutter.t as f64 / last_end.max(1) as f64 * 100.0) as f32;
        if pct - last_pct >= 1.0 {
            last_pct = pct;
            emit_progress(app, job_id, "cut", pct);
        }
    }
    let _ = child.wait().await;
    let _ = err_task.await;
    let written = cutter.finish()?;
    emit_progress(app, job_id, "cut", 100.0);
    Ok(written)
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct LoudnormStats {
    pub input_i: f64,
    pub input_tp: f64,
    pub input_lra: f64,
    pub input_thresh: f64,
    pub target_offset: f64,
    pub output_i: Option<f64>,
    pub output_tp: Option<f64>,
}

/// 從 ffmpeg stderr 撈 loudnorm 的 JSON 區塊。
pub fn parse_loudnorm_json(stderr: &str) -> Option<LoudnormStats> {
    // 以 "input_i" 為錨點往前找 '{'、往後找 '}'：Windows 的 ffmpeg stderr 是 \r\n，不能假設 "{\n"。
    let anchor = stderr.rfind("\"input_i\"")?;
    let start = stderr[..anchor].rfind('{')?;
    let end = stderr[anchor..].find('}')? + anchor + 1;
    let v: serde_json::Value = serde_json::from_str(&stderr[start..end]).ok()?;
    let f = |k: &str| v.get(k).and_then(|x| x.as_str()).and_then(|s| s.parse::<f64>().ok());
    Some(LoudnormStats {
        input_i: f("input_i")?,
        input_tp: f("input_tp")?,
        input_lra: f("input_lra")?,
        input_thresh: f("input_thresh")?,
        target_offset: f("target_offset").unwrap_or(0.0),
        output_i: f("output_i"),
        output_tp: f("output_tp"),
    })
}

fn loudnorm_base(plan: &RenderPlan) -> String {
    format!("loudnorm=I={:.1}:TP={:.1}:LRA=11", plan.target_lufs, plan.true_peak_dbtp)
}

/// 第二階段：量測（pass 1）。
pub async fn measure(bins: &FfmpegBins, wav_path: &Path, plan: &RenderPlan, cancel: &AtomicBool) -> AppResult<LoudnormStats> {
    let mut c = proc::cmd(&bins.ffmpeg);
    c.args(["-nostdin", "-hide_banner", "-i"]);
    c.arg(wav_path);
    c.args(["-af", &format!("{}:print_format=json", loudnorm_base(plan)), "-f", "null", "-"]);
    c.stdout(Stdio::null()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = c.spawn().map_err(|e| AppError::Ffmpeg(format!("ffmpeg 啟動失敗：{e}")))?;
    let mut stderr = child.stderr.take().expect("stderr");
    let err_task = tokio::spawn(async move {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s).await;
        s
    });
    // child.wait() 是 cancel-safe：每 300 ms 檢查一次取消旗標
    let status = loop {
        tokio::select! {
            r = child.wait() => break r?,
            _ = tokio::time::sleep(std::time::Duration::from_millis(300)) => {
                if cancel.load(Ordering::Relaxed) { let _ = child.start_kill(); return Err(AppError::Canceled); }
            }
        }
    };
    let s = err_task.await.unwrap_or_default();
    if !status.success() {
        return Err(AppError::Ffmpeg(format!("loudnorm 量測失敗：{}", s.lines().last().unwrap_or("").trim())));
    }
    parse_loudnorm_json(&s).ok_or_else(|| AppError::Ffmpeg("loudnorm 量測沒有輸出 JSON".into()))
}

/// 第三階段：套用 + 編碼（pass 2），`-progress pipe:1` 回報進度。回 (output_i, output_tp)。
pub async fn encode(app: &AppHandle, bins: &FfmpegBins, wav_path: &Path, plan: &RenderPlan, m: &LoudnormStats, out_part: &Path, total_frames: u64, job_id: &str, cancel: &AtomicBool) -> AppResult<(Option<f64>, Option<f64>)> {
    let filter = format!(
        "{}:measured_I={:.2}:measured_TP={:.2}:measured_LRA={:.2}:measured_thresh={:.2}:offset={:.2}:linear=true:print_format=json,alimiter=limit={:.4}:attack=5:release=50:level=false",
        loudnorm_base(plan),
        m.input_i,
        m.input_tp,
        m.input_lra,
        m.input_thresh,
        m.target_offset,
        10f64.powf(plan.true_peak_dbtp / 20.0)
    );
    let (fmt, codec): (&str, Vec<&str>) = match plan.format.as_str() {
        "wav" => ("wav", vec!["-c:a", "pcm_s16le"]),
        "m4a" => ("mp4", vec!["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]),
        _ => ("mp3", vec!["-c:a", "libmp3lame", "-q:a", "2"]),
    };
    let mut c = proc::cmd(&bins.ffmpeg);
    c.args(["-nostdin", "-hide_banner", "-nostats", "-loglevel", "info", "-progress", "pipe:1", "-y", "-i"]);
    c.arg(wav_path);
    c.args(["-af", &filter, "-ar", "48000"]);
    c.args(codec);
    c.args(["-f", fmt]);
    c.arg(out_part);
    c.stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = c.spawn().map_err(|e| AppError::Ffmpeg(format!("ffmpeg 啟動失敗：{e}")))?;
    let stdout = child.stdout.take().expect("stdout");
    let mut stderr = child.stderr.take().expect("stderr");
    let err_task = tokio::spawn(async move {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s).await;
        s
    });
    let total_us = (total_frames as f64 / SR as f64 * 1_000_000.0).max(1.0);
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.start_kill();
            return Err(AppError::Canceled);
        }
        if let Some(v) = line.strip_prefix("out_time_us=") {
            if let Ok(us) = v.trim().parse::<f64>() {
                emit_progress(app, job_id, "encode", (us / total_us * 100.0) as f32);
            }
        }
    }
    let status = child.wait().await?;
    let err = err_task.await.unwrap_or_default();
    if !status.success() {
        return Err(AppError::Ffmpeg(format!("編碼失敗：{}", err.lines().filter(|l| !l.trim().is_empty()).last().unwrap_or("").trim())));
    }
    let stats = parse_loudnorm_json(&err);
    Ok((stats.as_ref().and_then(|s| s.output_i), stats.as_ref().and_then(|s| s.output_tp)))
}

/// 整條輸出流程（背景任務呼叫）。
pub async fn run(app: AppHandle, bins: FfmpegBins, src: String, plan: RenderPlan, work_dir: PathBuf, job_id: String, cancel: Arc<AtomicBool>) -> RenderDone {
    let t0 = Instant::now();
    let out_path = PathBuf::from(&plan.out_path);
    let out_part = PathBuf::from(format!("{}.part", plan.out_path));
    let wav_path = work_dir.join(format!("concat-{job_id}.wav"));
    let result: AppResult<(Option<f64>, Option<f64>, f64)> = async {
        if plan.segs.is_empty() {
            return Err(AppError::Invalid("沒有可輸出的保留段".into()));
        }
        if let Some(dir) = out_path.parent() {
            tokio::fs::create_dir_all(dir).await?;
        }
        let total = total_out_frames(&plan);
        cut_to_wav(&app, &bins, &src, &plan, &wav_path, &job_id, &cancel).await?;
        emit_progress(&app, &job_id, "measure", 0.0);
        let m = measure(&bins, &wav_path, &plan, &cancel).await?;
        emit_progress(&app, &job_id, "measure", 100.0);
        let (oi, otp) = encode(&app, &bins, &wav_path, &plan, &m, &out_part, total, &job_id, &cancel).await?;
        tokio::fs::rename(&out_part, &out_path).await?;
        Ok((oi, otp, m.input_i))
    }
    .await;
    let _ = tokio::fs::remove_file(&wav_path).await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&out_part).await;
    }
    match result {
        Ok((oi, otp, ii)) => RenderDone { job_id, ok: true, out_path: Some(plan.out_path), error: None, input_lufs: Some(ii), output_lufs: oi, output_tp: otp, elapsed_ms: t0.elapsed().as_millis() as u64 },
        Err(e) => RenderDone { job_id, ok: false, out_path: None, error: Some(e.message()), input_lufs: None, output_lufs: None, output_tp: None, elapsed_ms: t0.elapsed().as_millis() as u64 },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(segs: &[(f64, f64, f64)], joins: &[(&str, f64)]) -> RenderPlan {
        RenderPlan {
            segs: segs.iter().map(|&(a, b, g)| RenderSeg { src_start_ms: a, src_end_ms: b, gain_db: g }).collect(),
            joins: joins.iter().map(|&(k, ms)| RenderJoin { kind: k.into(), ms }).collect(),
            crossfade_ms: 20.0,
            target_lufs: -16.0,
            true_peak_dbtp: -1.5,
            format: "wav".into(),
            out_path: String::new(),
            channels: 1,
        }
    }

    fn run_cutter(p: &RenderPlan, frames: u64) -> Vec<f32> {
        let spec = hound::WavSpec { channels: 1, sample_rate: SR, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
        let path = std::env::temp_dir().join(format!("aicut-cutter-{}.wav", uuid::Uuid::new_v4()));
        let w = hound::WavWriter::create(&path, spec).unwrap();
        let mut c = Cutter::new(p, w);
        let mut seed = 1u32;
        for t in 0..frames {
            // 1 kHz 正弦 @0.5
            let v = 0.5 * (2.0 * std::f32::consts::PI * 1000.0 * t as f32 / SR as f32).sin();
            c.push(&[v], &mut seed).unwrap();
        }
        let written = c.finish().unwrap();
        let mut r = hound::WavReader::open(&path).unwrap();
        let out: Vec<f32> = r.samples::<f32>().map(|s| s.unwrap()).collect();
        let _ = std::fs::remove_file(&path);
        assert_eq!(out.len() as u64, written);
        out
    }

    #[test]
    fn keeps_two_segments_and_crossfades_between() {
        // 0–100ms 與 200–300ms，中間 crossfade 20ms → 輸出長度 = 100+100 − 0（crossfade 是重疊 20ms tail）
        let p = plan(&[(0.0, 100.0, 0.0), (200.0, 300.0, 0.0)], &[("crossfade", 20.0)]);
        let out = run_cutter(&p, ms_to_frames(400.0));
        let expect = ms_to_frames(100.0) + ms_to_frames(100.0) - ms_to_frames(20.0);
        assert_eq!(out.len() as u64, expect);
        assert!(out.iter().any(|v| v.abs() > 0.3));
    }

    #[test]
    fn gap_join_inserts_room_tone() {
        let p = plan(&[(0.0, 100.0, 0.0), (200.0, 300.0, 0.0)], &[("gap", 150.0)]);
        let out = run_cutter(&p, ms_to_frames(400.0));
        let expect = ms_to_frames(100.0) + ms_to_frames(150.0) + ms_to_frames(100.0);
        assert_eq!(out.len() as u64, expect);
        // gap 區段很安靜
        let gap_start = ms_to_frames(100.0) as usize;
        let gap_mid = &out[gap_start + 1000..gap_start + 2000];
        assert!(gap_mid.iter().all(|v| v.abs() < 0.01));
    }

    #[test]
    fn gain_is_applied() {
        let p = plan(&[(0.0, 100.0, -6.02)], &[]);
        let out = run_cutter(&p, ms_to_frames(200.0));
        let peak = out.iter().fold(0f32, |m, v| m.max(v.abs()));
        assert!((peak - 0.25).abs() < 0.02, "peak={peak}");
    }

    #[test]
    fn parses_loudnorm_json() {
        let s = "junk\n[Parsed_loudnorm_0 @ 0x1]\n{\n\t\"input_i\" : \"-23.50\",\n\t\"input_tp\" : \"-5.10\",\n\t\"input_lra\" : \"7.20\",\n\t\"input_thresh\" : \"-33.90\",\n\t\"output_i\" : \"-16.02\",\n\t\"output_tp\" : \"-1.50\",\n\t\"target_offset\" : \"0.12\"\n}\n";
        let m = parse_loudnorm_json(s).unwrap();
        assert_eq!(m.input_i, -23.5);
        assert_eq!(m.output_tp, Some(-1.5));
        assert_eq!(m.target_offset, 0.12);
        // Windows 行尾 + 後面還有其他輸出
        let s2 = s.replace('\n', "\r\n") + "size=N/A time=00:00:10.00\r\n";
        let m2 = parse_loudnorm_json(&s2).unwrap();
        assert_eq!(m2.input_lra, 7.2);
        assert!(parse_loudnorm_json("nothing here").is_none());
    }
}
