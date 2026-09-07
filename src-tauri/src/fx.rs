//! 範圍濾波（降噪 / 去爆音 / 去削波 / 去嗡聲 / DC）：在成品時間軸上 punch-in。
//!
//! 主聲軌先由 Cutter 剪成 `concat.wav`（成品時間）。這裡順序讀它，遇到一個 `FxRegion`
//! 就開一個小 ffmpeg 子程序：`-ss/-t` 從同一個 wav 讀那一段（多帶一點 pre-roll 讓濾鏡暖機）、
//! 套濾鏡鏈、吐 f32le 回來；Rust 丟掉 pre-roll 與濾鏡延遲的 frame，再用 10 ms 交叉把 wet 混進 dry。
//! 寫出的 frame 數**永遠等於**讀進來的 —— 效果不改時鐘。
//!
//! 為什麼不用一條 `enable='between(t,a,b)'` 的大 filter_complex：
//! * `acompressor / aecho / areverse / atempo` 沒有 timeline 旗標；
//! * 每個 AVFrame（~21 ms）硬切開關會 click；
//! * FFT 類濾鏡（afftdn）內容延遲 ~30 ms 但 pts 不延遲，邊界會出現重複 / 空洞（spliceAudit 量過的正是這個）。
//! 也不用 `asplit → atrim → 鏈 → concat`：晚開始的分支會在 libavfilter 的 FIFO 裡累積整個後半段。
//!
//! 濾鏡字串一律在這裡組：前端只送型別化的 enum + 數字，數字在這裡 clamp。
//! 未知的 kind 是 serde 錯誤，不是 no-op。
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

/// 型別化的範圍濾波。`kind` 與前端 analysis/fx/regions.ts 的 `RenderRangeFx` 一致。
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RangeFx {
    /// afftdn：nr = 降多少 dB、nf = 底噪（dBFS）。
    Denoise { nr_db: f64, nf_db: f64 },
    /// adeclick：threshold 1–100（越小越敏感）。
    Declick { threshold: f64 },
    /// adeclip：threshold 1–100。
    Declip { threshold: f64 },
    /// 嗡聲：base_hz（50 / 60 附近）與諧波數，逐個 bandreject。
    Hum { base_hz: f64, harmonics: u32 },
    /// DC 偏移：shift = 0 → 10 Hz 高通自動去；否則 dcshift 精確平移。
    Dc { shift: f64 },
}

#[derive(Debug, Clone, Deserialize)]
pub struct FxRegion {
    pub out_start_ms: f64,
    pub out_end_ms: f64,
    pub chain: Vec<RangeFx>,
}

/// 區域邊緣的 wet / dry 交叉（10 ms）。與前端 FX_XF_FRAMES 同一個數字。
pub const XF_FRAMES: u64 = SR as u64 / 100;
/// 短於這個的區域拒收（兩端交叉放不下）。
pub const MIN_REGION_FRAMES: u64 = 2 * XF_FRAMES;
/// 一般濾鏡的 pre-roll：250 ms，遠大於任何濾鏡延遲，也夠 IIR 穩定。
const PAD_FRAMES: u64 = SR as u64 / 4;
/// 降噪的 pre-roll：afftdn 的噪音追蹤（tn=1）要一點時間收斂，給 1 秒。
const DENOISE_PAD_FRAMES: u64 = SR as u64;
/// post-roll：濾鏡延遲 + 相接區域的交叉 + 保險。
const POST_EXTRA_FRAMES: u64 = SR as u64 / 20;

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    if v.is_finite() {
        v.max(lo).min(hi)
    } else {
        lo
    }
}

/// 鏈內順序：先修訊號本身的毛病，再去嗡聲、降噪。與前端 FX_RANK 一致。
fn rank(fx: &RangeFx) -> u8 {
    match fx {
        RangeFx::Dc { .. } => 0,
        RangeFx::Declick { .. } => 1,
        RangeFx::Declip { .. } => 2,
        RangeFx::Hum { .. } => 3,
        RangeFx::Denoise { .. } => 4,
    }
}

fn kind_name(fx: &RangeFx) -> &'static str {
    match fx {
        RangeFx::Denoise { .. } => "denoise",
        RangeFx::Declick { .. } => "declick",
        RangeFx::Declip { .. } => "declip",
        RangeFx::Hum { .. } => "hum",
        RangeFx::Dc { .. } => "dc",
    }
}

/// 單一濾鏡的 ffmpeg 字串（golden 測試釘死）。
pub fn filter_for(fx: &RangeFx) -> String {
    match fx {
        RangeFx::Denoise { nr_db, nf_db } => crate::cleanup::afftdn(*nr_db, *nf_db, true),
        RangeFx::Declick { threshold } => format!("adeclick=t={:.1}", clamp(*threshold, 1.0, 100.0)),
        RangeFx::Declip { threshold } => format!("adeclip=t={:.1}", clamp(*threshold, 1.0, 100.0)),
        RangeFx::Hum { base_hz, harmonics } => {
            let base = clamp(*base_hz, 40.0, 70.0);
            let n = (*harmonics).clamp(1, 8);
            (1..=n)
                .map(|k| {
                    // 越高的諧波越寬（頻率誤差隨 k 放大），但都只有幾 Hz —— 人聲基頻不會被吃到
                    let f = base * k as f64;
                    format!("bandreject=f={:.0}:w={}:t=h", f, 1 + k)
                })
                .collect::<Vec<_>>()
                .join(",")
        }
        RangeFx::Dc { shift } => {
            let s = clamp(*shift, -1.0, 1.0);
            if !shift.is_finite() || s.abs() < 1e-6 {
                // 沒量到精確值就用 10 Hz 高通：DC 是 0 Hz，這一刀離人聲很遠
                "highpass=f=10:poles=2".to_string()
            } else {
                format!("dcshift=shift={s:.4}:limitergain=0.02")
            }
        }
    }
}

