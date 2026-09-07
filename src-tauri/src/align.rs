//! 時間對齊的渲染（VocALign 的 Dub 扭到 Guide 上）：單趟、一個 atempo、asendcmd 驅動。
//!
//! 前端（analysis/align/*）算出「dub 的哪一段要用什麼速率」；這裡只把它變成一條 ffmpeg 濾鏡鏈：
//!   [offset：adelay 或 atrim] → asetnsamples=240（5 ms 一格，指令落在格線上）→ asendcmd=f=<cmds> → atempo=<初始速率>
//! 指令檔每段一行 `t atempo tempo r;`（atempo 支援 runtime 的 tempo 指令）。
//! 避開 asplit fan-out（晚開始的分支會在 FIFO 裡累積整個後半段）與幾百段串接的 32 k 命令列。
//! 輸出 `<dub>_aligned.wav`（pcm_s24le 48k），原檔不動。
use std::path::PathBuf;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::ffmpeg::FfmpegBins;
use crate::proc;

#[derive(Debug, Clone, Deserialize)]
pub struct AlignSegment {
    /// 這一段從 dub 的哪裡開始（毫秒，原始 dub 時間）。
    pub dub_start_ms: f64,
    /// atempo 的 tempo（> 1 縮短、< 1 拉長）。前端已 clamp 0.5–2。
    pub tempo: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AlignSpec {
    pub src: String,
    pub out_path: String,
    /// dub 相對 guide 的位移：正 = dub 要往後推（前面補靜音）；負 = 砍掉 dub 開頭。
    pub offset_ms: f64,
    /// 依 dub_start_ms 排序；空 = 只做位移。
    #[serde(default)]
    pub segments: Vec<AlignSegment>,
    #[serde(default = "one")]
    pub channels: u32,
}

fn one() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize)]
pub struct AlignDone {
    pub out_path: String,
    pub elapsed_ms: u64,
}

/// 純決策：濾鏡鏈與指令檔內容。
#[derive(Debug, Clone, PartialEq)]
pub struct AlignPlan {
    /// 不含 asendcmd 檔名（呼叫端把 `{CMDS}` 換成實際路徑）。
    pub filter: String,
    /// asendcmd 檔內容；空字串 = 不需要指令檔。
    pub commands: String,
    pub initial_tempo: f64,
}

fn clamp_tempo(t: f64) -> f64 {
    if t.is_finite() {
        t.clamp(0.5, 2.0)
    } else {
        1.0
    }
}

pub fn plan(spec: &AlignSpec) -> AppResult<AlignPlan> {
    if spec.src == spec.out_path {
        return Err(AppError::Invalid("輸出路徑不能跟來源一樣".into()));
    }
    let mut segs: Vec<&AlignSegment> = spec.segments.iter().collect();
    segs.sort_by(|a, b| a.dub_start_ms.partial_cmp(&b.dub_start_ms).unwrap_or(std::cmp::Ordering::Equal));
    // 位移之後的時間軸：t' = t + offset（adelay）或 t − |offset|（atrim）
    let offset = if spec.offset_ms.is_finite() { spec.offset_ms } else { 0.0 };
    let mut chain: Vec<String> = vec!["aresample=48000".to_string()];
    if offset >= 1.0 {
        chain.push(format!("adelay={}:all=1", offset.round() as i64));
    } else if offset <= -1.0 {
        chain.push(format!("atrim=start={:.3},asetpts=PTS-STARTPTS", -offset / 1000.0));
    }
    // 初始速率 = 位移後時間 0 所在的段；之後每一段在 t' > 0 時下指令
    let head_dub_ms = if offset < 0.0 { -offset } else { 0.0 };
    let mut initial = 1.0;
    for s in &segs {
        if s.dub_start_ms <= head_dub_ms + 1e-6 {
            initial = clamp_tempo(s.tempo);
        }
    }
    let mut lines: Vec<String> = Vec::new();
    for s in &segs {
        // 決定初始速率的那幾段不用再下指令（位移 > 0 時第一段會落在 t' > 0，但它就是初始值）
        if s.dub_start_ms <= head_dub_ms + 1e-6 {
            continue;
        }
        let t = s.dub_start_ms + offset;
        if t <= 0.0 {
            continue;
        }
        let tempo = clamp_tempo(s.tempo);
        lines.push(format!("{:.3} atempo tempo {:.5};", t / 1000.0, tempo));
    }
    if !lines.is_empty() {
        chain.push("asetnsamples=n=240:p=0".to_string());
        chain.push("asendcmd=f={CMDS}".to_string());
    }
    chain.push(format!("atempo={initial:.5}"));
    Ok(AlignPlan { filter: chain.join(","), commands: lines.join("\n"), initial_tempo: initial })
}

