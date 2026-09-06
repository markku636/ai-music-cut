//! 墊樂 / 音效軌的混音。
//!
//! 主聲軌走既有的 Cutter 產出 `concat.wav`（成品時間軸）。這裡把「墊樂」與「音效」
//! 疊上去 —— 它們的位置是釘在**成品時間**上的，不是來源時間：使用者是在剪好的節目上
//! 決定「開場音樂放這裡」，剪輯再動的時候音樂不該跟著跑。
//!
//! 為什麼自己寫混音而不是丟給 ffmpeg 的 filter_complex：
//!
//! * 音量自動化（閃避人聲的那條曲線）在 filter graph 裡只能用 `volume` 的運算式硬寫，
//!   一集節目幾十段閃避就是幾千字元的表達式，Windows 的命令列長度會先撞牆。
//! * 我們已經有一套逐 frame 的包絡引擎（render.rs 的 `Fx`），控制點插值用同一套心智模型，
//!   而且可以寫單元測試釘死 —— filter 字串沒辦法測。
//!
//! 記憶體：每一軌同時只會有一個片段在播（同一軌的片段不重疊），所以解碼管線是
//! 「用到才開、過了就關」，不會把整首曲子讀進記憶體。
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::io::AsyncReadExt;
use tokio::process::Child;

use crate::error::{AppError, AppResult};
use crate::ffmpeg::FfmpegBins;
use crate::proc;
use crate::render::{emit_progress, ms_to_frames, RenderPlan, SR};

/// 音量控制點（相對片段起點的毫秒）。兩點之間線性內插（dB 域）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OverlayPoint {
    pub ms: f64,
    pub db: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenderOverlay {
    /// 來源檔絕對路徑。
    pub path: String,
    pub src_start_ms: f64,
    pub src_end_ms: f64,
    /// 放在成品時間軸的哪裡。
    pub out_start_ms: f64,
    pub gain_db: f64,
    #[serde(default)]
    pub fade_in_ms: f64,
    #[serde(default)]
    pub fade_out_ms: f64,
    /// 音量自動化控制點（空 = 整段固定 gain_db）。
    #[serde(default)]
    pub points: Vec<OverlayPoint>,
    /// 哪一軌（只影響「同一軌不重疊」的假設與錯誤訊息）。
    #[serde(default)]
    pub lane: String,
}

/// dB → 線性倍率。
fn db_to_lin(db: f64) -> f32 {
    if db <= -90.0 {
        0.0
    } else {
        10f64.powf(db / 20.0) as f32
    }
}

/// 片段內 `ms` 處的增益（dB）。控制點之間線性內插；沒有控制點就用固定 gain。
///
/// 在 **dB 域**內插而不是線性域：閃避從 0 到 −12 dB 的時候，dB 線性才聽起來是等速的。
pub fn envelope_db(o: &RenderOverlay, ms: f64) -> f64 {
    let base = o.gain_db;
    if o.points.is_empty() {
        return base;
    }
    let pts = &o.points;
    if ms <= pts[0].ms {
        return base + pts[0].db;
    }
    if ms >= pts[pts.len() - 1].ms {
        return base + pts[pts.len() - 1].db;
    }
    for w in pts.windows(2) {
        let (a, b) = (&w[0], &w[1]);
        if ms >= a.ms && ms <= b.ms {
            let span = b.ms - a.ms;
            let f = if span <= 0.0 { 0.0 } else { (ms - a.ms) / span };
            return base + a.db + (b.db - a.db) * f;
        }
    }
    base
}

/// 片段在 `ms` 處的總增益（含淡入淡出）。
pub fn overlay_gain(o: &RenderOverlay, ms: f64, len_ms: f64) -> f32 {
    let mut g = db_to_lin(envelope_db(o, ms));
    if o.fade_in_ms > 0.0 && ms < o.fade_in_ms {
        g *= (ms / o.fade_in_ms).clamp(0.0, 1.0) as f32;
    }
    if o.fade_out_ms > 0.0 && ms > len_ms - o.fade_out_ms {
        g *= ((len_ms - ms) / o.fade_out_ms).clamp(0.0, 1.0) as f32;
    }
    g
}

/// 一個片段的解碼管線；用到才開、過了就關。
struct Source {
    child: Child,
    buf: Vec<u8>,
    carry: Vec<u8>,
    /// carry 已經吐出去到哪裡。
    ///
    /// **不要**用 `carry.drain(..frame_bytes)` 逐 frame 消化：那是從 Vec 前面砍，
    /// 每次都要把剩下的幾萬個 byte 往前搬。一分鐘的墊樂就是幾百萬 frame ×
    /// 幾十 KB 的 memmove，混音會慢到像當掉（實測 34 秒的素材跑不完）。
    pos: usize,
    eof: bool,
}

