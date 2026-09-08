//! 頻譜：兩件事，都不在 WebView 解碼。
//!
//! 1. **頻譜圖（spectrogram）**：`showspectrumpic` 對來源檔切一段出一張 PNG，快取在媒體目錄的 `spec/`。
//!    不預算整檔的 spectrogram.bin（固定 hop 撐不了 2 秒縮放、一小時 +16 MB），也不用 wavesurfer 的
//!    spectrogram 插件（要在瀏覽器把整檔解碼成 PCM，一小時 ~1 GB）。畫面要哪一段就算哪一段，150 ms 內回來。
//! 2. **選取的平均功率譜**：解碼一段 f32le mono 48k，Hann 視窗 + 純 Rust radix-2 FFT，回 dB / bin。
//!    嗡聲偵測（50 / 60 Hz 與諧波）吃這個。不拉 rustfft：4096 點的 FFT 六十行就寫完，少一個授權條目。
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::ffmpeg::FfmpegBins;
use crate::proc;

/// 一次最多算多長的頻譜圖（畫面看不到那麼細，而且 showspectrumpic 要把整段讀完）。
pub const MAX_SPECTROGRAM_MS: f64 = 600_000.0;
/// 平均功率譜最多吃多長（30 秒已經很穩；再長只是慢）。
pub const MAX_SPECTRUM_MS: f64 = 30_000.0;

const PALETTES: [&str; 6] = ["magma", "viridis", "plasma", "cividis", "fire", "intensity"];

fn palette_ok(p: &str) -> &str {
    if PALETTES.contains(&p) {
        p
    } else {
        "magma"
    }
}

/// 檔名：起訖 / 尺寸 / 配色 / 版本都進去，任一項變就是另一張。
pub fn spectrogram_name(start_ms: f64, end_ms: f64, w: u32, h: u32, palette: &str) -> String {
    format!("spec-{}-{}-{}x{}-{}-v1.png", start_ms.round() as i64, end_ms.round() as i64, w, h, palette_ok(palette))
}