pub async fn render(bins: &FfmpegBins, spec: &AlignSpec) -> AppResult<AlignDone> {
    let t0 = Instant::now();
    let p = plan(spec)?;
    let out = PathBuf::from(&spec.out_path);
    if let Some(dir) = out.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let part = PathBuf::from(format!("{}.part", spec.out_path));
    // asendcmd 的檔名在濾鏡語法裡要跳脫 `:` 與 `\`（Windows 路徑兩個都有），跳脫層級很容易錯；
    // 改成把指令檔放在 temp 目錄、用安全的檔名，並把 ffmpeg 的工作目錄切過去 → 濾鏡裡只寫 basename。
    let cmds_dir = std::env::temp_dir();
    let cmds_name = format!("aicut-align-{}.cmds", uuid::Uuid::new_v4());
    let cmds = cmds_dir.join(&cmds_name);
    let filter = if p.commands.is_empty() {
        p.filter.clone()
    } else {
        tokio::fs::write(&cmds, p.commands.as_bytes()).await?;
        p.filter.replace("{CMDS}", &cmds_name)
    };
    let mut c = proc::cmd(&bins.ffmpeg);
    c.current_dir(&cmds_dir);
    c.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i"]);
    c.arg(std::path::absolute(&spec.src).unwrap_or_else(|_| PathBuf::from(&spec.src)));
    c.args(["-vn", "-af", &filter, "-ar", "48000", "-ac", &spec.channels.clamp(1, 2).to_string(), "-c:a", "pcm_s24le", "-f", "wav"]);
    c.arg(std::path::absolute(&part).unwrap_or_else(|_| part.clone()));
    let o = c.output().await.map_err(|e| AppError::Ffmpeg(format!("ffmpeg 啟動失敗：{e}")))?;
    let _ = tokio::fs::remove_file(&cmds).await;
    if !o.status.success() {
        let _ = tokio::fs::remove_file(&part).await;
        let s = String::from_utf8_lossy(&o.stderr);
        let tail: Vec<&str> = s.lines().map(str::trim).filter(|l| !l.is_empty()).rev().take(3).collect();
        return Err(AppError::Ffmpeg(format!("對齊輸出失敗：{}", tail.into_iter().rev().collect::<Vec<_>>().join(" / "))));
    }
    tokio::fs::rename(&part, &out).await?;
    Ok(AlignDone { out_path: spec.out_path.clone(), elapsed_ms: t0.elapsed().as_millis() as u64 })
}

