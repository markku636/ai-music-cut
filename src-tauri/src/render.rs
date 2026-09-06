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

pub(crate) const SR: u32 = 48_000;
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
    /// crossfade：重疊長度；gap：room tone 長度；seam：忽略。
    pub ms: f64,
    /// gap 接點的前段淡出長度（None = 用 ms 當預設）。
    #[serde(default)]
    pub fade_out_ms: Option<f64>,
    /// gap 接點的後段淡入長度（None = 用 ms 當預設）。
    #[serde(default)]
    pub fade_in_ms: Option<f64>,
}

/// 區段效果（來源時間）：mute / gain / fade_in / fade_out；與前端 analysis/effects.ts 同一套包絡定義。
#[derive(Debug, Clone, Deserialize)]
pub struct RenderEffect {
    pub kind: String,
    pub start_ms: f64,
    pub end_ms: f64,
    #[serde(default)]
    pub db: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RenderPlan {
    pub segs: Vec<RenderSeg>,
    #[serde(default)]
    pub effects: Vec<RenderEffect>,
    /// len = segs.len() − 1
    pub joins: Vec<RenderJoin>,
    pub crossfade_ms: f64,
    pub target_lufs: f64,
    pub true_peak_dbtp: f64,
    /// mp3 | m4a | wav
    pub format: String,
    pub out_path: String,
    pub channels: u32,
    /// 預覽模式：跳過 loudnorm 的兩趟量測，只做 limiter + 低位元率編碼。
    /// 剪接（Cutter）完全一樣 —— 預覽跟成品的差別只在響度處理，接點與時間軸逐 frame 相同。
    #[serde(default)]
    pub preview: bool,
    /// 章節（ffmetadata 全文，前端 analysis/chapters.ts 產生）。
    ///
    /// 這裡刻意收「已經格式化好的字串」而不是結構化的章節陣列：ffmetadata 的跳脫規則
    /// （= ; # \\ 與換行）很細，前端那份有測試釘著，在 Rust 再寫一份就是第二個會出錯的地方，
    /// 而且沒有對拍測試抓得到。Rust 這邊只負責寫檔與多帶兩個 ffmpeg 參數。
    #[serde(default)]
    pub chapters_meta: Option<String>,
    /// 墊樂 / 音效軌。位置是**成品時間**（剪完之後的時間軸），不是來源時間。
    #[serde(default)]
    pub overlays: Vec<crate::mix::RenderOverlay>,
    /// 分軌輸出：把主聲軌靜音，只留 overlays（配樂 stem 用）。
    ///
    /// 「人聲 stem」不需要這個旗標 —— 把 overlays 清空就是了。
    #[serde(default)]
    pub mute_main: bool,
    /// 修聲（底噪 / 隆隆 / 齒音）。會同時進量測與編碼兩趟。
    #[serde(default)]
    pub cleanup: Option<crate::cleanup::CleanupSpec>,
    /// 已經量好的響度。有值就跳過量測那一趟，直接用它。
    ///
    /// 分軌輸出必須用**同一組**量測值，各軌才會加得回原本的混音；
    /// 每一軌各自 loudnorm 的話，配樂 stem 會被拉到跟人聲一樣大聲。
    #[serde(default)]
    pub loudnorm_measured: Option<LoudnormStats>,
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
    /// 這一趟量到的響度，分軌輸出要沿用同一組。
    pub measured: Option<LoudnormStats>,
}

pub(crate) fn emit_progress(app: &AppHandle, job_id: &str, stage: &str, pct: f32) {
    let _ = app.emit("render-progress", Progress { job_id, stage, pct: pct.clamp(0.0, 100.0) });
}

pub(crate) fn ms_to_frames(ms: f64) -> u64 {
    ((ms.max(0.0) / 1000.0) * SR as f64).round() as u64
}

/// gap 接點預設的淡出 / 淡入長度（前端沒指定時）。
const GAP_FADE_OUT_MS: f64 = 18.0;
const GAP_FADE_IN_MS: f64 = 25.0;
/// 檔案結尾的淡出長度（避免最後一個 frame 硬切出 click）。
const TAIL_FADE_MS: f64 = 20.0;

/// 每段的長度（frame）。
fn seg_lens(plan: &RenderPlan) -> Vec<u64> {
    plan.segs.iter().map(|s| ms_to_frames(s.src_end_ms).saturating_sub(ms_to_frames(s.src_start_ms))).collect()
}

/// 接點實際重疊幾個 frame。**兩段都要夾一半**：只夾前一段的話，下一段太短時
/// 混音會在段結束前跑不完，Cutter 會把剩餘 tail 直接補寫出去，長度就對不起來。
/// 與前端 src/analysis/edl/joins.ts 的 effectiveXfFrames 是同一條公式。
fn effective_xf_frames(spec_ms: f64, prev_len: u64, next_len: u64) -> u64 {
    ms_to_frames(spec_ms).min(prev_len / 2).min(next_len / 2)
}

/// 每個接點的 (前段扣住的 tail, 後段淡入長度)。tail 是「不直接寫出、留給接點處理」的部分。
fn join_plan(plan: &RenderPlan) -> (Vec<u64>, Vec<u64>) {
    let lens = seg_lens(plan);
    let n = plan.segs.len();
    let mut holds = vec![0u64; n];
    let mut fade_ins = vec![0u64; plan.joins.len()];
    for (i, j) in plan.joins.iter().enumerate() {
        if i + 1 >= n {
            break;
        }
        let (prev, next) = (lens[i], lens[i + 1]);
        match j.kind.as_str() {
            "gap" => {
                holds[i] = ms_to_frames(j.fade_out_ms.unwrap_or(GAP_FADE_OUT_MS)).min(prev / 2);
                fade_ins[i] = ms_to_frames(j.fade_in_ms.unwrap_or(GAP_FADE_IN_MS)).min(next / 2);
            }
            "seam" => {}
            _ => {
                // 舊 plan 沒有 per-join ms（都是 0）→ 退回全域 crossfade_ms，否則每個接點會變成 0 長度交叉 = 爆音
                let spec = if j.ms > 0.0 { j.ms } else { plan.crossfade_ms };
                holds[i] = effective_xf_frames(spec, prev, next);
            }
        }
    }
    // 最後一段的 tail 由結尾淡出寫回去 → 不影響總長，只是不要硬切。
    if n > 0 {
        holds[n - 1] = ms_to_frames(TAIL_FADE_MS).min(lens[n - 1] / 2);
    }
    (holds, fade_ins)
}

/// 輸出總長（frame）。這是唯一的定義，`total_out_frames` 與 Cutter 都走它。
fn plan_out_frames(plan: &RenderPlan) -> u64 {
    let lens = seg_lens(plan);
    let (holds, _) = join_plan(plan);
    let mut n: u64 = lens.iter().sum();
    for (i, j) in plan.joins.iter().enumerate() {
        if i + 1 >= plan.segs.len() {
            break;
        }
        match j.kind.as_str() {
            // tail 淡出後照寫，再加 room tone；淨增 room tone
            "gap" => n += ms_to_frames(j.ms).max(1),
            "seam" => {}
            // tail 蓋在下一段開頭上 → 淨損一個重疊
            _ => n -= holds[i].min(n),
        }
    }
    n
}

/// 串流剪接器：frame 逐一進來，依 plan 決定寫 / 丟；接點做等功率 crossfade 或 room tone gap。
///
/// 剪點的淡化一律走這裡的接點邏輯，**不要**用 RenderEffect 的 fade_in / fade_out：
/// 那個 fx_gain 是線性、而且套在 crossfade 混音「之前」，會變成雙重衰減。
/// 靜音 / 增益邊緣的平滑長度（5 ms），避免爆音。
const EDGE_FRAMES: u64 = SR as u64 / 200;

/// 已換算成 frame 的效果：(kind, start, end, gain_lin)
#[derive(Clone)]
struct Fx {
    kind: u8, // 0 mute, 1 gain, 2 fade_in, 3 fade_out
    s: u64,
    e: u64,
    lin: f32,
}

fn fx_gain(fx: &Fx, t: u64) -> f32 {
    if t < fx.s || t >= fx.e {
        return 1.0;
    }
    let len = (fx.e - fx.s).max(1) as f32;
    match fx.kind {
        2 => (t - fx.s) as f32 / len,
        3 => 1.0 - (t - fx.s) as f32 / len,
        _ => {
            let edge = EDGE_FRAMES.min((fx.e - fx.s) / 2).max(1) as f32;
            let d = (t - fx.s).min(fx.e - t) as f32;
            let w = (d / edge).clamp(0.0, 1.0);
            let target = if fx.kind == 0 { 0.0 } else { fx.lin };
            1.0 + (target - 1.0) * w
        }
    }
}

struct Cutter<W: std::io::Write + std::io::Seek> {
    ch: usize,
    segs: Vec<(u64, u64, f32)>, // (start_frame, end_frame, gain_lin)
    fx: Vec<Fx>,
    joins: Vec<(String, u64)>,  // (kind, frames)
    /// 每段結束時扣住幾個 frame 當 tail（見 join_plan）。
    holds: Vec<u64>,
    /// gap 接點後段的淡入長度。
    fade_ins: Vec<u64>,
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
        let (holds, fade_ins) = join_plan(plan);
        let fx = plan
            .effects
            .iter()
            .map(|e| Fx {
                kind: match e.kind.as_str() {
                    "mute" => 0,
                    "gain" => 1,
                    "fade_in" => 2,
                    "fade_out" => 3,
                    _ => 1,
                },
                s: ms_to_frames(e.start_ms),
                e: ms_to_frames(e.end_ms),
                lin: if e.kind == "gain" { 10f32.powf((e.db / 20.0) as f32) } else { 1.0 },
            })
            .collect();
        Self {
            ch: plan.channels.max(1) as usize,
            segs,
            fx,
            joins,
            holds,
            fade_ins,
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
    ///
    /// 曲線用 raised cosine 而不是線性：線性淡到真靜音時，前半段掉得太慢、
    /// 最後幾個 frame 又突然沒了，聽起來像「拖了一下才斷掉」。
    fn flush_tail_fade_out(&mut self) -> AppResult<()> {
        let n = self.tail.len() / self.ch;
        let tail = std::mem::take(&mut self.tail);
        for k in 0..n {
            let p = (k as f32 + 1.0) / (n as f32 + 1.0);
            let w = 0.5 * (1.0 + (std::f32::consts::PI * p).cos());
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
                let fi = self.fade_ins.get(self.si - 1).copied().unwrap_or(0);
                self.tail = vec![0.0; (fi as usize) * self.ch];
                self.mix_total = fi;
                self.mixing_left = fi;
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
        let env: f32 = self.fx.iter().map(|f| fx_gain(f, t)).product();
        let mut cur: Vec<f32> = frame.iter().map(|v| v * g * env).collect();
        // 本段最後 hold 個 frame 扣住當 tail（長度由接點協定決定，見 join_plan）
        let hold = self.holds.get(self.si).copied().unwrap_or(0);
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
    plan_out_frames(plan)
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
    // 修聲要**在量測之前**發生：loudnorm 是 linear=true，pass 1 量到的數字直接決定
    // pass 2 要套多少增益。這裡不修、編碼時才修，成品響度就會偏掉。
    let af = crate::cleanup::prepend_cleanup(plan.cleanup.as_ref(), &format!("{}:print_format=json", loudnorm_base(plan)));
    c.args(["-af", &af, "-f", "null", "-"]);
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
    let limit = 10f64.powf(plan.true_peak_dbtp / 20.0);
    // 強制指定聲道佈局。concat.wav 是 hound 寫的，沒有 channel mask，ffmpeg 讀進來是
    // 「1 channels (FL)」這種**未命名**佈局；pcm 與 mp3 不在意，但原生 aac 編碼器會直接
    // 回 -22 (Invalid argument) —— 症狀是 m4a 輸出一律失敗，訊息只有 "Conversion failed!"。
    // 佈局要依實際聲道數指定，不能寫 "mono|stereo" 讓 ffmpeg 自己挑 ——
    // 輸入的佈局是未命名的，aformat 配不到 mono 就會選 stereo，把單聲道的
    // podcast 升成雙聲道（檔案大一倍、內容完全一樣）。
    let layout = if plan.channels <= 1 { "aformat=channel_layouts=mono" } else { "aformat=channel_layouts=stereo" };
    let filter = if plan.preview {
        // 預覽：不跑 loudnorm（那要先量測一趟，30 分鐘素材要幾十秒），只留 limiter 防爆。
        // 修聲照樣要套 —— 預覽的用途就是讓人聽修聲有沒有效。
        crate::cleanup::prepend_cleanup(
            plan.cleanup.as_ref(),
            &format!("alimiter=limit={limit:.4}:attack=5:release=50:level=false,{layout}"),
        )
    } else {
        crate::cleanup::prepend_cleanup(
            plan.cleanup.as_ref(),
            &format!(
                "{}:measured_I={:.2}:measured_TP={:.2}:measured_LRA={:.2}:measured_thresh={:.2}:offset={:.2}:linear=true:print_format=json,alimiter=limit={:.4}:attack=5:release=50:level=false,{}",
                loudnorm_base(plan),
                m.input_i,
                m.input_tp,
                m.input_lra,
                m.input_thresh,
                m.target_offset,
                limit,
                layout
            ),
        )
    };
    let (fmt, codec): (&str, Vec<&str>) = if plan.preview {
        // 預覽一律 mp3 q5：夠聽接縫，檔案小、編碼快
        ("mp3", vec!["-c:a", "libmp3lame", "-q:a", "5"])
    } else {
        match plan.format.as_str() {
            "wav" => ("wav", vec!["-c:a", "pcm_s16le"]),
            "m4a" => ("mp4", vec!["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]),
            _ => ("mp3", vec!["-c:a", "libmp3lame", "-q:a", "2"]),
        }
    };
    // 章節：wav 沒有章節容器，預覽也不需要
    let meta_path = match (&plan.chapters_meta, plan.preview, fmt) {
        (Some(t), false, "mp3") | (Some(t), false, "mp4") if !t.trim().is_empty() => {
            let mp = wav_path.with_extension("chapters.txt");
            tokio::fs::write(&mp, t.as_bytes()).await.map_err(|e| AppError::Ffmpeg(format!("寫章節 metadata 失敗：{e}")))?;
            Some(mp)
        }
        _ => None,
    };

    let mut c = proc::cmd(&bins.ffmpeg);
    c.args(["-nostdin", "-hide_banner", "-nostats", "-loglevel", "info", "-progress", "pipe:1", "-y", "-i"]);
    c.arg(wav_path);
    if let Some(mp) = &meta_path {
        c.arg("-i");
        c.arg(mp);
        // 只從第 0 個輸入拿音訊，metadata 從第 1 個輸入整份帶過來（章節就在裡面）
        c.args(["-map", "0:a", "-map_metadata", "1"]);
    }
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
        // 只留最後一行的話，遇到 "Conversion failed!" 就完全看不出原因是編碼器、
        // 容器還是 filter —— 真正的訊息通常在它前面幾行。
        let tail: Vec<&str> = err.lines().map(str::trim).filter(|l| !l.is_empty()).rev().take(4).collect();
        let msg = tail.into_iter().rev().collect::<Vec<_>>().join(" / ");
        return Err(AppError::Ffmpeg(format!("編碼失敗：{msg}")));
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
    let result: AppResult<(Option<f64>, Option<f64>, f64, LoudnormStats)> = async {
        if plan.segs.is_empty() {
            return Err(AppError::Invalid("沒有可輸出的保留段".into()));
        }
        if let Some(dir) = out_path.parent() {
            tokio::fs::create_dir_all(dir).await?;
        }
        let total = total_out_frames(&plan);
        cut_to_wav(&app, &bins, &src, &plan, &wav_path, &job_id, &cancel).await?;
        // 墊樂 / 音效疊在主聲軌上。**一定要在量測之前**：loudnorm 要對的是使用者聽到的
        // 那一份（含配樂），先量主聲軌再加音樂的話成品會比目標響度大。
        let mixed_path = work_dir.join(format!("mixed-{job_id}.wav"));
        let stage_wav = if plan.overlays.is_empty() && !plan.mute_main {
            wav_path.clone()
        } else {
            crate::mix::mix_overlays(&app, &bins, &plan, &wav_path, &mixed_path, &job_id, &cancel).await?;
            mixed_path.clone()
        };
        // 預覽跳過量測那一趟（30 分鐘素材要幾十秒），直接進編碼
        let m = if plan.preview {
            LoudnormStats::default()
        } else if let Some(m0) = plan.loudnorm_measured.clone() {
            // 分軌輸出：沿用主混音那一趟的量測，各軌才加得回原本的混音
            m0
        } else {
            emit_progress(&app, &job_id, "measure", 0.0);
            let m = measure(&bins, &stage_wav, &plan, &cancel).await?;
            emit_progress(&app, &job_id, "measure", 100.0);
            m
        };
        let (oi, otp) = encode(&app, &bins, &stage_wav, &plan, &m, &out_part, total, &job_id, &cancel).await?;
        tokio::fs::rename(&out_part, &out_path).await?;
        Ok((oi, otp, m.input_i, m))
    }
    .await;
    let _ = tokio::fs::remove_file(&wav_path).await;
    let _ = tokio::fs::remove_file(work_dir.join(format!("mixed-{job_id}.wav"))).await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&out_part).await;
    }
    match result {
        Ok((oi, otp, ii, m)) => RenderDone { job_id, ok: true, out_path: Some(plan.out_path), error: None, input_lufs: Some(ii), output_lufs: oi, output_tp: otp, elapsed_ms: t0.elapsed().as_millis() as u64, measured: Some(m) },
        Err(e) => RenderDone { job_id, ok: false, out_path: None, error: Some(e.message()), input_lufs: None, output_lufs: None, output_tp: None, elapsed_ms: t0.elapsed().as_millis() as u64, measured: None },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(segs: &[(f64, f64, f64)], joins: &[(&str, f64)]) -> RenderPlan {
        RenderPlan {
            segs: segs.iter().map(|&(a, b, g)| RenderSeg { src_start_ms: a, src_end_ms: b, gain_db: g }).collect(),
            effects: vec![],
            joins: joins.iter().map(|&(k, ms)| RenderJoin { kind: k.into(), ms, fade_out_ms: None, fade_in_ms: None }).collect(),
            crossfade_ms: 20.0,
            target_lufs: -16.0,
            true_peak_dbtp: -1.5,
            format: "wav".into(),
            out_path: String::new(),
            channels: 1,
            preview: false,
            chapters_meta: None,
            overlays: vec![],
            mute_main: false,
            loudnorm_measured: None,
            cleanup: None,
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

    /// 輸出長度只能有一份公式：`plan_out_frames` 必須逐 frame 等於 Cutter 真的寫出來的數量。
    /// 這條測試是 R3 之後所有音質工作的安全網 —— Cutter 改壞不會 panic，只會「長度慢慢漂」，
    /// 而且會被後面的 loudnorm 掩蓋掉，聽感上只剩「接縫怪怪的」。
    #[test]
    fn plan_out_frames_matches_what_the_cutter_actually_writes() {
        // 決定性偽亂數（測試不能靠 rand，失敗要能重現）
        let mut seed = 0x2545_F491_4F6C_DD1Du64;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        let kinds = ["crossfade", "gap", "seam"];
        for case in 0..120u32 {
            let n = 1 + (next() % 5) as usize;
            let mut segs = Vec::new();
            let mut cursor = 0.0f64;
            for _ in 0..n {
                // 刻意混入「比 crossfade 還短」的段：那正是舊公式會漏算的情況
                let len = match next() % 4 {
                    0 => 5.0 + (next() % 20) as f64,
                    1 => 30.0 + (next() % 60) as f64,
                    _ => 120.0 + (next() % 900) as f64,
                };
                let gap = (next() % 200) as f64;
                segs.push((cursor, cursor + len, 0.0));
                cursor += len + gap;
            }
            let joins: Vec<(&str, f64)> = (0..n.saturating_sub(1))
                .map(|_| {
                    let k = kinds[(next() % 3) as usize];
                    let ms = match k {
                        "gap" => 40.0 + (next() % 300) as f64,
                        "seam" => 0.0,
                        _ => 4.0 + (next() % 60) as f64,
                    };
                    (k, ms)
                })
                .collect();
            let p = plan(&segs, &joins);
            let expect = plan_out_frames(&p);
            let out = run_cutter(&p, ms_to_frames(cursor + 100.0));
            assert_eq!(
                out.len() as u64,
                expect,
                "case {case}: segs={segs:?} joins={joins:?}"
            );
        }
    }

    #[test]
    fn effective_crossfade_is_clamped_by_both_sides() {
        // 只夾前一段是錯的：下一段太短時 Cutter 會補寫殘餘 tail，長度就對不起來
        assert_eq!(effective_xf_frames(20.0, 4800, 4800), ms_to_frames(20.0));
        assert_eq!(effective_xf_frames(20.0, 100, 4800), 50);
        assert_eq!(effective_xf_frames(20.0, 4800, 100), 50);
        assert_eq!(effective_xf_frames(20.0, 1, 4800), 0);
    }

    #[test]
    fn legacy_plan_without_per_join_ms_falls_back_to_global_crossfade() {
        // 舊版專案 / CLI 產生的 plan：joins[].ms = 0。不退回 crossfade_ms 的話
        // 每個接點都會變成 0 長度交叉 ＝ 硬切爆音。
        let p = plan(&[(0.0, 500.0, 0.0), (800.0, 1300.0, 0.0)], &[("crossfade", 0.0)]);
        let (holds, _) = join_plan(&p);
        assert_eq!(holds[0], ms_to_frames(20.0), "應退回 plan.crossfade_ms");
        let out = run_cutter(&p, ms_to_frames(1400.0));
        assert_eq!(out.len() as u64, plan_out_frames(&p));
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
    fn mute_effect_silences_range_with_soft_edges() {
        let mut p = plan(&[(0.0, 300.0, 0.0)], &[]);
        p.effects.push(RenderEffect { kind: "mute".into(), start_ms: 100.0, end_ms: 200.0, db: 0.0 });
        let out = run_cutter(&p, ms_to_frames(300.0));
        // +12 frame = 1 kHz 正弦的四分之一週期 → 取樣在波峰，避開零交越點
        let mid = ms_to_frames(150.0) as usize + 12;
        assert!(out[mid].abs() < 1e-6, "mute 中段應為 0");
        let before = ms_to_frames(50.0) as usize + 12;
        assert!(out[before].abs() > 0.4, "mute 範圍外不受影響");
        let edge = (ms_to_frames(100.0) + EDGE_FRAMES / 2) as usize + 12;
        assert!(out[edge].abs() > 0.05 && out[edge].abs() < out[before].abs(), "邊緣應平滑衰減");
    }

    #[test]
    fn fade_in_ramps_linearly() {
        let mut p = plan(&[(0.0, 1000.0, 0.0)], &[]);
        p.effects.push(RenderEffect { kind: "fade_in".into(), start_ms: 0.0, end_ms: 1000.0, db: 0.0 });
        let out = run_cutter(&p, ms_to_frames(1000.0));
        let q1 = ms_to_frames(250.0) as usize + 12;
        let q3 = ms_to_frames(750.0) as usize + 12;
        assert!(out[q3].abs() > out[q1].abs() * 2.0, "後段音量應明顯大於前段");
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