/// 產一張頻譜圖（已存在就直接回）。回傳 PNG 路徑。
pub async fn spectrogram_png(bins: &FfmpegBins, src: &str, start_ms: f64, end_ms: f64, w: u32, h: u32, palette: &str, dir: &Path) -> AppResult<PathBuf> {
    let start = start_ms.max(0.0);
    let len = (end_ms - start).max(50.0);
    if len > MAX_SPECTROGRAM_MS {
        return Err(AppError::Invalid(format!("頻譜圖一次最多 {} 分鐘（縮小一點再看）", (MAX_SPECTROGRAM_MS / 60_000.0) as u32)));
    }
    let w = w.clamp(16, 8192);
    let h = h.clamp(16, 2048);
    tokio::fs::create_dir_all(dir).await?;
    let out = dir.join(spectrogram_name(start, start + len, w, h, palette));
    if out.is_file() {
        return Ok(out);
    }
    let part = dir.join(format!("{}.part.png", out.file_stem().and_then(|s| s.to_str()).unwrap_or("spec")));
    // log 頻率軸（人聲在 100–4k 之間才看得到細節）、60 dB 動態、Hann 視窗；legend=0 只要圖
    let lavfi = format!(
        "aformat=channel_layouts=mono,atrim=duration={:.6},showspectrumpic=s={w}x{h}:legend=0:scale=log:fscale=log:start=40:stop=16000:color={}:win_func=hann:drange=60",
        len / 1000.0,
        palette_ok(palette)
    );
    let mut c = proc::cmd(&bins.ffmpeg);
    c.args(["-nostdin", "-hide_banner", "-loglevel", "error", "-y"]);
    // -t 一定要在 -i 前面（輸入選項）：showspectrumpic 要等輸入 EOF 才出圖，-t 放輸出端擋不住 demuxer，
    // 畫出來的會是 start..檔尾整段壓進這張圖；atrim 再把 demuxer 多讀的零頭切掉
    c.args(["-ss", &format!("{:.6}", start / 1000.0), "-t", &format!("{:.6}", len / 1000.0), "-i"]);
    c.arg(src);
    c.args(["-vn", "-lavfi", &lavfi, "-frames:v", "1", "-f", "image2"]);
    c.arg(&part);
    let o = c.output().await.map_err(|e| AppError::Ffmpeg(format!("ffmpeg 啟動失敗：{e}")))?;
    if !o.status.success() {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(AppError::Ffmpeg(format!("頻譜圖失敗：{}", String::from_utf8_lossy(&o.stderr).trim())));
    }
    tokio::fs::rename(&part, &out).await?;
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
pub struct Spectrum {
    pub sample_rate: u32,
    /// FFT 大小（bin 數 = n / 2 + 1）。
    pub n: u32,
    /// 每個 bin 的平均功率（dBFS，0 = 滿刻度正弦）。
    pub db: Vec<f32>,
    /// 平均了幾個視窗。
    pub frames: u32,
}

/// 原地 radix-2 FFT（複數以 (re, im) 兩個 Vec 表示）。n 必須是 2 的冪。
pub fn fft_in_place(re: &mut [f64], im: &mut [f64]) {
    let n = re.len();
    debug_assert!(n.is_power_of_two() && im.len() == n);
    // bit-reversal
    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2usize;
    while len <= n {
        let ang = -2.0 * std::f64::consts::PI / len as f64;
        let (wr, wi) = (ang.cos(), ang.sin());
        let mut i = 0usize;
        while i < n {
            let (mut cr, mut ci) = (1.0f64, 0.0f64);
            for k in 0..len / 2 {
                let (ar, ai) = (re[i + k], im[i + k]);
                let (br, bi) = (re[i + k + len / 2], im[i + k + len / 2]);
                let (tr, ti) = (br * cr - bi * ci, br * ci + bi * cr);
                re[i + k] = ar + tr;
                im[i + k] = ai + ti;
                re[i + k + len / 2] = ar - tr;
                im[i + k + len / 2] = ai - ti;
                let ncr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = ncr;
            }
            i += len;
        }
        len <<= 1;
    }
}

/// 一段 mono f32 → 平均功率譜（dBFS）。Hann 視窗、hop = n/2；不足一個視窗就補零。
pub fn average_spectrum(samples: &[f32], sample_rate: u32, n: usize) -> Spectrum {
    let n = n.max(64).next_power_of_two();
    let hop = n / 2;
    let bins = n / 2 + 1;
    let mut acc = vec![0f64; bins];
    let mut frames = 0u32;
    let win: Vec<f64> = (0..n).map(|i| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / n as f64).cos()).collect();
    // Hann 的相干增益 0.5：滿刻度正弦要回 0 dB
    let norm = 2.0 / (n as f64 * 0.5);
    let mut re = vec![0f64; n];
    let mut im = vec![0f64; n];
    let mut pos = 0usize;
    let total = samples.len().max(1);
    while pos == 0 || pos + n <= total {
        for i in 0..n {
            re[i] = samples.get(pos + i).copied().unwrap_or(0.0) as f64 * win[i];
            im[i] = 0.0;
        }
        fft_in_place(&mut re, &mut im);
        for b in 0..bins {
            let mag = (re[b] * re[b] + im[b] * im[b]).sqrt() * norm;
            acc[b] += mag * mag;
        }
        frames += 1;
        pos += hop;
        if samples.len() < n {
            break;
        }
    }
    let db: Vec<f32> = acc.iter().map(|p| (10.0 * (p / frames.max(1) as f64).max(1e-20).log10()) as f32).collect();
    Spectrum { sample_rate, n: n as u32, db, frames }
}