/// A/B 試聽：guide 與另一軌（原 dub 或對齊後）同一段疊在一起（sum）或左右分開（split），mp3 q5。
/// **單一個檔**：兩個 <audio> 同播會抖 20–40 ms，正是要判斷的量級。
pub async fn preview_pair(bins: &FfmpegBins, guide: &str, other: &str, start_ms: f64, dur_ms: f64, split: bool, out: &std::path::Path) -> AppResult<()> {
    if let Some(dir) = out.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let ss = format!("{:.3}", start_ms.max(0.0) / 1000.0);
    let dur = format!("{:.3}", dur_ms.clamp(500.0, 60_000.0) / 1000.0);
    let graph = if split {
        "[0:a]aformat=channel_layouts=mono[l];[1:a]aformat=channel_layouts=mono[r];[l][r]join=inputs=2:channel_layout=stereo[out]"
    } else {
        "[0:a]aformat=channel_layouts=mono[l];[1:a]aformat=channel_layouts=mono[r];[l][r]amix=inputs=2:normalize=0[out]"
    };
    let mut c = proc::cmd(&bins.ffmpeg);
    c.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y"]);
    c.args(["-ss", &ss, "-t", &dur, "-i"]);
    c.arg(guide);
    c.args(["-ss", &ss, "-t", &dur, "-i"]);
    c.arg(other);
    c.args(["-filter_complex", graph, "-map", "[out]", "-ar", "48000", "-c:a", "libmp3lame", "-q:a", "5"]);
    c.arg(out);
    let o = c.output().await.map_err(|e| AppError::Ffmpeg(format!("ffmpeg 啟動失敗：{e}")))?;
    if !o.status.success() {
        return Err(AppError::Ffmpeg(format!("試聽失敗：{}", String::from_utf8_lossy(&o.stderr).trim())));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(offset: f64, segs: &[(f64, f64)]) -> AlignSpec {
        AlignSpec { src: "dub.wav".into(), out_path: "dub_aligned.wav".into(), offset_ms: offset, segments: segs.iter().map(|&(d, t)| AlignSegment { dub_start_ms: d, tempo: t }).collect(), channels: 1 }
    }

    #[test]
    fn offset_only_is_delay_or_trim_plus_identity_tempo() {
        assert_eq!(plan(&spec(0.0, &[])).unwrap(), AlignPlan { filter: "aresample=48000,atempo=1.00000".into(), commands: String::new(), initial_tempo: 1.0 });
        assert_eq!(plan(&spec(250.0, &[])).unwrap().filter, "aresample=48000,adelay=250:all=1,atempo=1.00000");
        assert_eq!(plan(&spec(-1500.0, &[])).unwrap().filter, "aresample=48000,atrim=start=1.500,asetpts=PTS-STARTPTS,atempo=1.00000");
    }

    #[test]
    fn segments_become_commands_in_shifted_time_and_first_one_is_initial() {
        let p = plan(&spec(100.0, &[(0.0, 0.98), (5000.0, 1.02), (12000.0, 1.0)])).unwrap();
        assert_eq!(p.initial_tempo, 0.98);
        assert_eq!(p.filter, "aresample=48000,adelay=100:all=1,asetnsamples=n=240:p=0,asendcmd=f={CMDS},atempo=0.98000");
        assert_eq!(p.commands, "5.100 atempo tempo 1.02000;\n12.100 atempo tempo 1.00000;");
    }

    #[test]
    fn negative_offset_drops_commands_before_the_cut_and_picks_the_right_initial() {
        // 砍掉前 3 秒：0–2 s 的段整段不見、2–6 s 那段在切點時正在播 → 它是初始速率
        let p = plan(&spec(-3000.0, &[(0.0, 0.9), (2000.0, 1.1), (6000.0, 1.0)])).unwrap();
        assert_eq!(p.initial_tempo, 1.1);
        assert_eq!(p.commands, "3.000 atempo tempo 1.00000;");
    }

    #[test]
    fn tempo_is_clamped_and_unsorted_input_is_sorted() {
        let p = plan(&spec(0.0, &[(4000.0, 9.0), (1000.0, 0.1)])).unwrap();
        assert_eq!(p.commands, "1.000 atempo tempo 0.50000;\n4.000 atempo tempo 2.00000;");
        assert!(plan(&AlignSpec { out_path: "dub.wav".into(), ..spec(0.0, &[]) }).is_err());
    }

    fn bundled_bins() -> Option<FfmpegBins> {
        let dir = crate::ffmpeg::bundled_candidate(std::path::Path::new(env!("CARGO_MANIFEST_DIR")));
        let exe = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
        let p = dir.join(exe);
        p.is_file().then(|| FfmpegBins { ffmpeg: p.to_string_lossy().into_owned(), ffprobe: String::new(), version: String::new(), source: "bundled".into() })
    }

    /// 真跑 ffmpeg：三段速率 0.9 / 1.1 / 1.0，輸出長度 == Σ(len / tempo) ± 20 ms —— asendcmd 驅動的 atempo 有沒有在對的時間換速。
    #[tokio::test]
    #[ignore]
    async fn align_roundtrip_length() {
        let Some(bins) = bundled_bins() else {
            eprintln!("no bundled ffmpeg; skip");
            return;
        };
        let dir = std::env::temp_dir().join(format!("aicut-align-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let sr = 48_000usize;
        let n = sr * 9;
        let samples: Vec<f32> = (0..n).map(|i| 0.4 * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / sr as f32).sin()).collect();
        let src = dir.join("dub.wav");
        let spec_w = hound::WavSpec { channels: 1, sample_rate: 48_000, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
        let mut w = hound::WavWriter::create(&src, spec_w).unwrap();
        for s in &samples {
            w.write_sample(*s).unwrap();
        }
        w.finalize().unwrap();
        let out = dir.join("dub_aligned.wav");
        let s = AlignSpec {
            src: src.to_string_lossy().into_owned(),
            out_path: out.to_string_lossy().into_owned(),
            offset_ms: 0.0,
            segments: vec![AlignSegment { dub_start_ms: 0.0, tempo: 0.9 }, AlignSegment { dub_start_ms: 3000.0, tempo: 1.1 }, AlignSegment { dub_start_ms: 6000.0, tempo: 1.0 }],
            channels: 1,
        };
        render(&bins, &s).await.unwrap();
        let r = hound::WavReader::open(&out).unwrap();
        let got_ms = r.len() as f64 / 48.0;
        let want_ms = 3000.0 / 0.9 + 3000.0 / 1.1 + 3000.0;
        eprintln!("[align] got {got_ms:.1} ms want {want_ms:.1} ms");
        assert!((got_ms - want_ms).abs() <= 20.0, "got {got_ms} want {want_ms}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
