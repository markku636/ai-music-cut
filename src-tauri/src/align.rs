//! 時間對齊的渲染（VocALign 的 Dub 扭到 Guide 上）：**自己做 WSOLA**，不再靠 ffmpeg 的 atempo。
//!
//! 走過的路：第一版單一個 atempo + asendcmd runtime 換速 —— 每下一次指令後面內容整體提前 ~21 ms，
//! 三次之後跳 +400 ms。第二版每段一個 atempo、用脈衝列校準它開頭少吐的量 —— 脈衝列上對到 1 ms，
//! 換成真人講話卻穩定晚 30 ms：atempo 的 WSOLA 每一步都在「往前找最像的地方」，落點的平均值
//! 跟內容有關，校準不出一個常數。ADR 要的是 5 ms，atempo 給不了。
//!
//! 這裡的 WSOLA 反過來設計：**輸出時間是主時鐘**。每 10 ms 一個輸出格，依扭曲函數算出它「應該」
//! 從 dub 的哪個位置取 20 ms 的 grain，只在 ±5 ms 內找跟上一個 grain 接得最順的位置（離理想位置
//! 越遠扣一點分），Hann 視窗 50% 重疊相加。落點誤差**永遠**在 ±5 ms 內而且不累積（每格都回到理想
//! 位置找），拉長 / 縮短都一樣；代價是伸縮比例大時（0.7 倍以下）會有一點 phasing —— 對齊的比例幾乎都在 0.9–1.1。
//! 輸出 `<dub>_aligned.wav`（pcm_s24le 48k），原檔不動。
use std::io::{BufWriter, Read};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::ffmpeg::FfmpegBins;
use crate::proc;

const SR: usize = 48_000;
/// grain 長度（20 ms）與 hop（10 ms，50% 重疊 → Hann 相加恆為 1）。
const WIN: usize = 960;
const HOP: usize = WIN / 2;
/// 落點搜尋範圍 ±5 ms：要蓋得住一個基頻週期（男聲 ~100 Hz = 10 ms）才找得到同相位的接法；
/// 再大就開始有 atempo 那種內容相關的漂移。
const SEARCH: i64 = 240;
/// 離理想位置越遠扣越多（滿範圍扣 0.05）：相關性差不多時（氣音、靜音）留在理想位置，不要亂跑。
const DRIFT_PENALTY: f32 = 0.05;

