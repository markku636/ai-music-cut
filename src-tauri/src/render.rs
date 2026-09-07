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
    /// fade_in / fade_out 的曲線：linear（預設）/ equal_power / exponential。
    #[serde(default)]
    pub shape: Option<String>,
}

/// 增益包絡類的效果種類。範圍濾波（denoise…）不走 Cutter，前端不該送進 effects；送了就是錯，不能安靜地當成增益 1。
const GAIN_EFFECT_KINDS: [&str; 5] = ["mute", "gain", "fade_in", "fade_out", "invert"];

pub fn validate_effects(plan: &RenderPlan) -> AppResult<()> {
    for e in &plan.effects {
        if !GAIN_EFFECT_KINDS.contains(&e.kind.as_str()) {
            return Err(AppError::Invalid(format!("不認識的效果種類：{}（範圍濾波要走 fx_regions）", e.kind)));
        }
    }
    Ok(())
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
    /// 保留動態：寧可小聲，也不要被動態壓縮。
    ///
    /// 我們送的是 `linear=true`，但那只是請求 —— 目標高過「線性拉得到的極限」時，
    /// ffmpeg 會自己退回 dynamic（動態壓縮），音量起伏被壓平。開這個旗標就把目標
    /// **降到線性拿得到的位置**，loudnorm 因此留在 linear。
    ///
    /// 極限是量出來的：`input_i + (TP上限 − input_tp)`。純增益會把整合響度與真實峰值
    /// 平移同樣的量，所以峰值頂到上限時能拉的就是這麼多。實測（真實語音，
    /// input_i −17.45 / input_tp −0.49 / 上限 −1.5 → 極限 −18.46）：目標 −18.5 回
    /// `linear`、−16.0 回 `dynamic`，界線就在這裡。
    #[serde(default)]
    pub preserve_dynamics: bool,
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
    kind: u8, // 0 mute, 1 gain, 2 fade_in, 3 fade_out, 4 invert
    /// 0 linear, 1 equal_power, 2 exponential（只有 fade 用）
    shape: u8,
    s: u64,
    e: u64,
    lin: f32,
}

/// 淡入淡出曲線；與前端 analysis/effects.ts 的 fadeCurve 共用同一張樣本表（測試釘死）。
fn fade_curve(shape: u8, p: f32, fade_in: bool) -> f32 {
    let p = p.clamp(0.0, 1.0);
    match shape {
        1 => {
            if fade_in {
                (p * std::f32::consts::FRAC_PI_2).sin()
            } else {
                (p * std::f32::consts::FRAC_PI_2).cos()
            }
        }
        2 => {
            if fade_in {
                10f32.powf(-3.0 * (1.0 - p))
            } else {
                10f32.powf(-3.0 * p)
            }
        }
        _ => {
            if fade_in {
                p
            } else {
                1.0 - p
            }
        }
    }
}

fn fx_gain(fx: &Fx, t: u64) -> f32 {
    if t < fx.s || t >= fx.e {
        return 1.0;
    }
    let len = (fx.e - fx.s).max(1) as f32;
    match fx.kind {
        2 => fade_curve(fx.shape, (t - fx.s) as f32 / len, true),
        3 => fade_curve(fx.shape, (t - fx.s) as f32 / len, false),
        4 => {
            // 反相：邊緣用同一條 5 ms 斜坡穿過 0（不會 click）；兩個重疊的反相相乘 = +1
            let edge = EDGE_FRAMES.min((fx.e - fx.s) / 2).max(1) as f32;
            let d = (t - fx.s).min(fx.e - t) as f32;
            let w = (d / edge).clamp(0.0, 1.0);
            1.0 - 2.0 * w
        }
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
                    "invert" => 4,
                    // validate_effects 已經擋掉未知種類；這裡不會走到
                    _ => 1,
                },
                shape: match e.shape.as_deref() {
                    Some("equal_power") => 1,
                    Some("exponential") => 2,
                    _ => 0,
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
    validate_effects(plan)?;
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
    /// `linear`（只套一個增益）或 `dynamic`（動態壓縮）。
    ///
    /// **這個欄位很重要而且一直被丟掉。** 我們送的是 `linear=true`，但那只是「請求」——
    /// 需要的增益會讓峰值超過上限時，ffmpeg 會**自己退回 dynamic**，也就是動態壓縮。
    /// 成品因此被壓過，動態變小、聽起來比較平。ffmpeg 只在 JSON 裡講一次，不解析就
    /// 永遠不知道自己交出去的是壓過的檔案。
    #[serde(default)]
    pub normalization_type: Option<String>,
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
        normalization_type: v.get("normalization_type").and_then(|x| x.as_str()).map(str::to_string),
    })
}

