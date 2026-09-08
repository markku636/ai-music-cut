//! 轉檔（含批次、從影片抽聲軌）：一個檔 → 一個檔，格式 / 取樣率 / 聲道 / 位元深度可選，
//! 可選「正規化到目標響度」（與 render 同一套 loudnorm 兩趟線性）。
//!
//! 能直接複製就不重編（同編碼器、不改取樣率 / 聲道、不做響度）：mp4 / mkv 裡的 aac → m4a
//! 或 opus → opus 是零損失、幾百毫秒的事。章節只帶進支援的容器，其他的列在 `dropped` 裡回報。
use std::path::{Path, PathBuf};
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::ffmpeg::{AudioStream, FfmpegBins};
use crate::formats;
use crate::proc;
use crate::render::{parse_loudnorm_json, LoudnormStats};

fn default_tp() -> f64 {
    -1.5
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConvertSpec {
    pub src: String,
    pub out_path: String,
    /// mp3 | m4a | wav | flac | ogg | opus | aiff（小寫）
    pub format: String,
    /// 0 = 沿用來源
    #[serde(default)]
    pub sample_rate: u32,
    /// 0 = 沿用來源
    #[serde(default)]
    pub channels: u32,
    /// 0 = 預設（16）
    #[serde(default)]
    pub bit_depth: u32,
    /// Some = 正規化到這個 LUFS（兩趟線性）
    #[serde(default)]
    pub target_lufs: Option<f64>,
    #[serde(default = "default_tp")]
    pub true_peak_dbtp: f64,
    /// 能直接複製就不重編（同編碼器、不改取樣率 / 聲道、不做響度）
    #[serde(default)]
    pub copy_if_possible: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConvertDone {
    pub out_path: String,
    /// true = `-c:a copy`，沒有重新編碼
    pub copied: bool,
    pub input_lufs: Option<f64>,
    pub output_lufs: Option<f64>,
    /// 沒帶進成品的東西（章節…）
    pub dropped: Vec<String>,
    pub elapsed_ms: u64,
}

/// 純決策：這一趟要怎麼做。
#[derive(Debug, Clone, PartialEq)]
pub struct ConvertPlan {
    pub copy: bool,
    pub muxer: &'static str,
    /// 編碼參數（copy 時是 `-c:a copy`）
    pub codec: Vec<String>,
    /// `-ar` / `-ac`（沿用來源時為空）
    pub resample: Vec<String>,
    pub needs_measure: bool,
    pub map_chapters: bool,
    pub dropped: Vec<String>,
}

pub fn can_copy(spec: &ConvertSpec, audio: Option<&AudioStream>) -> bool {
    let Some(a) = audio else { return false };
    spec.copy_if_possible
        && spec.target_lufs.is_none()
        && (spec.sample_rate == 0 || spec.sample_rate == a.sample_rate)
        && (spec.channels == 0 || spec.channels == a.channels)
        && formats::format_of_codec(&a.codec) == Some(spec.format.as_str())
}

pub fn plan(spec: &ConvertSpec, audio: Option<&AudioStream>, has_chapters: bool) -> AppResult<ConvertPlan> {
    if spec.src == spec.out_path {
        return Err(AppError::Invalid("輸出路徑不能跟來源一樣（會把原檔蓋掉）".into()));
    }
    let (muxer, codec) = formats::codec_args(&spec.format, spec.bit_depth)?;
    let copy = can_copy(spec, audio);
    let mut resample = Vec::new();
    let mut dropped = Vec::new();
    if !copy {
        // 重編一律明講 -ar：loudnorm 內部跑 192 kHz，沒指定就會用 192 kHz（m4a 96 kHz）寫出去。
        // 「沿用來源」= probe 到的取樣率；probe 不到又要正規化就用 48 kHz。
        let mut ar = if spec.sample_rate > 0 { spec.sample_rate.clamp(8000, 192_000) } else { audio.map(|a| a.sample_rate).unwrap_or(0) };
        if ar == 0 && spec.target_lufs.is_some() {
            ar = 48_000;
        }
        // libopus 只收 8 / 12 / 16 / 24 / 48 kHz，其他值 ffmpeg 連編碼器都開不起來（而且錯誤訊息在 stderr 前段看不到）
        if spec.format == "opus" && !matches!(ar, 8000 | 12_000 | 16_000 | 24_000 | 48_000) {
            if ar > 0 {
                dropped.push(format!("取樣率 {} Hz（Opus 只能 8 / 12 / 16 / 24 / 48 kHz，已改用 48 kHz）", ar));
            }
            ar = 48_000;
        }
        if ar > 0 {
            resample.push("-ar".to_string());
            resample.push(ar.to_string());
        }
        if spec.channels > 0 {
            resample.push("-ac".to_string());
            resample.push(spec.channels.clamp(1, 2).to_string());
        }
    }
    let map_chapters = formats::supports_chapters(&spec.format);
    if has_chapters && !map_chapters {
        dropped.push("章節".to_string());
    }
    Ok(ConvertPlan {
        copy,
        muxer,
        codec: if copy { vec!["-c:a".into(), "copy".into()] } else { codec },
        resample,
        needs_measure: spec.target_lufs.is_some() && !copy,
        map_chapters,
        dropped,
    })
}

fn tail(stderr: &[u8]) -> String {
    let s = String::from_utf8_lossy(stderr);
    let t: Vec<&str> = s.lines().map(str::trim).filter(|l| !l.is_empty()).rev().take(3).collect();
    t.into_iter().rev().collect::<Vec<_>>().join(" / ")
}

async fn measure(bins: &FfmpegBins, src: &str, target: f64, tp: f64) -> AppResult<LoudnormStats> {
    let mut c = proc::cmd(&bins.ffmpeg);
    c.args(["-nostdin", "-hide_banner", "-i"]);
    c.arg(src);
    c.args(["-vn", "-af", &format!("loudnorm=I={target:.1}:TP={tp:.1}:LRA=11:print_format=json"), "-f", "null", "-"]);
    let o = c.output().await.map_err(|e| AppError::Ffmpeg(format!("ffmpeg 啟動失敗：{e}")))?;
    if !o.status.success() {
        return Err(AppError::Ffmpeg(format!("響度量測失敗：{}", tail(&o.stderr))));
    }
    parse_loudnorm_json(&String::from_utf8_lossy(&o.stderr)).ok_or_else(|| AppError::Ffmpeg("loudnorm 量測沒有輸出 JSON".into()))
}

/// 轉一個檔。`audio` 是來源的 ffprobe 音訊串流（決定能不能直接複製）；`has_chapters` 是來源有沒有章節。
pub async fn convert_file(bins: &FfmpegBins, spec: &ConvertSpec, audio: Option<&AudioStream>, has_chapters: bool) -> AppResult<ConvertDone> {
    let t0 = Instant::now();
    let p = plan(spec, audio, has_chapters)?;
    let out = PathBuf::from(&spec.out_path);
    if let Some(dir) = out.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let part = PathBuf::from(format!("{}.part", spec.out_path));
    let measured = if p.needs_measure { Some(measure(bins, &spec.src, spec.target_lufs.unwrap_or(-16.0), spec.true_peak_dbtp).await?) } else { None };

    let mut c = proc::cmd(&bins.ffmpeg);
    c.args(["-nostdin", "-hide_banner", "-loglevel", "info", "-nostats", "-y", "-i"]);
    c.arg(&spec.src);
    c.args(["-vn", "-map", "0:a:0"]);
    c.args(["-map_chapters", if p.map_chapters { "0" } else { "-1" }]);
    if let Some(m) = &measured {
        let limit = 10f64.powf(spec.true_peak_dbtp / 20.0);
        let af = format!(
            "loudnorm=I={:.1}:TP={:.1}:LRA=11:measured_I={:.2}:measured_TP={:.2}:measured_LRA={:.2}:measured_thresh={:.2}:offset={:.2}:linear=true:print_format=json,alimiter=limit={:.4}:attack=5:release=50:level=false",
            spec.target_lufs.unwrap_or(-16.0),
            spec.true_peak_dbtp,
            m.input_i,
            m.input_tp,
            m.input_lra,
            m.input_thresh,
            m.target_offset,
            limit
        );
        c.args(["-af", &af]);
    }
    for a in &p.resample {
        c.arg(a);
    }
    for a in &p.codec {
        c.arg(a);
    }
    c.args(["-f", p.muxer]);
    c.arg(&part);
    let o = c.output().await.map_err(|e| AppError::Ffmpeg(format!("ffmpeg 啟動失敗：{e}")))?;
    if !o.status.success() {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(AppError::Ffmpeg(format!("轉檔失敗：{}", tail(&o.stderr))));
    }
    tokio::fs::rename(&part, &out).await?;
    let stats = parse_loudnorm_json(&String::from_utf8_lossy(&o.stderr));
    Ok(ConvertDone {
        out_path: spec.out_path.clone(),
        copied: p.copy,
        input_lufs: measured.as_ref().map(|m| m.input_i),
        output_lufs: stats.and_then(|s| s.output_i),
        dropped: p.dropped,
        elapsed_ms: t0.elapsed().as_millis() as u64,
    })
}

/// 來源有幾個章節（ffprobe -show_chapters）。失敗當 0 —— 這只影響「dropped」的回報。
pub async fn count_chapters(bins: &FfmpegBins, src: &str) -> usize {
    if bins.ffprobe.is_empty() {
        return 0;
    }
    let mut c = proc::cmd(&bins.ffprobe);
    c.args(["-v", "error", "-show_chapters", "-of", "json"]);
    c.arg(src);
    let Ok(o) = c.output().await else { return 0 };
    if !o.status.success() {
        return 0;
    }
    serde_json::from_slice::<serde_json::Value>(&o.stdout)
        .ok()
        .and_then(|v| v.get("chapters").and_then(|c| c.as_array()).map(|a| a.len()))
        .unwrap_or(0)
}

/// 輸出檔名撞到來源時加 `_converted`（前端也有一份同規則，這裡是最後防線）。
#[allow(dead_code)]
pub fn safe_out_path(src: &Path, out: &Path) -> PathBuf {
    if src == out {
        let stem = out.file_stem().and_then(|s| s.to_str()).unwrap_or("out");
        let ext = out.extension().and_then(|s| s.to_str()).unwrap_or("");
        return out.with_file_name(format!("{stem}_converted.{ext}"));
    }
    out.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(format: &str) -> ConvertSpec {
        ConvertSpec { src: "a.mp4".into(), out_path: "a.m4a".into(), format: format.into(), sample_rate: 0, channels: 0, bit_depth: 0, target_lufs: None, true_peak_dbtp: -1.5, copy_if_possible: true }
    }
    fn aac() -> AudioStream {
        AudioStream { codec: "aac".into(), sample_rate: 48_000, channels: 2, bit_rate: Some(128_000) }
    }

    #[test]
    fn can_copy_truth_table() {
        assert!(can_copy(&spec("m4a"), Some(&aac())), "mp4(aac) → m4a 直接複製");
        assert!(!can_copy(&spec("mp3"), Some(&aac())), "換編碼器不能複製");
        assert!(!can_copy(&ConvertSpec { target_lufs: Some(-16.0), ..spec("m4a") }, Some(&aac())), "要正規化不能複製");
        assert!(!can_copy(&ConvertSpec { sample_rate: 44_100, ..spec("m4a") }, Some(&aac())), "改取樣率不能複製");
        assert!(!can_copy(&ConvertSpec { channels: 1, ..spec("m4a") }, Some(&aac())), "改聲道不能複製");
        assert!(can_copy(&ConvertSpec { sample_rate: 48_000, channels: 2, ..spec("m4a") }, Some(&aac())), "跟來源一樣就可以");
        assert!(!can_copy(&ConvertSpec { copy_if_possible: false, ..spec("m4a") }, Some(&aac())));
        assert!(!can_copy(&spec("m4a"), None), "沒 probe 到音訊就重編");
    }

    #[test]
    fn plan_golden() {
        let p = plan(&spec("m4a"), Some(&aac()), true).unwrap();
        assert_eq!(p, ConvertPlan { copy: true, muxer: "mp4", codec: vec!["-c:a".into(), "copy".into()], resample: vec![], needs_measure: false, map_chapters: true, dropped: vec![] });
        let p = plan(&ConvertSpec { target_lufs: Some(-16.0), sample_rate: 44_100, channels: 1, ..spec("flac") }, Some(&aac()), true).unwrap();
        assert_eq!(p.copy, false);
        assert_eq!(p.muxer, "flac");
        assert_eq!(p.codec.join(" "), "-c:a flac -sample_fmt s16 -compression_level 8");
        assert_eq!(p.resample, vec!["-ar", "44100", "-ac", "1"]);
        assert!(p.needs_measure && !p.map_chapters);
        assert_eq!(p.dropped, vec!["章節"]);
    }

    #[test]
    fn sample_rate_is_always_explicit_when_re_encoding() {
        // 沿用來源 = probe 到的 48k；loudnorm 不會偷偷變 192k
        let p = plan(&ConvertSpec { target_lufs: Some(-16.0), ..spec("wav") }, Some(&aac()), false).unwrap();
        assert_eq!(p.resample, vec!["-ar", "48000"]);
        // 沒 probe 到又要正規化 → 48k
        let p = plan(&ConvertSpec { target_lufs: Some(-16.0), ..spec("wav") }, None, false).unwrap();
        assert_eq!(p.resample, vec!["-ar", "48000"]);
        // 沒 probe 到、不正規化 → 交給 ffmpeg 沿用
        let p = plan(&spec("mp3"), None, false).unwrap();
        assert!(p.resample.is_empty());
        // Opus 44.1k → 48k 並明講
        let p = plan(&ConvertSpec { sample_rate: 44_100, ..spec("opus") }, Some(&aac()), false).unwrap();
        assert_eq!(p.resample, vec!["-ar", "48000"]);
        assert_eq!(p.dropped.len(), 1);
        assert!(p.dropped[0].contains("44100"));
        let p = plan(&ConvertSpec { sample_rate: 24_000, ..spec("opus") }, Some(&aac()), false).unwrap();
        assert_eq!(p.resample, vec!["-ar", "24000"]);
        assert!(p.dropped.is_empty());
    }

    #[test]
    fn rejects_out_equals_src_and_unknown_format() {
        assert!(plan(&ConvertSpec { out_path: "a.mp4".into(), ..spec("m4a") }, None, false).is_err());
        assert!(plan(&spec("wma"), None, false).is_err());
        assert_eq!(safe_out_path(Path::new("x/a.mp3"), Path::new("x/a.mp3")), PathBuf::from("x/a_converted.mp3"));
        assert_eq!(safe_out_path(Path::new("x/a.mp3"), Path::new("x/a.flac")), PathBuf::from("x/a.flac"));
    }
}