#[derive(Debug, Clone, Deserialize)]
pub struct AlignSegment {
    /// 這一段從 dub 的哪裡開始（毫秒，原始 dub 時間）。
    pub dub_start_ms: f64,
    /// 速率 tempo（> 1 縮短、< 1 拉長）：輸出 1 秒 = dub 的 tempo 秒。前端已 clamp 0.5–2。
    pub tempo: f64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AlignSpec {
    pub src: String,
    pub out_path: String,
    /// dub 相對 guide 的位移：正 = dub 要往後推（前面補靜音）；負 = 砍掉扭完之後的開頭。
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

fn clamp_tempo(t: f64) -> f64 {
    if t.is_finite() {
        t.clamp(0.5, 2.0)
    } else {
        1.0
    }
}

/// 排序、去重（同起點取後面那個）、開頭補一段 1.0（第一段不從 0 開始時）、速率夾限。
pub fn normalized_segments(segments: &[AlignSegment]) -> Vec<(f64, f64)> {
    let mut segs: Vec<(f64, f64)> = segments.iter().filter(|s| s.dub_start_ms.is_finite()).map(|s| (s.dub_start_ms.max(0.0), clamp_tempo(s.tempo))).collect();
    segs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut out: Vec<(f64, f64)> = Vec::with_capacity(segs.len() + 1);
    for s in segs {
        match out.last_mut() {
            Some(last) if (last.0 - s.0).abs() < 1e-6 => last.1 = s.1,
            _ => out.push(s),
        }
    }
    if out.is_empty() || out[0].0 > 1e-6 {
        out.insert(0, (0.0, 1.0));
    }
    out
}

/// 分段線性的扭曲函數：輸出 sample → dub sample（純函式，單位都是 frame）。
#[derive(Debug, Clone, PartialEq)]
pub struct WarpMap {
    /// 每段在輸出時間軸的起點（frame）。
    out_start: Vec<f64>,
    /// 每段在 dub 時間軸的起點（frame）。
    in_start: Vec<f64>,
    tempo: Vec<f64>,
}

impl WarpMap {
    pub fn from_segments(segs: &[(f64, f64)]) -> WarpMap {
        let mut out_start = Vec::with_capacity(segs.len());
        let mut in_start = Vec::with_capacity(segs.len());
        let mut tempo = Vec::with_capacity(segs.len());
        let mut o = 0.0;
        for (k, &(start_ms, t)) in segs.iter().enumerate() {
            let i = start_ms / 1000.0 * SR as f64;
            if k > 0 {
                o += (i - in_start[k - 1]) / tempo[k - 1];
            }
            out_start.push(o);
            in_start.push(i);
            tempo.push(t);
        }
        WarpMap { out_start, in_start, tempo }
    }

    /// 輸出第 `out` 個 frame 對應 dub 的哪個 frame。
    pub fn input_at(&self, out: f64) -> f64 {
        let mut k = 0;
        while k + 1 < self.out_start.len() && out >= self.out_start[k + 1] {
            k += 1;
        }
        self.in_start[k] + (out - self.out_start[k]) * self.tempo[k]
    }

    /// dub 總長 `in_len` frame 時，輸出有幾個 frame。
    pub fn output_len(&self, in_len: usize) -> usize {
        let k = self.tempo.len() - 1;
        let tail = (in_len as f64 - self.in_start[k]).max(0.0) / self.tempo[k];
        (self.out_start[k] + tail).round() as usize
    }
}

/// 一塊一塊給 interleaved f32 frame 的來源（ffmpeg pipe 或測試用的 Vec）。
pub trait FrameSource {
    /// 讀最多 `max_frames` 個 frame 進 `buf`（interleaved），回讀了幾個；0 = EOF。
    fn read_frames(&mut self, buf: &mut Vec<f32>, max_frames: usize, ch: usize) -> AppResult<usize>;
}

pub struct SliceSource<'a> {
    data: &'a [f32],
    pos: usize,
}

impl<'a> SliceSource<'a> {
    pub fn new(data: &'a [f32]) -> Self {
        SliceSource { data, pos: 0 }
    }
}

impl FrameSource for SliceSource<'_> {
    fn read_frames(&mut self, buf: &mut Vec<f32>, max_frames: usize, ch: usize) -> AppResult<usize> {
        let avail = (self.data.len() - self.pos) / ch;
        let n = avail.min(max_frames);
        buf.extend_from_slice(&self.data[self.pos..self.pos + n * ch]);
        self.pos += n * ch;
        Ok(n)
    }
}

struct PipeSource<R: Read> {
    reader: R,
    bytes: Vec<u8>,
}

impl<R: Read> FrameSource for PipeSource<R> {
    fn read_frames(&mut self, buf: &mut Vec<f32>, max_frames: usize, ch: usize) -> AppResult<usize> {
        let want = max_frames * ch * 4;
        self.bytes.resize(want, 0);
        let mut got = 0;
        while got < want {
            let n = self.reader.read(&mut self.bytes[got..]).map_err(|e| AppError::Ffmpeg(format!("讀解碼串流失敗：{e}")))?;
            if n == 0 {
                break;
            }
            got += n;
        }
        let frames = got / (ch * 4);
        for f in self.bytes[..frames * ch * 4].chunks_exact(4) {
            buf.push(f32::from_le_bytes([f[0], f[1], f[2], f[3]]));
        }
        Ok(frames)
    }
}