/// 一般模式請求的 loudness range。
const DEFAULT_LRA: f64 = 11.0;
/// 保留動態模式：請求 ffmpeg 允許的最大值，等於「不要約束動態範圍」。
const PRESERVE_LRA: f64 = 20.0;

fn loudnorm_base(plan: &RenderPlan) -> String {
    format!("loudnorm=I={:.1}:TP={:.1}:LRA={:.0}", plan.target_lufs, plan.true_peak_dbtp, requested_lra(plan))
}

/// 要向 loudnorm 請求多大的 loudness range。
///
/// **這是「會不會被壓」的第二個條件，而且比目標更容易踩到。** 實測：量到的 LRA 超過
/// 請求的 LRA 時，loudnorm 一律退回 dynamic —— 跟目標拉不拉得到無關。
/// 請求 11 / 量到 8 → linear；請求 11 / 量到 12 → dynamic；請求 2 / 量到 2.8 → dynamic。
///
/// 所以「保留動態」不能只把目標壓低，還要停止約束動態範圍。
pub fn requested_lra(plan: &RenderPlan) -> f64 {
    if plan.preserve_dynamics { PRESERVE_LRA } else { DEFAULT_LRA }
}

/// 界線是**硬的**，而且 I= 只送到小數一位：不留餘裕就會踩在線上，四捨五入往哪邊倒
/// 決定了會不會被壓。實測（真實語音、極限 -18.46）：目標 -18.46 回 linear、-18.4 回
/// dynamic —— 差 0.06 dB 就換了一種處理。
const LINEAR_MARGIN_LU: f64 = 0.5;

/// 純增益（linear）拉得到的最高整合響度。
///
/// 增益把整合響度與真實峰值平移同樣的量，所以峰值頂到上限那一刻就是極限。
pub fn linear_ceiling_lufs(true_peak_dbtp: f64, m: &LoudnormStats) -> f64 {
    m.input_i + (true_peak_dbtp - m.input_tp) - LINEAR_MARGIN_LU
}