impl Source {
    async fn open(bins: &FfmpegBins, o: &RenderOverlay, ch: u32) -> AppResult<Self> {
        let ss = (o.src_start_ms / 1000.0).max(0.0);
        let dur = ((o.src_end_ms - o.src_start_ms) / 1000.0).max(0.0);
        let mut c = proc::cmd(&bins.ffmpeg);
        c.args(["-nostdin", "-hide_banner", "-loglevel", "error"]);
        // -ss 放在 -i 前面是 input seek（快、且對這裡夠準：我們只需要片段起點）
        c.args(["-ss", &format!("{ss:.6}")]);
        c.arg("-i");
        c.arg(&o.path);
        c.args(["-t", &format!("{dur:.6}")]);
        c.args(["-vn", "-f", "f32le", "-ar", "48000", "-ac", &ch.to_string(), "pipe:1"]);
        c.stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        let child = c.spawn().map_err(|e| AppError::Ffmpeg(format!("墊樂解碼啟動失敗（{}）：{e}", o.path)))?;
        Ok(Source { child, buf: vec![0u8; 64 * 1024], carry: Vec::new(), pos: 0, eof: false })
    }

    /// 取下一個 frame（ch 個 f32）。來源播完回 None。
    async fn next_frame(&mut self, ch: usize, out: &mut [f32]) -> AppResult<bool> {
        let frame_bytes = 4 * ch;
        while self.carry.len() - self.pos < frame_bytes && !self.eof {
            // 消化過的部分先丟掉再讀（一次性 memmove，不是每個 frame 都搬）
            if self.pos > 0 {
                self.carry.drain(..self.pos);
                self.pos = 0;
            }
            let stdout = self.child.stdout.as_mut().expect("stdout");
            let n = stdout.read(&mut self.buf).await?;
            if n == 0 {
                self.eof = true;
                break;
            }
            self.carry.extend_from_slice(&self.buf[..n]);
        }
        if self.carry.len() - self.pos < frame_bytes {
            return Ok(false);
        }
        let end = self.pos + frame_bytes;
        for (i, sb) in self.carry[self.pos..end].chunks_exact(4).enumerate() {
            out[i] = f32::from_le_bytes([sb[0], sb[1], sb[2], sb[3]]);
        }
        self.pos = end;
        Ok(true)
    }
}

