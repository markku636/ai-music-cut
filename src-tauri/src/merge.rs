//! 合併檔案：幾個音檔接成一個（留白或交越），輸出 48k 24-bit wav 放在第一個檔旁邊，
//! 要別的格式再走 convert（一條編碼路徑）。
//!
//! 不能拿 reel.ts 當底：它只裁**同一個媒體**的 units，RenderPlan.src 是單一路徑。
//! 這裡是多輸入的 filter graph：每輸入 aresample + aformat + volume，gap 用 apad + concat，
//! crossfade 用 acrossfade 成對串接。輸入超過 40 個改寫 `-filter_complex_script` 檔，避開 Windows 32 k 命令列上限。
use std::path::PathBuf;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::ffmpeg::FfmpegBins;
use crate::proc;

#[derive(Debug, Clone, Deserialize)]
pub struct MergeInput {
    pub path: String,
    #[serde(default)]
    pub gain_db: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MergeSpec {
    pub inputs: Vec<MergeInput>,
    /// gap | crossfade
    pub join: String,
    /// gap：留白長度；crossfade：交越長度（毫秒）
    #[serde(default)]
    pub join_ms: f64,
    /// 1 | 2
    #[serde(default = "one")]
    pub channels: u32,
    pub out_path: String,
}

fn one() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize)]
pub struct MergeDone {
    pub out_path: String,
    pub elapsed_ms: u64,
}

/// 命令列上限：輸入超過這個數就把 filter graph 寫成檔案。
pub const SCRIPT_THRESHOLD: usize = 40;

pub fn use_script(n_inputs: usize) -> bool {
    n_inputs > SCRIPT_THRESHOLD
}

/// 純函式：組 filter graph（golden 測試）。
pub fn filter_graph(spec: &MergeSpec) -> AppResult<String> {
    let n = spec.inputs.len();
    if n < 2 {
        return Err(AppError::Invalid("至少要兩個檔案才能合併".into()));
    }
    let layout = if spec.channels >= 2 { "stereo" } else { "mono" };
    let mut parts: Vec<String> = Vec::new();
    for (i, inp) in spec.inputs.iter().enumerate() {
        let g = inp.gain_db.clamp(-40.0, 20.0);
        parts.push(format!("[{i}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts={layout},volume={g:.2}dB[a{i}]"));
    }
    match spec.join.as_str() {
        "crossfade" => {
            let d = (spec.join_ms.max(0.0) / 1000.0).clamp(0.01, 30.0);
            let mut prev = "a0".to_string();
            for i in 1..n {
                let out = if i + 1 == n { "out".to_string() } else { format!("x{i}") };
                parts.push(format!("[{prev}][a{i}]acrossfade=d={d:.3}:c1=tri:c2=tri[{out}]"));
                prev = out;
            }
        }
        _ => {
            let gap = (spec.join_ms.max(0.0) / 1000.0).min(600.0);
            let mut labels = String::new();
            for i in 0..n {
                if gap > 0.0 && i + 1 < n {
                    parts.push(format!("[a{i}]apad=pad_dur={gap:.3}[p{i}]"));
                    labels.push_str(&format!("[p{i}]"));
                } else {
                    labels.push_str(&format!("[a{i}]"));
                }
            }
            parts.push(format!("{labels}concat=n={n}:v=0:a=1[out]"));
        }
    }
    Ok(parts.join(";"))
}

pub async fn merge_files(bins: &FfmpegBins, spec: &MergeSpec) -> AppResult<MergeDone> {
    let t0 = Instant::now();
    let graph = filter_graph(spec)?;
    let out = PathBuf::from(&spec.out_path);
    if spec.inputs.iter().any(|i| i.path == spec.out_path) {
        return Err(AppError::Invalid("輸出路徑不能跟任何一個來源一樣".into()));
    }
    if let Some(dir) = out.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let part = PathBuf::from(format!("{}.part", spec.out_path));
    let mut c = proc::cmd(&bins.ffmpeg);
    c.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y"]);
    for i in &spec.inputs {
        c.arg("-i");
        c.arg(&i.path);
    }
    let script = if use_script(spec.inputs.len()) {
        let p = PathBuf::from(format!("{}.filter.txt", spec.out_path));
        tokio::fs::write(&p, graph.as_bytes()).await?;
        c.arg("-filter_complex_script");
        c.arg(&p);
        Some(p)
    } else {
        c.args(["-filter_complex", &graph]);
        None
    };
    c.args(["-map", "[out]", "-vn", "-ar", "48000", "-ac", &spec.channels.clamp(1, 2).to_string(), "-c:a", "pcm_s24le", "-f", "wav"]);
    c.arg(&part);
    let o = c.output().await.map_err(|e| AppError::Ffmpeg(format!("ffmpeg 啟動失敗：{e}")))?;
    if let Some(p) = script {
        let _ = tokio::fs::remove_file(&p).await;
    }
    if !o.status.success() {
        let _ = tokio::fs::remove_file(&part).await;
        let s = String::from_utf8_lossy(&o.stderr);
        let tail: Vec<&str> = s.lines().map(str::trim).filter(|l| !l.is_empty()).rev().take(3).collect();
        return Err(AppError::Ffmpeg(format!("合併失敗：{}", tail.into_iter().rev().collect::<Vec<_>>().join(" / "))));
    }
    tokio::fs::rename(&part, &out).await?;
    Ok(MergeDone { out_path: spec.out_path.clone(), elapsed_ms: t0.elapsed().as_millis() as u64 })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(n: usize, join: &str, ms: f64) -> MergeSpec {
        MergeSpec {
            inputs: (0..n).map(|i| MergeInput { path: format!("{i}.wav"), gain_db: if i == 1 { -3.0 } else { 0.0 } }).collect(),
            join: join.into(),
            join_ms: ms,
            channels: 1,
            out_path: "out.wav".into(),
        }
    }

    #[test]
    fn two_inputs_gap_golden() {
        assert_eq!(
            filter_graph(&spec(2, "gap", 500.0)).unwrap(),
            "[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,volume=0.00dB[a0];[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=mono,volume=-3.00dB[a1];[a0]apad=pad_dur=0.500[p0];[p0][a1]concat=n=2:v=0:a=1[out]"
        );
    }

    #[test]
    fn gap_zero_is_plain_concat() {
        let g = filter_graph(&spec(3, "gap", 0.0)).unwrap();
        assert!(!g.contains("apad"));
        assert!(g.ends_with("[a0][a1][a2]concat=n=3:v=0:a=1[out]"));
    }

    #[test]
    fn three_inputs_crossfade_golden() {
        let g = filter_graph(&spec(3, "crossfade", 120.0)).unwrap();
        assert!(g.ends_with("[a0][a1]acrossfade=d=0.120:c1=tri:c2=tri[x1];[x1][a2]acrossfade=d=0.120:c1=tri:c2=tri[out]"), "{g}");
    }

    #[test]
    fn stereo_layout_and_gain_clamp() {
        let mut s = spec(2, "gap", 0.0);
        s.channels = 2;
        s.inputs[0].gain_db = 99.0;
        let g = filter_graph(&s).unwrap();
        assert!(g.contains("channel_layouts=stereo,volume=20.00dB[a0]"));
    }

    #[test]
    fn needs_two_inputs_and_switches_to_script_past_40() {
        assert!(filter_graph(&spec(1, "gap", 0.0)).is_err());
        assert!(!use_script(40));
        assert!(use_script(41));
    }
}