/// 滑動的輸入視窗：`data[0]` 是絕對 frame `base`；讀夠再往前丟。
struct Window {
    data: Vec<f32>,
    base: usize,
    ch: usize,
    eof: bool,
    total: Option<usize>,
}

impl Window {
    fn frames(&self) -> usize {
        self.data.len() / self.ch
    }
    /// 確保絕對 frame `end`（不含）之前都在視窗裡；碰到 EOF 就記下總長。
    fn ensure(&mut self, src: &mut dyn FrameSource, end: usize) -> AppResult<()> {
        while !self.eof && self.base + self.frames() < end {
            let n = src.read_frames(&mut self.data, SR, self.ch)?;
            if n == 0 {
                self.eof = true;
                self.total = Some(self.base + self.frames());
            }
        }
        Ok(())
    }
    /// 丟掉絕對 frame `keep_from` 之前的（一次丟一大塊，不逐格 memmove）。
    fn trim(&mut self, keep_from: usize) {
        if keep_from > self.base + SR {
            let drop = (keep_from - self.base).min(self.frames());
            self.data.drain(..drop * self.ch);
            self.base += drop;
        }
    }
    /// 取絕對 frame `f` 第 `c` 聲道；視窗外 = 0。
    #[inline]
    fn get(&self, f: i64, c: usize) -> f32 {
        if f < self.base as i64 {
            return 0.0;
        }
        let i = (f as usize - self.base) * self.ch + c;
        self.data.get(i).copied().unwrap_or(0.0)
    }
    /// 兩段 grain（各 WIN frame，聲道平均）的正規化互相關。
    fn ncc(&self, a: i64, b: i64) -> f32 {
        let mut num = 0f32;
        let mut ea = 0f32;
        let mut eb = 0f32;
        for n in 0..WIN as i64 {
            let mut x = 0f32;
            let mut y = 0f32;
            for c in 0..self.ch {
                x += self.get(a + n, c);
                y += self.get(b + n, c);
            }
            num += x * y;
            ea += x * x;
            eb += y * y;
        }
        if ea <= 1e-9 || eb <= 1e-9 {
            0.0
        } else {
            num / (ea * eb).sqrt()
        }
    }
}