/// 整條鏈（依 rank 排，與前端一致；同種類多個就依序都套）。
pub fn chain_filter(chain: &[RangeFx]) -> String {
    let mut sorted: Vec<&RangeFx> = chain.iter().collect();
    sorted.sort_by_key(|f| rank(f));
    sorted.iter().map(|f| filter_for(f)).collect::<Vec<_>>().join(",")
}

/// 濾鏡的內容延遲（frame）：pts 不動、內容往後推的那種。
///
/// 數字由 `fx_latency_calibration`（#[ignore]，要內建 ffmpeg）用 1 kHz tone burst 互相關量出來；
/// ffmpeg 版本一換就要重跑。IIR（bandreject / highpass / dcshift）是 0。
pub fn latency_frames(fx: &RangeFx) -> u64 {
    match fx {
        RangeFx::Denoise { .. } => LAT_AFFTDN,
        RangeFx::Declick { .. } => LAT_ADECLICK,
        RangeFx::Declip { .. } => LAT_ADECLIP,
        RangeFx::Hum { .. } | RangeFx::Dc { .. } => 0,
    }
}

/// afftdn：校準測試量到 1200 frame（25 ms；spliceAudit 在整集成品上看到的 30 ms 還含 highpass 的相位延遲）。
const LAT_AFFTDN: u64 = 1200;
/// adeclick / adeclip：由校準測試填入（見 fx_latency_calibration）。
const LAT_ADECLICK: u64 = 0;
const LAT_ADECLIP: u64 = 0;

pub fn chain_latency_frames(chain: &[RangeFx]) -> u64 {
    chain.iter().map(latency_frames).sum()
}

/// pre-roll：讓濾鏡在區域開始前就暖好機。
pub fn pre_roll_frames(chain: &[RangeFx]) -> u64 {
    chain
        .iter()
        .map(|f| match f {
            RangeFx::Denoise { .. } => DENOISE_PAD_FRAMES,
            _ => PAD_FRAMES,
        })
        .max()
        .unwrap_or(PAD_FRAMES)
}

/// 濾鏡後的波形跟原本還有沒有相關性（決定交叉用線性還是等功率；也是驗收要不要跳過相似度的依據）。
/// R4 的五種都是「修」，保留包絡 → true。
pub fn is_correlated(chain: &[RangeFx]) -> bool {
    let _ = chain;
    true
}

/// 已換算成 frame、排好序、驗過的區域。
#[derive(Debug, Clone)]
pub struct Region {
    pub start: u64,
    pub end: u64,
    pub chain: Vec<RangeFx>,
}

/// 排序 + 驗證：不重疊、縫 0 或 ≥ XF、長度 ≥ 2·XF、鏈非空；超出成品長度的尾巴夾掉。
pub fn validate_regions(regions: &[FxRegion], total_frames: u64) -> AppResult<Vec<Region>> {
    let mut out: Vec<Region> = Vec::new();
    for (i, r) in regions.iter().enumerate() {
        if r.chain.is_empty() {
            return Err(AppError::Invalid(format!("第 {} 段效果的鏈是空的", i + 1)));
        }
        let start = ms_to_frames(r.out_start_ms);
        let end = ms_to_frames(r.out_end_ms).min(total_frames);
        if end <= start {
            continue;
        }
        let mut chain = r.chain.clone();
        chain.sort_by_key(rank);
        out.push(Region { start, end, chain });
    }
    out.sort_by_key(|r| r.start);
    for i in 0..out.len() {
        let r = &out[i];
        if r.end - r.start < MIN_REGION_FRAMES {
            return Err(AppError::Invalid(format!("第 {} 段效果太短（{} ms，至少要 {} ms）", i + 1, (r.end - r.start) * 1000 / SR as u64, MIN_REGION_FRAMES * 1000 / SR as u64)));
        }
        if i > 0 {
            let prev = &out[i - 1];
            if r.start < prev.end {
                return Err(AppError::Invalid(format!("第 {} 與第 {} 段效果重疊（前端應該先拆開）", i, i + 1)));
            }
            let gap = r.start - prev.end;
            if gap > 0 && gap < XF_FRAMES {
                return Err(AppError::Invalid(format!("第 {} 與第 {} 段效果之間的縫太小（{} frame）", i, i + 1, gap)));
            }
        }
    }
    Ok(out)
}

/// 一條 wet 串流：逐 frame 吐出濾鏡後的 PCM。測試用假的，正式用 ffmpeg pipe。
pub trait WetStream: Send {
    fn next_frame(&mut self, out: &mut [f32]) -> impl std::future::Future<Output = AppResult<bool>> + Send;
}

/// 開 wet 串流：`pre` 個 pre-roll frame 在區域起點之前、`post` 個在終點之後（都要吐出來，core 自己丟）。
pub trait WetOpener: Send {
    type Stream: WetStream;
    fn open(&mut self, region: &Region, pre: u64, post: u64, ch: usize) -> impl std::future::Future<Output = AppResult<Self::Stream>> + Send;
}

/// 與 dry 的混合權重：線性（相關）或等功率（不相關）。回 (dry 權重, wet 權重)。
fn weights(w: f32, correlated: bool) -> (f32, f32) {
    if correlated {
        (1.0 - w, w)
    } else {
        let a = (w as f64 * std::f64::consts::FRAC_PI_2) as f32;
        (a.cos(), a.sin())
    }
}

