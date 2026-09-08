//! 麥克風錄音的落地：WebView 端 AudioWorklet 吐 f32le PCM（raw-body IPC），這裡逐包寫進 wav。
//!
//! 為什麼不用 MediaRecorder（webm/opus 有損、時戳飄、還要多轉一次）也不用 dshow（裝置名在地化、
//! 100–300 ms 延遲、無法監聽）：WebView2 的 getUserMedia 拿到的就是原始 PCM，直接寫 24-bit wav。
//! 寫 `.part`，stop 才 rename；cancel 刪掉。每包長度必須是 4 × 聲道數的倍數，否則是錯誤。
use std::collections::HashMap;
use std::fs::File;
use std::io::BufWriter;
use std::path::PathBuf;

use parking_lot::Mutex;
use serde::Serialize;

use crate::error::{AppError, AppResult};

pub struct RecordJob {
    writer: hound::WavWriter<BufWriter<File>>,
    part: PathBuf,
    out: PathBuf,
    channels: u16,
    sample_rate: u32,
    frames: u64,
    peak: f32,
    clipped: u64,
}

pub type RecordRegistry = Mutex<HashMap<String, RecordJob>>;

#[derive(Debug, Clone, Serialize)]
pub struct RecordDone {
    pub path: String,
    pub duration_ms: f64,
    pub frames: u64,
    pub peak_dbfs: f64,
    pub clipped_frames: u64,
}

const CLIP: f32 = 0.9885; // −0.1 dBFS

pub fn start(reg: &RecordRegistry, job_id: &str, out_path: &str, sample_rate: u32, channels: u32) -> AppResult<()> {
    let ch = channels.clamp(1, 2) as u16;
    let sr = sample_rate.clamp(8000, 192_000);
    let out = PathBuf::from(out_path);
    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let part = PathBuf::from(format!("{out_path}.part"));
    let spec = hound::WavSpec { channels: ch, sample_rate: sr, bits_per_sample: 24, sample_format: hound::SampleFormat::Int };
    let file = File::create(&part)?;
    let writer = hound::WavWriter::new(BufWriter::new(file), spec).map_err(|e| AppError::Io(format!("建立錄音檔失敗：{e}")))?;
    let mut map = reg.lock();
    if map.contains_key(job_id) {
        return Err(AppError::Invalid("這個錄音 job 已經在進行中".into()));
    }
    map.insert(job_id.to_string(), RecordJob { writer, part, out, channels: ch, sample_rate: sr, frames: 0, peak: 0.0, clipped: 0 });
    Ok(())
}

/// 寫一包 f32le（交錯）。回目前累計的 frame 數。
pub fn write(reg: &RecordRegistry, job_id: &str, bytes: &[u8]) -> AppResult<u64> {
    let mut map = reg.lock();
    let job = map.get_mut(job_id).ok_or_else(|| AppError::NotFound("沒有這個錄音 job".into()))?;
    let frame_bytes = 4 * job.channels as usize;
    if bytes.len() % frame_bytes != 0 {
        return Err(AppError::Invalid(format!("PCM 長度 {} 不是 {} 的倍數", bytes.len(), frame_bytes)));
    }
    for sb in bytes.chunks_exact(4) {
        let v = f32::from_le_bytes([sb[0], sb[1], sb[2], sb[3]]);
        let v = if v.is_finite() { v } else { 0.0 };
        let a = v.abs();
        if a > job.peak {
            job.peak = a;
        }
        if a >= CLIP {
            job.clipped += 1;
        }
        let q = (v.clamp(-1.0, 1.0) * 8_388_607.0).round() as i32;
        job.writer.write_sample(q).map_err(|e| AppError::Io(format!("寫錄音檔失敗：{e}")))?;
    }
    job.frames += (bytes.len() / frame_bytes) as u64;
    Ok(job.frames)
}

pub fn stop(reg: &RecordRegistry, job_id: &str) -> AppResult<RecordDone> {
    let job = reg.lock().remove(job_id).ok_or_else(|| AppError::NotFound("沒有這個錄音 job".into()))?;
    let RecordJob { writer, part, out, channels, sample_rate, frames, peak, clipped } = job;
    writer.finalize().map_err(|e| AppError::Io(format!("關閉錄音檔失敗：{e}")))?;
    std::fs::rename(&part, &out)?;
    let clipped_frames = clipped / channels as u64;
    Ok(RecordDone {
        path: out.to_string_lossy().into_owned(),
        duration_ms: frames as f64 * 1000.0 / sample_rate as f64,
        frames,
        peak_dbfs: if peak <= 1e-6 { -120.0 } else { 20.0 * (peak as f64).log10() },
        clipped_frames,
    })
}

pub fn cancel(reg: &RecordRegistry, job_id: &str) {
    if let Some(job) = reg.lock().remove(job_id) {
        let part = job.part.clone();
        drop(job);
        let _ = std::fs::remove_file(part);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("aicut-rec-{}-{name}", uuid::Uuid::new_v4()))
    }

    fn bytes_of(samples: &[f32]) -> Vec<u8> {
        samples.iter().flat_map(|v| v.to_le_bytes()).collect()
    }

    #[test]
    fn exact_frame_count_peak_and_clipping() {
        let reg = RecordRegistry::default();
        let out = tmp("a.wav");
        start(&reg, "j1", out.to_str().unwrap(), 48_000, 1).unwrap();
        assert_eq!(write(&reg, "j1", &bytes_of(&[0.0, 0.5, -0.25])).unwrap(), 3);
        assert_eq!(write(&reg, "j1", &bytes_of(&[1.0, 0.99, 0.1])).unwrap(), 6);
        let done = stop(&reg, "j1").unwrap();
        assert_eq!(done.frames, 6);
        assert!((done.duration_ms - 0.125).abs() < 1e-9, "6 frame @ 48k = 0.125 ms");
        assert!((done.peak_dbfs - 0.0).abs() < 1e-6);
        assert_eq!(done.clipped_frames, 2);
        let r = hound::WavReader::open(&out).unwrap();
        assert_eq!(r.spec().bits_per_sample, 24);
        assert_eq!(r.len(), 6);
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn odd_length_is_rejected_and_stereo_counts_frames() {
        let reg = RecordRegistry::default();
        let out = tmp("b.wav");
        start(&reg, "j2", out.to_str().unwrap(), 44_100, 2).unwrap();
        assert!(write(&reg, "j2", &[0u8; 6]).is_err());
        assert!(write(&reg, "j2", &bytes_of(&[0.1, 0.2, 0.3])).is_err(), "3 個樣本不是 2 聲道的整數 frame");
        assert_eq!(write(&reg, "j2", &bytes_of(&[0.1, 0.2, 0.3, 0.4])).unwrap(), 2);
        let done = stop(&reg, "j2").unwrap();
        assert_eq!(done.frames, 2);
        let _ = std::fs::remove_file(&out);
    }

    #[test]
    fn cancel_removes_the_part_file() {
        let reg = RecordRegistry::default();
        let out = tmp("c.wav");
        start(&reg, "j3", out.to_str().unwrap(), 48_000, 1).unwrap();
        write(&reg, "j3", &bytes_of(&[0.1; 100])).unwrap();
        let part = PathBuf::from(format!("{}.part", out.to_str().unwrap()));
        assert!(part.is_file());
        cancel(&reg, "j3");
        assert!(!part.is_file());
        assert!(stop(&reg, "j3").is_err());
    }
}