/// WSOLA 核心：輸出時間是主時鐘，每 hop 依 `map` 回到理想位置 ±SEARCH 找最順的 grain。
/// `emit` 每次收到 interleaved 的完成 frame。回傳輸出 frame 數（不含 offset）。
pub fn wsola(src: &mut dyn FrameSource, ch: usize, map: &WarpMap, skip_frames: usize, mut emit: impl FnMut(&[f32]) -> AppResult<()>) -> AppResult<usize> {
    let hann: Vec<f32> = (0..WIN).map(|n| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * n as f32 / WIN as f32).cos()).collect();
    let mut win = Window { data: Vec::new(), base: 0, ch, eof: false, total: None };
    // 累加器：WIN + HOP 個 frame；每 hop 吐出前 HOP 個
    let mut acc = vec![0f32; (WIN + HOP) * ch];
    let mut out_frames = 0usize; // 已完成（吐出或跳過）的輸出 frame
    let mut emitted = 0usize;
    let mut prev: Option<i64> = None;
    let mut chunk: Vec<f32> = Vec::with_capacity(HOP * ch);
    let mut k = 0usize;
    loop {
        let tau = k * HOP;
        // 到底了嗎：EOF 之後知道總長，輸出到 map 算出的長度為止
        if let Some(total) = win.total {
            if tau >= map.output_len(total) + WIN {
                break;
            }
        }
        // grain 蓋輸出 [tau, tau+WIN)：用它的**中心**去查扭曲函數，再退半個視窗當起點
        let ideal = map.input_at((tau + WIN / 2) as f64) - (WIN / 2) as f64;
        let p = ideal.round() as i64;
        win.ensure(src, (p + WIN as i64 + SEARCH + 1).max(0) as usize)?;
        // 找落點：先粗（每 8 格）再細（±8）
        let s = match prev {
            None => p.max(0),
            Some(pv) => {
                let reference = pv + HOP as i64;
                let lo = (p - SEARCH).max(0);
                let hi = p + SEARCH;
                let score = |c: i64| win.ncc(c, reference) - DRIFT_PENALTY * ((c - p).abs() as f32 / SEARCH as f32);
                let mut best = (f32::MIN, p.max(0));
                let mut c = lo;
                while c <= hi {
                    let v = score(c);
                    if v > best.0 {
                        best = (v, c);
                    }
                    c += 8;
                }
                let lo2 = (best.1 - 8).max(lo);
                let hi2 = (best.1 + 8).min(hi);
                for c in lo2..=hi2 {
                    let v = score(c);
                    if v > best.0 {
                        best = (v, c);
                    }
                }
                best.1
            }
        };
        prev = Some(s);
        // 重疊相加
        for n in 0..WIN {
            let w = hann[n];
            for c in 0..ch {
                acc[n * ch + c] += w * win.get(s + n as i64, c);
            }
        }
        // 吐出前 HOP frame（跳過 offset 為負時砍掉的開頭）
        let done_end = out_frames + HOP;
        let limit = win.total.map(|t| map.output_len(t)).unwrap_or(usize::MAX);
        let take_end = done_end.min(limit);
        if take_end > out_frames {
            let from = out_frames.max(skip_frames);
            if take_end > from {
                chunk.clear();
                chunk.extend_from_slice(&acc[(from - out_frames) * ch..(take_end - out_frames) * ch]);
                emit(&chunk)?;
                emitted += take_end - from;
            }
        }
        out_frames = done_end;
        acc.copy_within(HOP * ch.., 0);
        let len = acc.len();
        acc[len - HOP * ch..].fill(0.0);
        // 視窗往前丟：理想位置與參考位置都不會再往回
        let keep = (p - SEARCH - WIN as i64).min(s).max(0) as usize;
        win.trim(keep);
        k += 1;
        if let Some(total) = win.total {
            if out_frames >= map.output_len(total) {
                break;
            }
        }
    }
    Ok(emitted)
}