fn ramp(d: u64) -> f32 {
    // d = 距離邊界幾個 frame（0 = 第一個 frame）；第 XF 個 frame 起全 wet
    (((d + 1) as f32) / XF_FRAMES as f32).min(1.0)
}

fn kinds_label(chain: &[RangeFx]) -> String {
    chain.iter().map(kind_name).collect::<Vec<_>>().join("+")
}

/// punch-in 核心（純帳目，不碰檔案）：dry 逐 frame 進來、regions 決定哪裡換成 wet、sink 逐 frame 收。
///
/// 回傳寫出的 frame 數，**一定等於** `total_frames`。wet 串流提早結束一律報錯，不會退回 dry。
pub async fn punch_in_core<O, D, S, P>(
    mut dry: D,
    total_frames: u64,
    ch: usize,
    regions: &[Region],
    opener: &mut O,
    mut sink: S,
    mut progress: P,
    cancel: &AtomicBool,
) -> AppResult<u64>
where
    O: WetOpener,
    D: FnMut(&mut [f32]) -> AppResult<bool>,
    S: FnMut(&[f32]) -> AppResult<()>,
    P: FnMut(f32),
{
    let mut dry_frame = vec![0f32; ch];
    let mut wet_frame = vec![0f32; ch];
    let mut prev_frame = vec![0f32; ch];
    let mut out = vec![0f32; ch];
    let mut ri = 0usize;
    let mut cur: Option<O::Stream> = None;
    // 前一段的 wet 串流：兩段相接時，後段的頭 XF frame 是 wet→wet 交叉，前段還要再吐 XF 個 frame
    let mut tail: Option<O::Stream> = None;
    let mut last_pct = -1.0f32;
    let mut written = 0u64;

    for t in 0..total_frames {
        if cancel.load(Ordering::Relaxed) {
            return Err(AppError::Canceled);
        }
        if !dry(&mut dry_frame)? {
            return Err(AppError::Ffmpeg(format!("concat.wav 比預期短（{t} / {total_frames} frame）")));
        }

        // 這個 frame 該開始哪一段
        if ri < regions.len() && regions[ri].start == t {
            let r = &regions[ri];
            let pre = pre_roll_frames(&r.chain).min(t);
            let lat = chain_latency_frames(&r.chain);
            let touching_next = regions.get(ri + 1).map(|n| n.start == r.end).unwrap_or(false);
            let post = lat + POST_EXTRA_FRAMES + if touching_next { XF_FRAMES } else { 0 };
            let mut s = opener.open(r, pre, post, ch).await?;
            // 丟掉 pre-roll 與濾鏡延遲：wet 的第一個有效 frame 才對得上 dry 的 start
            for _ in 0..(pre + lat) {
                if !s.next_frame(&mut wet_frame).await? {
                    return Err(AppError::Ffmpeg(format!("濾鏡回傳的長度不對（{} 第 {} 段：暖機都不夠）", kinds_label(&r.chain), ri + 1)));
                }
            }
            cur = Some(s);
        }

        let inside = ri < regions.len() && t >= regions[ri].start && t < regions[ri].end;
        if inside {
            let r = &regions[ri];
            let s = cur.as_mut().expect("wet stream open");
            if !s.next_frame(&mut wet_frame).await? {
                return Err(AppError::Ffmpeg(format!("濾鏡回傳的長度不對（{} 第 {} 段，在 {} ms）", kinds_label(&r.chain), ri + 1, t * 1000 / SR as u64)));
            }
            let din = t - r.start;
            let dout = r.end - 1 - t;
            let touching_prev = ri > 0 && regions[ri - 1].end == r.start;
            let touching_next = regions.get(ri + 1).map(|n| n.start == r.end).unwrap_or(false);
            let correlated = is_correlated(&r.chain);
            if touching_prev && din < XF_FRAMES {
                // 頭：從前一段的 wet 交叉過來（不是從 dry），縫上聽不到 dry 漏進來
                let ps = tail.as_mut().expect("tail stream");
                if !ps.next_frame(&mut prev_frame).await? {
                    return Err(AppError::Ffmpeg(format!("濾鏡回傳的長度不對（{} 第 {} 段：相接的尾巴不夠）", kinds_label(&regions[ri - 1].chain), ri)));
                }
                let (wa, wb) = weights(ramp(din), correlated && is_correlated(&regions[ri - 1].chain));
                for i in 0..ch {
                    out[i] = prev_frame[i] * wa + wet_frame[i] * wb;
                }
                if din + 1 == XF_FRAMES {
                    tail = None;
                }
            } else {
                let head = if touching_prev { 1.0 } else { ramp(din) };
                let end_w = if touching_next { 1.0 } else { ramp(dout) };
                let w = head.min(end_w);
                let (wa, wb) = weights(w, correlated);
                for i in 0..ch {
                    out[i] = dry_frame[i] * wa + wet_frame[i] * wb;
                }
            }
            if t + 1 == r.end {
                // 段結束：相接的話留著給下一段當交叉來源，否則關掉
                let s = cur.take().expect("wet stream");
                if touching_next {
                    tail = Some(s);
                } else {
                    drop(s);
                }
                ri += 1;
            }
            sink(&out)?;
        } else {
            sink(&dry_frame)?;
        }
        written += 1;

        if total_frames > 0 {
            let pct = (t as f64 / total_frames as f64 * 100.0) as f32;
            if pct - last_pct >= 2.0 {
                last_pct = pct;
                progress(pct);
            }
        }
    }
    if tail.is_some() {
        // 相接的最後一段被 total 夾掉了 —— 帳目上不可能（validate 夾過），但不要默默吞
        return Err(AppError::Invalid("相接的效果段在成品結尾被截斷".into()));
    }
    Ok(written)
}

// ---------------- ffmpeg 版的 wet 串流 ----------------