/// 解碼一段（f32le mono 48k）算平均功率譜。
pub async fn spectrum_of_range(bins: &FfmpegBins, src: &str, start_ms: f64, end_ms: f64, n: usize) -> AppResult<Spectrum> {
    let start = start_ms.max(0.0);
    let len = (end_ms - start).clamp(100.0, MAX_SPECTRUM_MS);
    let mut c = proc::cmd(&bins.ffmpeg);
    c.args(["-nostdin", "-hide_banner", "-loglevel", "error"]);
    c.args(["-ss", &format!("{:.6}", start / 1000.0), "-t", &format!("{:.6}", len / 1000.0), "-i"]);
    c.arg(src);
    c.args(["-vn", "-af", &format!("atrim=duration={:.6}", len / 1000.0), "-f", "f32le", "-ac", "1", "-ar", "48000", "pipe:1"]);
    let o = c.output().await.map_err(|e| AppError::Ffmpeg(format!("ffmpeg 啟動失敗：{e}")))?;
    if !o.status.success() {
        return Err(AppError::Ffmpeg(format!("解碼失敗：{}", String::from_utf8_lossy(&o.stderr).trim())));
    }
    let samples: Vec<f32> = o.stdout.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
    if samples.is_empty() {
        return Err(AppError::Ffmpeg("這一段解不出任何樣本".into()));
    }
    Ok(average_spectrum(&samples, 48_000, n))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(hz: f64, amp: f64, sr: u32, n: usize) -> Vec<f32> {
        (0..n).map(|i| (amp * (2.0 * std::f64::consts::PI * hz * i as f64 / sr as f64).sin()) as f32).collect()
    }

    #[test]
    fn fft_matches_naive_dft() {
        let n = 64;
        let x: Vec<f64> = (0..n).map(|i| ((i * 7) % 11) as f64 / 11.0 - 0.5).collect();
        let mut re = x.clone();
        let mut im = vec![0f64; n];
        fft_in_place(&mut re, &mut im);
        for k in 0..n {
            let (mut sr, mut si) = (0f64, 0f64);
            for t in 0..n {
                let a = -2.0 * std::f64::consts::PI * (k * t) as f64 / n as f64;
                sr += x[t] * a.cos();
                si += x[t] * a.sin();
            }
            assert!((re[k] - sr).abs() < 1e-9 && (im[k] - si).abs() < 1e-9, "bin {k}");
        }
    }

    #[test]
    fn full_scale_sine_lands_in_its_bin_at_zero_db() {
        let sr = 48_000;
        let n = 4096;
        // 剛好落在 bin 上的頻率：k · sr / n
        let k = 85; // ≈ 996 Hz
        let hz = k as f64 * sr as f64 / n as f64;
        let s = sine(hz, 1.0, sr, sr as usize * 2);
        let sp = average_spectrum(&s, sr, n);
        assert_eq!(sp.n, n as u32);
        assert!(sp.frames > 10);
        assert!((sp.db[k]).abs() < 0.2, "peak {} dB", sp.db[k]);
        // 離峰 20 個 bin 以外要低 60 dB 以上（Hann 旁瓣）
        assert!(sp.db[k + 20] < -60.0 && sp.db[k - 20] < -60.0, "{} {}", sp.db[k + 20], sp.db[k - 20]);
    }

    #[test]
    fn hum_plus_harmonics_show_up_where_expected() {
        let sr = 48_000;
        // 2.93 Hz / bin：60 Hz 在 bin 20.5、50 Hz 在 bin 17.1，隔 3.4 個 bin，已經在 Hann 主瓣（±2 bin）之外
        let n = 16384;
        let mut s = sine(60.0, 0.05, sr, sr as usize * 3);
        for (i, v) in sine(120.0, 0.02, sr, sr as usize * 3).iter().enumerate() {
            s[i] += v;
        }
        let sp = average_spectrum(&s, sr, n);
        let bin = |hz: f64| (hz * n as f64 / sr as f64).round() as usize;
        assert!(sp.db[bin(60.0)] > sp.db[bin(50.0)] + 20.0);
        assert!(sp.db[bin(120.0)] > sp.db[bin(100.0)] + 20.0);
    }

    #[test]
    fn short_input_is_zero_padded_not_empty() {
        let sp = average_spectrum(&[0.5f32; 100], 48_000, 1024);
        assert_eq!(sp.frames, 1);
        assert_eq!(sp.db.len(), 513);
    }

    #[test]
    fn spectrogram_name_is_stable_and_palette_is_whitelisted() {
        assert_eq!(spectrogram_name(1000.4, 2000.0, 800, 120, "magma"), "spec-1000-2000-800x120-magma-v1.png");
        assert_eq!(spectrogram_name(0.0, 1.0, 1, 1, "rm -rf"), "spec-0-1-1x1-magma-v1.png");
    }
}