pub async fn render(bins: &FfmpegBins, spec: &AlignSpec) -> AppResult<AlignDone> {
    let t0 = Instant::now();
    if spec.src == spec.out_path {
        return Err(AppError::Invalid("輸出路徑不能跟來源一樣".into()));
    }
    let ch = spec.channels.clamp(1, 2) as usize;
    let map = WarpMap::from_segments(&normalized_segments(&spec.segments));
    let offset = if spec.offset_ms.is_finite() { spec.offset_ms } else { 0.0 };
    let out = PathBuf::from(&spec.out_path);
    if let Some(dir) = out.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let part = PathBuf::from(format!("{}.part", spec.out_path));
    let ffmpeg = bins.ffmpeg.clone();
    let src = spec.src.clone();
    let part2 = part.clone();
    // 解碼 + WSOLA 是 CPU 工作，丟到 blocking thread；ffmpeg 只負責解成 f32 串流
    let written = tokio::task::spawn_blocking(move || -> AppResult<usize> {
        let mut c = proc::cmd(&ffmpeg);
        c.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-i"]);
        c.arg(&src);
        c.args(["-vn", "-f", "f32le", "-ac", &ch.to_string(), "-ar", "48000", "pipe:1"]);
        c.stdout(Stdio::piped()).stderr(Stdio::null());
        let mut child = c.as_std_mut().spawn().map_err(|e| AppError::Ffmpeg(format!("ffmpeg 啟動失敗：{e}")))?;
        let stdout = child.stdout.take().ok_or_else(|| AppError::Ffmpeg("ffmpeg 沒有輸出".into()))?;
        let mut source = PipeSource { reader: std::io::BufReader::with_capacity(1 << 20, stdout), bytes: Vec::new() };
        let wspec = hound::WavSpec { channels: ch as u16, sample_rate: 48_000, bits_per_sample: 24, sample_format: hound::SampleFormat::Int };
        let file = std::fs::File::create(&part2).map_err(|e| AppError::Io(format!("建立輸出檔失敗：{e}")))?;
        let mut w = hound::WavWriter::new(BufWriter::with_capacity(1 << 20, file), wspec).map_err(|e| AppError::Io(format!("寫 wav 失敗：{e}")))?;
        let write = |w: &mut hound::WavWriter<BufWriter<std::fs::File>>, s: &[f32]| -> AppResult<()> {
            for v in s {
                let q = (v.clamp(-1.0, 1.0) * 8_388_607.0).round() as i32;
                w.write_sample(q).map_err(|e| AppError::Io(format!("寫 wav 失敗：{e}")))?;
            }
            Ok(())
        };
        let mut total = 0usize;
        if offset >= 1.0 {
            let n = (offset / 1000.0 * SR as f64).round() as usize;
            let z = vec![0f32; SR * ch];
            let mut left = n;
            while left > 0 {
                let k = left.min(SR);
                write(&mut w, &z[..k * ch])?;
                left -= k;
            }
            total += n;
        }
        let skip = if offset <= -1.0 { (-offset / 1000.0 * SR as f64).round() as usize } else { 0 };
        total += wsola(&mut source, ch, &map, skip, |frames| write(&mut w, frames))?;
        w.finalize().map_err(|e| AppError::Io(format!("寫 wav 失敗：{e}")))?;
        let _ = child.wait();
        Ok(total)
    })
    .await
    .map_err(|e| AppError::Io(format!("對齊執行緒失敗：{e}")))?;
    match written {
        Ok(_) => {}
        Err(e) => {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(e);
        }
    }
    tokio::fs::rename(&part, &out).await?;
    Ok(AlignDone { out_path: spec.out_path.clone(), elapsed_ms: t0.elapsed().as_millis() as u64 })
}