pub struct FfmpegWet {
    child: Child,
    buf: Vec<u8>,
    carry: Vec<u8>,
    pos: usize,
    eof: bool,
}

impl WetStream for FfmpegWet {
    async fn next_frame(&mut self, out: &mut [f32]) -> AppResult<bool> {
        let frame_bytes = 4 * out.len();
        while self.carry.len() - self.pos < frame_bytes && !self.eof {
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

impl Drop for FfmpegWet {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

pub struct FfmpegOpener<'a> {
    pub bins: &'a FfmpegBins,
    pub in_wav: std::path::PathBuf,
}

impl WetOpener for FfmpegOpener<'_> {
    type Stream = FfmpegWet;
    async fn open(&mut self, region: &Region, pre: u64, post: u64, ch: usize) -> AppResult<FfmpegWet> {
        let ss = (region.start - pre) as f64 / SR as f64;
        let dur = (region.end - region.start + pre + post) as f64 / SR as f64;
        let af = chain_filter(&region.chain);
        let mut c = proc::cmd(&self.bins.ffmpeg);
        c.args(["-nostdin", "-hide_banner", "-loglevel", "error"]);
        // wav 是 PCM，-ss 在 -i 前面是精確的 byte 位移，不會落在「前一個 keyframe」
        c.args(["-ss", &format!("{ss:.6}")]);
        c.arg("-i");
        c.arg(&self.in_wav);
        c.args(["-t", &format!("{dur:.6}"), "-af", &af]);
        c.args(["-f", "f32le", "-ar", "48000", "-ac", &ch.to_string(), "pipe:1"]);
        c.stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
        let child = c.spawn().map_err(|e| AppError::Ffmpeg(format!("範圍濾波啟動失敗（{}）：{e}", kinds_label(&region.chain))))?;
        Ok(FfmpegWet { child, buf: vec![0u8; 64 * 1024], carry: Vec::new(), pos: 0, eof: false })
    }
}

/// 把 plan.fx_regions 套到 `in_wav`（成品時間的 concat.wav）上，寫出 `out_wav`。回傳寫了幾個 frame。
pub async fn punch_in(app: &AppHandle, bins: &FfmpegBins, plan: &RenderPlan, in_wav: &std::path::Path, out_wav: &std::path::Path, job_id: &str, cancel: &AtomicBool) -> AppResult<u64> {
    let ch = plan.channels.max(1) as usize;
    let mut reader = hound::WavReader::open(in_wav).map_err(|e| AppError::Io(format!("讀取 concat.wav 失敗：{e}")))?;
    let total = reader.len() as u64 / ch as u64;
    let regions = validate_regions(&plan.fx_regions, total)?;
    let spec = hound::WavSpec { channels: ch as u16, sample_rate: SR, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
    let file = std::fs::File::create(out_wav)?;
    let mut writer = hound::WavWriter::new(std::io::BufWriter::new(file), spec).map_err(|e| AppError::Io(format!("建立 fx.wav 失敗：{e}")))?;
    let mut samples = reader.samples::<f32>();
    let mut opener = FfmpegOpener { bins, in_wav: in_wav.to_path_buf() };
    let written = punch_in_core(
        |frame: &mut [f32]| {
            for v in frame.iter_mut() {
                *v = match samples.next() {
                    Some(Ok(x)) => x,
                    Some(Err(e)) => return Err(AppError::Io(format!("讀 concat.wav 失敗：{e}"))),
                    None => return Ok(false),
                };
            }
            Ok(true)
        },
        total,
        ch,
        &regions,
        &mut opener,
        |frame: &[f32]| {
            for v in frame {
                writer.write_sample(*v).map_err(|e| AppError::Io(format!("寫 fx.wav 失敗：{e}")))?;
            }
            Ok(())
        },
        |pct| emit_progress(app, job_id, "fx", pct),
        cancel,
    )
    .await?;
    writer.finalize().map_err(|e| AppError::Io(format!("關閉 fx.wav 失敗：{e}")))?;
    Ok(written)
}

// ---------------- A/B 試聽（對來源檔直接切一段） ----------------

#[derive(Debug, Clone, Serialize)]
pub struct PreviewPair {
    pub dry: String,
    pub wet: String,
}

/// 對**來源檔**直接 `-ss/-t` 切一段做 dry / wet 各一份 mp3（q5）。不走 Cutter：
/// cut_to_wav 會從 0 解到選取結尾，第 50 分鐘的一段要等 20 秒；這裡 15 秒的段 < 1 秒。
/// 兩份同樣的 -ss、同樣的編碼器延遲，所以 A/B 切換時樣本對得齊；wet 多帶 pre-roll 讓濾鏡暖機，
/// 再用 atrim 依 frame 切回來（連濾鏡延遲一起扣掉）。
pub async fn preview(bins: &FfmpegBins, src: &str, start_ms: f64, end_ms: f64, chain: &[RangeFx], out_dir: &std::path::Path, key: &str) -> AppResult<PreviewPair> {
    if chain.is_empty() {
        return Err(AppError::Invalid("沒有效果可以試聽".into()));
    }
    let start = start_ms.max(0.0);
    let len = (end_ms - start).max(200.0);
    tokio::fs::create_dir_all(out_dir).await?;
    let dry = out_dir.join(format!("fx-{key}-dry.mp3"));
    let wet = out_dir.join(format!("fx-{key}-wet.mp3"));
    if !dry.is_file() {
        let mut c = proc::cmd(&bins.ffmpeg);
        c.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y"]);
        c.args(["-ss", &format!("{:.6}", start / 1000.0), "-i"]);
        c.arg(src);
        c.args(["-t", &format!("{:.6}", len / 1000.0), "-vn", "-ar", "48000", "-c:a", "libmp3lame", "-q:a", "5"]);
        c.arg(&dry);
        let o = c.output().await.map_err(|e| AppError::Ffmpeg(format!("ffmpeg 啟動失敗：{e}")))?;
        if !o.status.success() {
            return Err(AppError::Ffmpeg(format!("試聽（原始）失敗：{}", String::from_utf8_lossy(&o.stderr).trim())));
        }
    }
    if !wet.is_file() {
        let mut sorted = chain.to_vec();
        sorted.sort_by_key(rank);
        let pre = pre_roll_frames(&sorted).min(ms_to_frames(start));
        let lat = chain_latency_frames(&sorted);
        let ss = (ms_to_frames(start) - pre) as f64 / SR as f64;
        let dur = (ms_to_frames(len) + pre + lat + POST_EXTRA_FRAMES) as f64 / SR as f64;
        let af = format!("aresample=48000,{},atrim=start_sample={}:end_sample={},asetpts=PTS-STARTPTS", chain_filter(&sorted), pre + lat, pre + lat + ms_to_frames(len));
        let mut c = proc::cmd(&bins.ffmpeg);
        c.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y"]);
        c.args(["-ss", &format!("{ss:.6}"), "-i"]);
        c.arg(src);
        c.args(["-t", &format!("{dur:.6}"), "-vn", "-af", &af, "-c:a", "libmp3lame", "-q:a", "5"]);
        c.arg(&wet);
        let o = c.output().await.map_err(|e| AppError::Ffmpeg(format!("ffmpeg 啟動失敗：{e}")))?;
        if !o.status.success() {
            return Err(AppError::Ffmpeg(format!("試聽（處理後）失敗：{}", String::from_utf8_lossy(&o.stderr).trim())));
        }
    }
    Ok(PreviewPair { dry: dry.to_string_lossy().into_owned(), wet: wet.to_string_lossy().into_owned() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    fn dn(nr: f64, nf: f64) -> RangeFx {
        RangeFx::Denoise { nr_db: nr, nf_db: nf }
    }

    #[test]
    fn golden_filter_strings() {
        assert_eq!(filter_for(&dn(12.0, -50.0)), "afftdn=nr=12.0:nf=-50:tn=1");
        assert_eq!(filter_for(&RangeFx::Declick { threshold: 2.0 }), "adeclick=t=2.0");
        assert_eq!(filter_for(&RangeFx::Declip { threshold: 10.0 }), "adeclip=t=10.0");
        assert_eq!(filter_for(&RangeFx::Hum { base_hz: 60.0, harmonics: 3 }), "bandreject=f=60:w=2:t=h,bandreject=f=120:w=3:t=h,bandreject=f=180:w=4:t=h");
        assert_eq!(filter_for(&RangeFx::Dc { shift: 0.0 }), "highpass=f=10:poles=2");
        assert_eq!(filter_for(&RangeFx::Dc { shift: -0.0312 }), "dcshift=shift=-0.0312:limitergain=0.02");
    }

    #[test]
    fn numbers_are_clamped_not_trusted() {
        assert_eq!(filter_for(&dn(99.0, 5.0)), "afftdn=nr=30.0:nf=-20:tn=1");
        assert_eq!(filter_for(&dn(-3.0, -200.0)), "afftdn=nr=1.0:nf=-80:tn=1");
        assert_eq!(filter_for(&RangeFx::Declick { threshold: 0.0 }), "adeclick=t=1.0");
        assert_eq!(filter_for(&RangeFx::Hum { base_hz: 1000.0, harmonics: 99 }).matches("bandreject").count(), 8);
        assert!(filter_for(&RangeFx::Hum { base_hz: 1000.0, harmonics: 1 }).starts_with("bandreject=f=70:"));
        assert_eq!(filter_for(&RangeFx::Dc { shift: f64::NAN }), "highpass=f=10:poles=2");
    }

    #[test]
    fn chain_is_ordered_by_rank_not_by_input_order() {
        let c = vec![dn(12.0, -50.0), RangeFx::Dc { shift: 0.0 }, RangeFx::Declick { threshold: 2.0 }];
        assert_eq!(chain_filter(&c), "highpass=f=10:poles=2,adeclick=t=2.0,afftdn=nr=12.0:nf=-50:tn=1");
    }

    #[test]
    fn unknown_kind_is_a_serde_error_not_a_noop() {
        let r: Result<RangeFx, _> = serde_json::from_str(r#"{"kind":"flanger","depth":1}"#);
        assert!(r.is_err());
        let ok: RangeFx = serde_json::from_str(r#"{"kind":"hum","base_hz":50,"harmonics":4}"#).unwrap();
        assert_eq!(ok, RangeFx::Hum { base_hz: 50.0, harmonics: 4 });
    }

    fn reg(a: f64, b: f64) -> FxRegion {
        FxRegion { out_start_ms: a, out_end_ms: b, chain: vec![dn(12.0, -50.0)] }
    }

    #[test]
    fn validate_sorts_clamps_and_rejects() {
        let v = validate_regions(&[reg(5000.0, 6000.0), reg(1000.0, 2000.0)], ms_to_frames(5500.0)).unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].start, ms_to_frames(1000.0));
        assert_eq!(v[1].end, ms_to_frames(5500.0), "超出成品長度的尾巴夾掉");
        assert!(validate_regions(&[reg(1000.0, 1015.0)], ms_to_frames(9000.0)).is_err(), "太短");
        assert!(validate_regions(&[reg(1000.0, 2000.0), reg(1500.0, 3000.0)], ms_to_frames(9000.0)).is_err(), "重疊");
        assert!(validate_regions(&[reg(1000.0, 2000.0), reg(2005.0, 3000.0)], ms_to_frames(9000.0)).is_err(), "縫太小");
        assert!(validate_regions(&[reg(1000.0, 2000.0), reg(2000.0, 3000.0)], ms_to_frames(9000.0)).is_ok(), "相接可以");
        assert!(validate_regions(&[reg(1000.0, 2000.0), reg(2010.0, 3000.0)], ms_to_frames(9000.0)).is_ok(), "縫 = XF 可以");
        assert!(validate_regions(&[FxRegion { out_start_ms: 0.0, out_end_ms: 1000.0, chain: vec![] }], 48000).is_err(), "空鏈");
        // 完全在成品長度之外的段直接消失，不報錯
        assert!(validate_regions(&[reg(9000.0, 9500.0)], ms_to_frames(5000.0)).unwrap().is_empty());
    }

    /// 假 wet：每個區域回一個固定值（或 dry 的複本）；記錄 opener 收到的 pre / post，
    /// 並先吐 pre + lat 個「垃圾」frame（值 99）模擬暖機與延遲 —— 有一個漏進成品就會被抓到。
    struct FakeStream {
        q: VecDeque<f32>,
        ch: usize,
    }
    impl WetStream for FakeStream {
        async fn next_frame(&mut self, out: &mut [f32]) -> AppResult<bool> {
            if self.q.len() < self.ch {
                return Ok(false);
            }
            for v in out.iter_mut() {
                *v = self.q.pop_front().unwrap();
            }
            Ok(true)
        }
    }
    struct FakeOpener {
        /// 每個區域的 wet 值（依 start 排序後的索引）
        values: Vec<f32>,
        calls: Vec<(u64, u64)>,
        /// 少吐幾個 frame（模擬濾鏡回傳長度不對）
        short_by: u64,
        idx: usize,
    }
    impl WetOpener for FakeOpener {
        type Stream = FakeStream;
        async fn open(&mut self, region: &Region, pre: u64, post: u64, ch: usize) -> AppResult<FakeStream> {
            self.calls.push((pre, post));
            let v = self.values[self.idx.min(self.values.len() - 1)];
            self.idx += 1;
            let lat = chain_latency_frames(&region.chain);
            let mut q = VecDeque::new();
            for _ in 0..(pre + lat) {
                for _ in 0..ch {
                    q.push_back(99.0);
                }
            }
            let n = (region.end - region.start + post).saturating_sub(self.short_by);
            for _ in 0..n {
                for c in 0..ch {
                    q.push_back(v + c as f32 * 1000.0);
                }
            }
            Ok(FakeStream { q, ch })
        }
    }

    async fn run(dry_val: f32, total: u64, ch: usize, regions: &[FxRegion], opener: &mut FakeOpener) -> AppResult<Vec<f32>> {
        let regs = validate_regions(regions, total)?;
        let mut out: Vec<f32> = Vec::new();
        let cancel = AtomicBool::new(false);
        let n = punch_in_core(
            |f: &mut [f32]| {
                for (i, v) in f.iter_mut().enumerate() {
                    *v = dry_val + i as f32 * 1000.0;
                }
                Ok(true)
            },
            total,
            ch,
            &regs,
            opener,
            |f: &[f32]| {
                out.extend_from_slice(f);
                Ok(())
            },
            |_| {},
            &cancel,
        )
        .await?;
        assert_eq!(n, total);
        assert_eq!(out.len() as u64, total * ch as u64);
        Ok(out)
    }

    #[tokio::test]
    async fn keeps_length_and_leaves_untouched_frames_bit_identical() {
        let total = ms_to_frames(3000.0);
        let mut op = FakeOpener { values: vec![0.0], calls: vec![], short_by: 0, idx: 0 };
        let out = run(0.25, total, 1, &[reg(1000.0, 2000.0)], &mut op).await.unwrap();
        let (a, b) = (ms_to_frames(1000.0) as usize, ms_to_frames(2000.0) as usize);
        assert!(out[..a].iter().all(|&v| v == 0.25));
        assert!(out[b..].iter().all(|&v| v == 0.25));
        // 交叉之後的內部是純 wet（0）
        assert!(out[a + XF_FRAMES as usize..b - XF_FRAMES as usize].iter().all(|&v| v == 0.0));
        // 邊緣是單調的斜坡
        assert!(out[a] > 0.0 && out[a] < 0.25);
        assert!(out[a + 1] < out[a]);
        assert!(out[b - 1] > 0.0 && out[b - 1] < 0.25);
        // pre-roll：降噪要 1 秒，區域剛好從 1 秒開始 → pre = 1 秒；post ≥ 延遲 + 保險
        assert_eq!(op.calls, vec![(SR as u64, LAT_AFFTDN + POST_EXTRA_FRAMES)]);
        // 沒有一個暖機 frame（99）漏進成品
        assert!(out.iter().all(|&v| v < 1.0));
    }

    #[tokio::test]
    async fn crossfade_is_identity_when_wet_equals_dry() {
        let total = ms_to_frames(2000.0);
        let mut op = FakeOpener { values: vec![0.5], calls: vec![], short_by: 0, idx: 0 };
        let out = run(0.5, total, 1, &[reg(200.0, 1500.0)], &mut op).await.unwrap();
        assert!(out.iter().all(|&v| (v - 0.5).abs() < 1e-6));
    }

    #[tokio::test]
    async fn pre_roll_is_clamped_at_file_start() {
        let total = ms_to_frames(2000.0);
        let mut op = FakeOpener { values: vec![0.0], calls: vec![], short_by: 0, idx: 0 };
        run(0.25, total, 1, &[reg(100.0, 1000.0)], &mut op).await.unwrap();
        assert_eq!(op.calls[0].0, ms_to_frames(100.0), "檔案開頭之前沒有東西可以 pre-roll");
    }

    #[tokio::test]
    async fn touching_regions_crossfade_wet_to_wet_and_sum_to_one() {
        let total = ms_to_frames(3000.0);
        // A 的 wet 是 0.3、B 的 wet 也是 0.3、dry 是 0：相接處如果漏了 dry 進來會掉到 0.3 以下
        let mut op = FakeOpener { values: vec![0.3, 0.3], calls: vec![], short_by: 0, idx: 0 };
        let out = run(0.0, total, 1, &[reg(500.0, 1500.0), reg(1500.0, 2500.0)], &mut op).await.unwrap();
        let (a, m, b) = (ms_to_frames(500.0) as usize, ms_to_frames(1500.0) as usize, ms_to_frames(2500.0) as usize);
        assert!(out[a + XF_FRAMES as usize..b - XF_FRAMES as usize].iter().all(|&v| (v - 0.3).abs() < 1e-6), "相接處要保持 0.3");
        assert!(out[m - 1] > 0.29 && out[m] > 0.29 && out[m + 1] > 0.29);
        // A 的 post 要多帶 XF（給 B 的頭當交叉來源）
        assert_eq!(op.calls[0].1, LAT_AFFTDN + POST_EXTRA_FRAMES + XF_FRAMES);
        assert_eq!(op.calls[1].1, LAT_AFFTDN + POST_EXTRA_FRAMES);
        // 換一組值：A=1、B=−1 → 縫上單調地從 1 走到 −1
        let mut op2 = FakeOpener { values: vec![1.0, -1.0], calls: vec![], short_by: 0, idx: 0 };
        let out2 = run(0.0, total, 1, &[reg(500.0, 1500.0), reg(1500.0, 2500.0)], &mut op2).await.unwrap();
        for i in m..m + XF_FRAMES as usize - 1 {
            assert!(out2[i + 1] <= out2[i], "縫上要單調下降");
        }
        assert!((out2[m + XF_FRAMES as usize] + 1.0).abs() < 1e-6);
        assert!((out2[m - 1] - 1.0).abs() < 1e-6, "A 的尾巴不淡回 dry");
    }

    #[tokio::test]
    async fn stereo_frames_stay_interleaved() {
        let total = ms_to_frames(1000.0);
        let mut op = FakeOpener { values: vec![0.1], calls: vec![], short_by: 0, idx: 0 };
        let out = run(0.7, total, 2, &[reg(200.0, 800.0)], &mut op).await.unwrap();
        let mid = ms_to_frames(500.0) as usize * 2;
        assert!((out[mid] - 0.1).abs() < 1e-6 && (out[mid + 1] - 1000.1).abs() < 1e-3);
        assert!((out[10] - 0.7).abs() < 1e-6 && (out[11] - 1000.7).abs() < 1e-3);
    }

    #[tokio::test]
    async fn short_wet_stream_is_an_error_not_silent_dry() {
        let total = ms_to_frames(2000.0);
        let mut op = FakeOpener { values: vec![0.0], calls: vec![], short_by: 5000, idx: 0 };
        let e = run(0.25, total, 1, &[reg(500.0, 1500.0)], &mut op).await.unwrap_err();
        assert!(e.message().contains("長度不對"), "{}", e.message());
    }

    #[tokio::test]
    async fn no_regions_is_a_straight_copy() {
        let total = 1000;
        let mut op = FakeOpener { values: vec![0.0], calls: vec![], short_by: 0, idx: 0 };
        let out = run(0.4, total, 1, &[], &mut op).await.unwrap();
        assert!(out.iter().all(|&v| v == 0.4));
        assert!(op.calls.is_empty());
    }

    // ---------------- 要內建 ffmpeg 的測試（cargo test -- --ignored fx_） ----------------

    fn bundled_bins() -> Option<FfmpegBins> {
        let dir = crate::ffmpeg::bundled_candidate(std::path::Path::new(env!("CARGO_MANIFEST_DIR")));
        let exe = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
        let p = dir.join(exe);
        p.is_file().then(|| FfmpegBins { ffmpeg: p.to_string_lossy().into_owned(), ffprobe: String::new(), version: String::new(), source: "bundled".into() })
    }

    fn write_wav(path: &std::path::Path, samples: &[f32], ch: u16) {
        let spec = hound::WavSpec { channels: ch, sample_rate: SR, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
        let mut w = hound::WavWriter::create(path, spec).unwrap();
        for s in samples {
            w.write_sample(*s).unwrap();
        }
        w.finalize().unwrap();
    }

    fn read_wav(path: &std::path::Path) -> Vec<f32> {
        hound::WavReader::open(path).unwrap().samples::<f32>().map(|s| s.unwrap()).collect()
    }

    /// 互相關找延遲：wet 相對 dry 往後推了幾個 frame（0..max）。
    fn lag_of(dry: &[f32], wet: &[f32], max: usize) -> usize {
        let n = dry.len().min(wet.len()) - max;
        let mut best = (0usize, f64::MIN);
        for lag in 0..max {
            let mut acc = 0f64;
            for i in 0..n {
                acc += dry[i] as f64 * wet[i + lag] as f64;
            }
            if acc > best.1 {
                best = (lag, acc);
            }
        }
        best.0
    }

    /// 用 1 kHz tone burst 量每種濾鏡的內容延遲。ffmpeg 一換版就重跑，把數字填回 LAT_*。
    #[tokio::test]
    #[ignore]
    async fn fx_latency_calibration() {
        let Some(bins) = bundled_bins() else {
            eprintln!("no bundled ffmpeg; skip");
            return;
        };
        let dir = std::env::temp_dir().join(format!("aicut-fx-cal-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let n = SR as usize * 3;
        let mut dry = vec![0f32; n];
        // 0.5–2.5 秒之間每 250 ms 一個 20 ms 的 1 kHz burst，之間是低電平雜訊（讓 afftdn 有東西追）
        let mut seed = 7u32;
        for (i, v) in dry.iter_mut().enumerate() {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let noise = ((seed >> 9) as f32 / (1u32 << 23) as f32 - 1.0) * 0.002;
            let t = i as f32 / SR as f32;
            let in_burst = t > 0.5 && t < 2.5 && ((t * 4.0).fract() < 0.08);
            *v = noise + if in_burst { 0.5 * (2.0 * std::f32::consts::PI * 1000.0 * t).sin() } else { 0.0 };
        }
        let src = dir.join("dry.wav");
        write_wav(&src, &dry, 1);
        for fx in [dn(12.0, -50.0), RangeFx::Declick { threshold: 2.0 }, RangeFx::Declip { threshold: 10.0 }, RangeFx::Hum { base_hz: 60.0, harmonics: 2 }, RangeFx::Dc { shift: 0.0 }] {
            let out = dir.join(format!("{}.wav", kind_name(&fx)));
            let mut c = proc::cmd(&bins.ffmpeg);
            c.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i"]);
            c.arg(&src);
            c.args(["-af", &filter_for(&fx), "-c:a", "pcm_f32le"]);
            c.arg(&out);
            let o = c.output().await.unwrap();
            assert!(o.status.success(), "{}: {}", kind_name(&fx), String::from_utf8_lossy(&o.stderr));
            let wet = read_wav(&out);
            let lag = lag_of(&dry, &wet, 4800);
            eprintln!("[fx-cal] {:<8} latency = {} frames ({:.2} ms), out len {} vs in {}", kind_name(&fx), lag, lag as f64 * 1000.0 / SR as f64, wet.len(), dry.len());
            let table = latency_frames(&fx) as i64;
            assert!((lag as i64 - table).abs() <= 2, "{}: 表上是 {} 但量到 {} —— 把 LAT_* 更新成量到的值", kind_name(&fx), table, lag);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 端到端：真的跑 ffmpeg 降噪一段。區域外逐 sample 相等、區域內 RMS 下降、長度相等。
    #[tokio::test]
    #[ignore]
    async fn fx_end_to_end_denoise_region() {
        let Some(bins) = bundled_bins() else {
            eprintln!("no bundled ffmpeg; skip");
            return;
        };
        let dir = std::env::temp_dir().join(format!("aicut-fx-e2e-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let n = SR as usize * 6;
        let mut dry = vec![0f32; n];
        let mut seed = 3u32;
        for (i, v) in dry.iter_mut().enumerate() {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let noise = ((seed >> 9) as f32 / (1u32 << 23) as f32 - 1.0) * 0.02;
            let t = i as f32 / SR as f32;
            *v = noise + 0.3 * (2.0 * std::f32::consts::PI * 220.0 * t).sin() * if (t * 2.0).fract() < 0.5 { 1.0 } else { 0.0 };
        }
        let src = dir.join("concat.wav");
        write_wav(&src, &dry, 1);
        let out = dir.join("fx.wav");
        let mut regions = vec![reg(2000.0, 4000.0)];
        regions[0].chain = vec![dn(18.0, -34.0)];
        let regs = validate_regions(&regions, n as u64).unwrap();
        let mut opener = FfmpegOpener { bins: &bins, in_wav: src.clone() };
        let mut reader = hound::WavReader::open(&src).unwrap();
        let mut samples = reader.samples::<f32>();
        let mut got: Vec<f32> = Vec::new();
        let cancel = AtomicBool::new(false);
        let written = punch_in_core(
            |f: &mut [f32]| {
                for v in f.iter_mut() {
                    *v = match samples.next() {
                        Some(Ok(x)) => x,
                        _ => return Ok(false),
                    };
                }
                Ok(true)
            },
            n as u64,
            1,
            &regs,
            &mut opener,
            |f: &[f32]| {
                got.extend_from_slice(f);
                Ok(())
            },
            |_| {},
            &cancel,
        )
        .await
        .unwrap();
        write_wav(&out, &got, 1);
        assert_eq!(written, n as u64);
        assert_eq!(got.len(), dry.len());
        let (a, b) = (ms_to_frames(2000.0) as usize, ms_to_frames(4000.0) as usize);
        assert!(got[..a].iter().zip(&dry[..a]).all(|(x, y)| x == y), "區域前要逐 sample 相等");
        assert!(got[b..].iter().zip(&dry[b..]).all(|(x, y)| x == y), "區域後要逐 sample 相等");
        // 區域內「靜音的那一半」（只有雜訊）RMS 要明顯下降
        let rms = |s: &[f32]| (s.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / s.len() as f64).sqrt();
        // 音在每 500 ms 的前半；2.75–3.0 s 是純雜訊
        let quiet_dry = rms(&dry[ms_to_frames(2760.0) as usize..ms_to_frames(2990.0) as usize]);
        let quiet_wet = rms(&got[ms_to_frames(2760.0) as usize..ms_to_frames(2990.0) as usize]);
        eprintln!("[fx-e2e] quiet rms dry {quiet_dry:.5} wet {quiet_wet:.5}");
        // 白雜訊 2 秒、nr=18：實測降 ~2.5 dB（afftdn 對寬頻白雜訊本來就保守，真實嘶聲降得多）
        assert!(quiet_wet < quiet_dry * 0.85, "降噪要真的降（dry {quiet_dry} wet {quiet_wet}）");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