/// pass 2 實際要用的目標。
///
/// `preserve_dynamics` 沒開就照使用者設的（拉不到就讓 ffmpeg 自己退回 dynamic，
/// v0.74 之後那件事會被回報出來）。開了就夾到線性拿得到的位置。
pub fn effective_target_lufs(plan: &RenderPlan, m: &LoudnormStats) -> f64 {
    if !plan.preserve_dynamics {
        return plan.target_lufs;
    }
    plan.target_lufs.min(linear_ceiling_lufs(plan.true_peak_dbtp, m))
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
/// 回 (output_i, output_tp, normalization_type)。
///
/// **第三個值一定要從這一趟拿。** pass 1 的 JSON 也有 `normalization_type`，但那是
/// 「照 pass 1 的目標估的」；真正決定成品有沒有被壓的是 pass 2。兩趟目標不一樣時
/// （保留動態模式會把 pass 2 的目標壓低）拿 pass 1 的值回報，講的就是另一件事。
pub async fn encode(app: &AppHandle, bins: &FfmpegBins, wav_path: &Path, plan: &RenderPlan, m: &LoudnormStats, out_part: &Path, total_frames: u64, job_id: &str, cancel: &AtomicBool) -> AppResult<(Option<f64>, Option<f64>, Option<String>)> {
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
                "loudnorm=I={:.1}:TP={:.1}:LRA={:.0}:measured_I={:.2}:measured_TP={:.2}:measured_LRA={:.2}:measured_thresh={:.2}:offset={:.2}:linear=true:print_format=json,alimiter=limit={:.4}:attack=5:release=50:level=false,{}",
                effective_target_lufs(plan, m),
                plan.true_peak_dbtp,
                requested_lra(plan),
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
    Ok((
        stats.as_ref().and_then(|s| s.output_i),
        stats.as_ref().and_then(|s| s.output_tp),
        stats.as_ref().and_then(|s| s.normalization_type.clone()),
    ))
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
        let (oi, otp, ntype) = encode(&app, &bins, &stage_wav, &plan, &m, &out_part, total, &job_id, &cancel).await?;
        tokio::fs::rename(&out_part, &out_path).await?;
        // pass 2 才是成品實際走的路 —— 把它的模式蓋回 measured，回報的才是真的那一個
        let m = LoudnormStats { normalization_type: ntype.or(m.normalization_type.clone()), ..m };
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
            preserve_dynamics: false,
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
        p.effects.push(RenderEffect { kind: "mute".into(), start_ms: 100.0, end_ms: 200.0, db: 0.0, shape: None });
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
        p.effects.push(RenderEffect { kind: "fade_in".into(), start_ms: 0.0, end_ms: 1000.0, db: 0.0, shape: None });
        let out = run_cutter(&p, ms_to_frames(1000.0));
        let q1 = ms_to_frames(250.0) as usize + 12;
        let q3 = ms_to_frames(750.0) as usize + 12;
        assert!(out[q3].abs() > out[q1].abs() * 2.0, "後段音量應明顯大於前段");
    }

    #[test]
    fn fade_shapes_match_shared_sample_table() {
        // 與 analysis/effects.ts 的 fadeCurve 共用同一張表：p ∈ {0, .25, .5, .75, 1}
        let table: [(u8, [f32; 5], [f32; 5]); 3] = [
            (0, [0.0, 0.25, 0.5, 0.75, 1.0], [1.0, 0.75, 0.5, 0.25, 0.0]),
            (1, [0.0, 0.382683, 0.707107, 0.923880, 1.0], [1.0, 0.923880, 0.707107, 0.382683, 0.0]),
            (2, [0.001, 0.005623, 0.031623, 0.177828, 1.0], [1.0, 0.177828, 0.031623, 0.005623, 0.001]),
        ];
        for (shape, fin, fout) in table {
            for (i, p) in [0.0f32, 0.25, 0.5, 0.75, 1.0].iter().enumerate() {
                assert!((fade_curve(shape, *p, true) - fin[i]).abs() < 1e-4, "shape {shape} in p={p}");
                assert!((fade_curve(shape, *p, false) - fout[i]).abs() < 1e-4, "shape {shape} out p={p}");
            }
        }
    }

    #[test]
    fn invert_flips_polarity_with_soft_edges() {
        let base = plan(&[(0.0, 300.0, 0.0)], &[]);
        let reference = run_cutter(&base, ms_to_frames(300.0));
        let mut p = plan(&[(0.0, 300.0, 0.0)], &[]);
        p.effects.push(RenderEffect { kind: "invert".into(), start_ms: 100.0, end_ms: 200.0, db: 0.0, shape: None });
        let out = run_cutter(&p, ms_to_frames(300.0));
        let mid = ms_to_frames(150.0) as usize + 12;
        assert!((out[mid] + reference[mid]).abs() < 1e-5, "中段應為反相：{} vs {}", out[mid], reference[mid]);
        let before = ms_to_frames(50.0) as usize + 12;
        assert!((out[before] - reference[before]).abs() < 1e-5, "範圍外不動");
    }

    #[test]
    fn unknown_effect_kind_is_an_error() {
        let mut p = plan(&[(0.0, 300.0, 0.0)], &[]);
        p.effects.push(RenderEffect { kind: "denoise".into(), start_ms: 0.0, end_ms: 100.0, db: 0.0, shape: None });
        assert!(validate_effects(&p).is_err());
        let ok = plan(&[(0.0, 300.0, 0.0)], &[]);
        assert!(validate_effects(&ok).is_ok());
    }

    #[test]
    fn gain_is_applied() {
        let p = plan(&[(0.0, 100.0, -6.02)], &[]);
        let out = run_cutter(&p, ms_to_frames(200.0));
        let peak = out.iter().fold(0f32, |m, v| m.max(v.abs()));
        assert!((peak - 0.25).abs() < 0.02, "peak={peak}");
    }

    fn stats(input_i: f64, input_tp: f64) -> LoudnormStats {
        LoudnormStats { input_i, input_tp, input_lra: 5.0, input_thresh: input_i - 10.0, target_offset: 0.0, output_i: None, output_tp: None, normalization_type: None }
    }

    #[test]
    fn linear_ceiling_is_input_plus_available_headroom() {
        // 實測的那一組：-17.45 LUFS / -0.49 dBTP、上限 -1.5 → 線性極限 -18.46
        assert!((linear_ceiling_lufs(-1.5, &stats(-17.45, -0.49)) - -18.96).abs() < 0.01, "留 0.5 LU 餘裕");
    }

    #[test]
    fn preserve_dynamics_asks_for_the_widest_loudness_range() {
        // 量到的 LRA 超過請求的就會被壓，跟目標無關 —— 保留動態就是不要約束它
        let mut p = plan(&[], &[]);
        assert_eq!(requested_lra(&p), 11.0);
        p.preserve_dynamics = true;
        assert_eq!(requested_lra(&p), 20.0);
        assert!(loudnorm_base(&p).contains("LRA=20"), "{}", loudnorm_base(&p));
    }

    #[test]
    fn preserve_dynamics_off_keeps_the_users_target() {
        let mut p = plan(&[], &[]);
        p.target_lufs = -16.0;
        // 拉不到也照送 -16：ffmpeg 會自己退回 dynamic，而那件事會被回報出來
        assert_eq!(effective_target_lufs(&p, &stats(-17.45, -0.49)), -16.0);
    }

    #[test]
    fn preserve_dynamics_clamps_to_what_linear_can_reach() {
        let mut p = plan(&[], &[]);
        p.target_lufs = -16.0;
        p.preserve_dynamics = true;
        // -16 拉不到（極限 -18.46）→ 夾到 -18.46，loudnorm 才會留在 linear
        assert!((effective_target_lufs(&p, &stats(-17.45, -0.49)) - -18.96).abs() < 0.01);
    }

    #[test]
    fn preserve_dynamics_never_raises_the_target() {
        let mut p = plan(&[], &[]);
        p.target_lufs = -23.0;
        p.preserve_dynamics = true;
        // 本來就打得到就不要動 —— 這個旗標只會讓成品更小聲，不會更大聲
        assert_eq!(effective_target_lufs(&p, &stats(-17.45, -0.49)), -23.0);
    }

    #[test]
    fn preserve_dynamics_handles_source_already_over_the_ceiling() {
        let mut p = plan(&[], &[]);
        p.target_lufs = -16.0;
        p.preserve_dynamics = true;
        // 來源峰值已經超過上限（-0.09 > -1.5）→ 線性只能往下拉
        let t = effective_target_lufs(&p, &stats(-24.38, -0.09));
        assert!(t < -24.38, "should require attenuation, got {t}");
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
        // 舊版 / 沒有這個欄位的輸出不能整包解析失敗
        assert_eq!(m.normalization_type, None);
    }

    #[test]
    fn parses_normalization_type() {
        // 這一欄是「ffmpeg 有沒有偷偷改用動態壓縮」唯一的證據：我們送的是 linear=true，
        // 但需要的增益會讓峰值超過上限時，它會自己退回 dynamic 而且只在 JSON 裡講一次。
        let s = "[Parsed_loudnorm_0 @ 0x1]\n{\n\t\"input_i\" : \"-51.00\",\n\t\"input_tp\" : \"-17.79\",\n\t\"input_lra\" : \"0.00\",\n\t\"input_thresh\" : \"-61.00\",\n\t\"output_i\" : \"-18.44\",\n\t\"output_tp\" : \"-1.50\",\n\t\"normalization_type\" : \"dynamic\",\n\t\"target_offset\" : \"2.44\"\n}\n";
        let m = parse_loudnorm_json(s).unwrap();
        assert_eq!(m.normalization_type.as_deref(), Some("dynamic"));
        assert_eq!(m.output_i, Some(-18.44));
    }
}