/// 找脈衝：超過門檻的第一個 sample，之後 100 ms 內不再找（測試用）。
pub fn pulse_positions(samples: &[f32], threshold: f32) -> Vec<usize> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < samples.len() {
        if samples[i].abs() > threshold {
            out.push(i);
            i += 4800;
        } else {
            i += 1;
        }
    }
    out
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

    fn seg(d: f64, t: f64) -> AlignSegment {
        AlignSegment { dub_start_ms: d, tempo: t }
    }

    fn run(data: &[f32], ch: usize, segs: &[(f64, f64)], skip: usize) -> Vec<f32> {
        let map = WarpMap::from_segments(segs);
        let mut src = SliceSource::new(data);
        let mut out = Vec::new();
        wsola(&mut src, ch, &map, skip, |f| {
            out.extend_from_slice(f);
            Ok(())
        })
        .unwrap();
        out
    }

    #[test]
    fn segments_are_normalized_and_map_is_piecewise_linear() {
        let segs = normalized_segments(&[seg(4000.0, 9.0), seg(1000.0, 0.1), seg(1000.0, 0.7)]);
        assert_eq!(segs, vec![(0.0, 1.0), (1000.0, 0.7), (4000.0, 2.0)], "同起點取後面那個、開頭補 1.0、夾限");
        let m = WarpMap::from_segments(&segs);
        assert_eq!(m.input_at(0.0), 0.0);
        assert_eq!(m.input_at(24_000.0), 24_000.0);
        // 1 s 之後 0.7 倍：輸出 1 s + x ↔ dub 1 s + 0.7 x
        assert!((m.input_at(48_000.0 + 10_000.0) - (48_000.0 + 7000.0)).abs() < 1e-6);
        // 第三段從 dub 4 s 起：輸出起點 = 1 s + 3 s / 0.7
        assert!((m.input_at(48_000.0 + 144_000.0 / 0.7 + 100.0) - (192_000.0 + 200.0)).abs() < 1e-6);
        assert_eq!(m.output_len(192_000 + 96_000), (48_000.0 + 144_000.0 / 0.7 + 48_000.0) as usize);
    }

    #[test]
    fn pulses_land_within_two_ms_for_stretch_shrink_and_identity() {
        // 9 秒脈衝列，125 ms 起每 250 ms 一個；三段 0.9 / 1.1 / 1.0
        let n = SR * 9;
        let mut data = vec![0f32; n];
        let pulses_ms: Vec<f64> = (0..35).map(|k| 125.0 + 250.0 * k as f64).collect();
        for &ms in &pulses_ms {
            let p = (ms / 1000.0 * SR as f64) as usize;
            for v in data.iter_mut().skip(p).take(48) {
                *v = 0.9;
            }
        }
        let out = run(&data, 1, &[(0.0, 0.9), (3000.0, 1.1), (6000.0, 1.0)], 0);
        let want_len = 3000.0 / 0.9 + 3000.0 / 1.1 + 3000.0;
        let got_len = out.len() as f64 / 48.0;
        assert!((got_len - want_len).abs() <= 11.0, "len got {got_len} want {want_len}");
        let warp = |d: f64| -> f64 {
            if d < 3000.0 {
                d / 0.9
            } else if d < 6000.0 {
                3000.0 / 0.9 + (d - 3000.0) / 1.1
            } else {
                3000.0 / 0.9 + 3000.0 / 1.1 + (d - 6000.0)
            }
        };
        let pos = pulse_positions(&out, 0.3);
        assert_eq!(pos.len(), pulses_ms.len(), "脈衝數");
        let mut worst = 0.0f64;
        for (k, &q) in pos.iter().enumerate() {
            let err = q as f64 / 48.0 - warp(pulses_ms[k]);
            worst = worst.max(err.abs());
        }
        assert!(worst <= 5.5, "最大誤差 {worst:.2} ms（搜尋範圍 ±5 ms）");
    }

    #[test]
    fn identity_tempo_is_transparent_after_the_first_window() {
        let n = SR * 2;
        let data: Vec<f32> = (0..n).map(|i| 0.5 * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / SR as f32).sin() + 0.2 * (2.0 * std::f32::consts::PI * 3001.0 * i as f32 / SR as f32).sin()).collect();
        let out = run(&data, 1, &[(0.0, 1.0)], 0);
        assert!((out.len() as i64 - n as i64).abs() <= HOP as i64, "len {} vs {}", out.len(), n);
        let mut worst = 0f32;
        for i in WIN..(n - WIN).min(out.len()) {
            worst = worst.max((out[i] - data[i]).abs());
        }
        assert!(worst < 1e-3, "1.0 倍要透明（worst diff {worst}）");
    }

    #[test]
    fn stereo_channels_share_the_same_grain_positions_and_skip_drops_the_head() {
        let n = SR * 3;
        let mut data = vec![0f32; n * 2];
        for i in 0..n {
            let v = 0.4 * (2.0 * std::f32::consts::PI * 300.0 * i as f32 / SR as f32).sin();
            data[i * 2] = v;
            data[i * 2 + 1] = -v; // 右聲道反相：兩聲道要一直互為相反數
        }
        let out = run(&data, 2, &[(0.0, 1.05)], 4800);
        let frames = out.len() / 2;
        assert!((frames as f64 - (n as f64 / 1.05 - 4800.0)).abs() <= HOP as f64, "frames {frames}");
        let mut worst = 0f32;
        for f in 0..frames {
            worst = worst.max((out[f * 2] + out[f * 2 + 1]).abs());
        }
        assert!(worst < 1e-4, "左右要同一個 grain 落點（worst {worst}）");
    }

    #[test]
    fn sine_stays_continuous_across_grains() {
        // 440 Hz 正弦、1.07 倍：相鄰 sample 的差不會超過正弦本身的最大斜率太多（沒有 click）
        let n = SR * 3;
        let data: Vec<f32> = (0..n).map(|i| 0.8 * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / SR as f32).sin()).collect();
        let out = run(&data, 1, &[(0.0, 1.07)], 0);
        let max_slope = 0.8 * 2.0 * std::f32::consts::PI * 440.0 / SR as f32; // ≈ 0.046
        let mut worst = 0f32;
        for i in WIN..out.len() {
            worst = worst.max((out[i] - out[i - 1]).abs());
        }
        assert!(worst < max_slope * 1.5, "相鄰 sample 差 {worst} 超過正弦斜率 {max_slope}");
    }

    fn bundled_bins() -> Option<FfmpegBins> {
        let dir = crate::ffmpeg::bundled_candidate(std::path::Path::new(env!("CARGO_MANIFEST_DIR")));
        let exe = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
        let p = dir.join(exe);
        p.is_file().then(|| FfmpegBins { ffmpeg: p.to_string_lossy().into_owned(), ffprobe: String::new(), version: String::new(), source: "bundled".into() })
    }

    /// 真跑 ffmpeg 解碼 + render：脈衝列 wav → `_aligned.wav`，落點 ≤ 5.5 ms、位移正負都對。
    #[tokio::test]
    #[ignore]
    async fn align_render_roundtrip_with_ffmpeg_decode() {
        let Some(bins) = bundled_bins() else {
            eprintln!("no bundled ffmpeg; skip");
            return;
        };
        let dir = std::env::temp_dir().join(format!("aicut-align-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let n = SR * 9;
        let mut samples = vec![0f32; n];
        let pulses_ms: Vec<f64> = (0..35).map(|k| 125.0 + 250.0 * k as f64).collect();
        for &ms in &pulses_ms {
            let p = (ms / 1000.0 * SR as f64) as usize;
            for v in samples.iter_mut().skip(p).take(48) {
                *v = 0.9;
            }
        }
        let src = dir.join("dub.wav");
        let spec_w = hound::WavSpec { channels: 1, sample_rate: 48_000, bits_per_sample: 32, sample_format: hound::SampleFormat::Float };
        let mut w = hound::WavWriter::create(&src, spec_w).unwrap();
        for s in &samples {
            w.write_sample(*s).unwrap();
        }
        w.finalize().unwrap();
        for offset in [0.0, 250.0, -1000.0] {
            let out = dir.join(format!("dub_aligned_{}.wav", offset as i64));
            let s = AlignSpec { src: src.to_string_lossy().into_owned(), out_path: out.to_string_lossy().into_owned(), offset_ms: offset, segments: vec![seg(0.0, 0.9), seg(3000.0, 1.1), seg(6000.0, 1.0)], channels: 1 };
            render(&bins, &s).await.unwrap();
            let mut r = hound::WavReader::open(&out).unwrap();
            let got: Vec<f32> = r.samples::<i32>().map(|v| v.unwrap() as f32 / 8_388_608.0).collect();
            let warp = |d: f64| -> f64 {
                let g = if d < 3000.0 {
                    d / 0.9
                } else if d < 6000.0 {
                    3000.0 / 0.9 + (d - 3000.0) / 1.1
                } else {
                    3000.0 / 0.9 + 3000.0 / 1.1 + (d - 6000.0)
                };
                g + offset
            };
            let pos = pulse_positions(&got, 0.3);
            let expected: Vec<f64> = pulses_ms.iter().map(|&d| warp(d)).filter(|&g| g >= 0.0).collect();
            assert_eq!(pos.len(), expected.len(), "offset {offset}: 脈衝數");
            let mut worst = 0.0f64;
            for (k, &q) in pos.iter().enumerate() {
                worst = worst.max((q as f64 / 48.0 - expected[k]).abs());
            }
            eprintln!("[align] offset {offset}: len {:.1} ms, worst {worst:.2} ms", got.len() as f64 / 48.0);
            assert!(worst <= 5.5, "offset {offset}: 最大誤差 {worst:.2} ms");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