/// 把 overlays 疊到 `in_wav` 上，寫出 `out_wav`。回傳寫了幾個 frame。
///
/// 主聲軌一律原樣通過（不衰減）—— 墊樂要讓路給人聲，不是反過來。
pub async fn mix_overlays(
    app: &AppHandle,
    bins: &FfmpegBins,
    plan: &RenderPlan,
    in_wav: &Path,
    out_wav: &Path,
    job_id: &str,
    cancel: &AtomicBool,
) -> AppResult<u64> {
    let ch = plan.channels.max(1) as usize;
    let mut reader = hound::WavReader::open(in_wav).map_err(|e| AppError::Io(format!("讀取 concat.wav 失敗：{e}")))?;
    let total_frames = reader.len() as u64 / ch as u64;

    let spec = hound::WavSpec {
        channels: ch as u16,
        sample_rate: SR,
        bits_per_sample: 32,
        sample_format: hound::SampleFormat::Float,
    };
    let file = std::fs::File::create(out_wav)?;
    let mut writer = hound::WavWriter::new(std::io::BufWriter::new(file), spec).map_err(|e| AppError::Io(format!("建立 mixed.wav 失敗：{e}")))?;

    // 依起點排序，並記下每個片段的 frame 範圍
    let mut ovs: Vec<(usize, u64, u64)> = plan
        .overlays
        .iter()
        .enumerate()
        .map(|(i, o)| {
            let start = ms_to_frames(o.out_start_ms);
            let len = ms_to_frames(o.src_end_ms) - ms_to_frames(o.src_start_ms);
            (i, start, start + len)
        })
        .filter(|(_, s, e)| e > s)
        .collect();
    ovs.sort_by_key(|(_, s, _)| *s);

    // idx → (起 frame, 迄 frame)，避免在逐 frame 的迴圈裡做線性搜尋
    let mut span: HashMap<usize, (u64, u64)> = HashMap::new();
    for (i, s0, e0) in &ovs {
        span.insert(*i, (*s0, *e0));
    }
    let mut active: HashMap<usize, Source> = HashMap::new();
    let mut next_ov = 0usize;
    let mut samples = reader.samples::<f32>();
    let mut frame = vec![0f32; ch];
    let mut ov_frame = vec![0f32; ch];
    let mut written: u64 = 0;
    let mut last_pct = -1.0f32;

    for t in 0..total_frames {
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::Canceled);
        }
        for s in frame.iter_mut() {
            let v = match samples.next() {
                Some(Ok(x)) => x,
                _ => 0.0,
            };
            // 配樂 stem：主聲軌靜音，但仍然要把樣本讀掉（不然時間軸會錯位）
            *s = if plan.mute_main { 0.0 } else { v };
        }

        // 開啟這一 frame 該開始的片段
        while next_ov < ovs.len() && ovs[next_ov].1 <= t {
            let (idx, _, _) = ovs[next_ov];
            let src = Source::open(bins, &plan.overlays[idx], ch as u32).await?;
            active.insert(idx, src);
            next_ov += 1;
        }

        if !active.is_empty() {
            let mut done: Vec<usize> = Vec::new();
            for (idx, src) in active.iter_mut() {
                let o = &plan.overlays[*idx];
                let (start, end) = span[idx];
                if t >= end {
                    done.push(*idx);
                    continue;
                }
                if !src.next_frame(ch, &mut ov_frame).await? {
                    done.push(*idx);
                    continue;
                }
                let ms = (t - start) as f64 * 1000.0 / SR as f64;
                let len_ms = (end - start) as f64 * 1000.0 / SR as f64;
                let g = overlay_gain(o, ms, len_ms);
                for (i, v) in ov_frame.iter().enumerate() {
                    frame[i] += v * g;
                }
            }
            for idx in done {
                if let Some(mut s) = active.remove(&idx) {
                    let _ = s.child.start_kill();
                }
            }
        }

        for v in &frame {
            // 這裡只做硬性防爆；真正的響度處理在後面的 loudnorm + alimiter
            writer.write_sample(v.clamp(-1.0, 1.0)).map_err(|e| AppError::Io(format!("寫 mixed.wav 失敗：{e}")))?;
        }
        written += 1;

        if total_frames > 0 {
            let pct = (t as f64 / total_frames as f64 * 100.0) as f32;
            if pct - last_pct >= 2.0 {
                last_pct = pct;
                emit_progress(app, job_id, "cut", pct);
            }
        }
    }

    for (_, mut s) in active {
        let _ = s.child.start_kill();
    }
    writer.finalize().map_err(|e| AppError::Io(format!("關閉 mixed.wav 失敗：{e}")))?;
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ov(gain_db: f64, points: Vec<(f64, f64)>) -> RenderOverlay {
        RenderOverlay {
            path: String::new(),
            src_start_ms: 0.0,
            src_end_ms: 10_000.0,
            out_start_ms: 0.0,
            gain_db,
            fade_in_ms: 0.0,
            fade_out_ms: 0.0,
            points: points.into_iter().map(|(ms, db)| OverlayPoint { ms, db }).collect(),
            lane: "music".into(),
        }
    }

    #[test]
    fn constant_gain_when_no_points() {
        let o = ov(-6.0, vec![]);
        assert_eq!(envelope_db(&o, 0.0), -6.0);
        assert_eq!(envelope_db(&o, 5000.0), -6.0);
    }

    #[test]
    fn points_interpolate_linearly_in_db() {
        // 控制點是「相對基準的增減」，所以 -6 dB 的墊樂被壓 -12 → -18
        let o = ov(-6.0, vec![(1000.0, 0.0), (2000.0, -12.0)]);
        assert_eq!(envelope_db(&o, 1000.0), -6.0);
        assert_eq!(envelope_db(&o, 2000.0), -18.0);
        assert!((envelope_db(&o, 1500.0) - (-12.0)).abs() < 1e-9);
    }

    #[test]
    fn holds_first_and_last_point_outside_the_range() {
        let o = ov(0.0, vec![(1000.0, -3.0), (2000.0, -9.0)]);
        assert_eq!(envelope_db(&o, 0.0), -3.0);
        assert_eq!(envelope_db(&o, 99_999.0), -9.0);
    }

    #[test]
    fn fades_multiply_on_top_of_the_envelope() {
        let mut o = ov(0.0, vec![]);
        o.fade_in_ms = 1000.0;
        o.fade_out_ms = 1000.0;
        assert!((overlay_gain(&o, 0.0, 10_000.0) - 0.0).abs() < 1e-6);
        assert!((overlay_gain(&o, 500.0, 10_000.0) - 0.5).abs() < 1e-6);
        assert!((overlay_gain(&o, 5000.0, 10_000.0) - 1.0).abs() < 1e-6);
        assert!((overlay_gain(&o, 9500.0, 10_000.0) - 0.5).abs() < 1e-6);
    }

    #[test]
    fn very_low_db_is_silence_not_a_tiny_number() {
        let o = ov(-96.0, vec![]);
        assert_eq!(overlay_gain(&o, 0.0, 10_000.0), 0.0);
    }
}
