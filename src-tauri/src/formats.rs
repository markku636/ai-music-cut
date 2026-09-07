//! 輸出 / 轉檔格式表：前端 `src/analysis/formats.ts` 的鏡像，codec 字串用兩邊的 golden 測試互相釘死。
//!
//! 以前 render.rs 的 `match plan.format { "wav" => …, "m4a" => …, _ => mp3 }`：不認得的格式**默默出 mp3**。
//! 現在不認得就是 `AppError::Invalid` —— 使用者選了 flac 就要拿到 flac，或拿到一個錯誤。

use crate::error::{AppError, AppResult};

pub const FORMATS: [&str; 7] = ["mp3", "m4a", "wav", "flac", "ogg", "opus", "aiff"];

#[allow(dead_code)]
pub fn is_format(f: &str) -> bool {
    FORMATS.contains(&f)
}

/// 章節只有 mp3（ID3 CHAP）與 m4a（QuickTime）寫得進去。
pub fn supports_chapters(format: &str) -> bool {
    matches!(format, "mp3" | "m4a")
}

#[allow(dead_code)]
pub fn is_lossless(format: &str) -> bool {
    matches!(format, "wav" | "flac" | "aiff")
}

/// (容器 -f, 編碼參數)。bit_depth 0 = 預設（16）。與 TS `codecArgs` 逐字相同。
pub fn codec_args(format: &str, bit_depth: u32) -> AppResult<(&'static str, Vec<String>)> {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    Ok(match format {
        "mp3" => ("mp3", s(&["-c:a", "libmp3lame", "-q:a", "2"])),
        "m4a" => ("mp4", s(&["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"])),
        "wav" => (
            "wav",
            s(&["-c:a", match bit_depth {
                24 => "pcm_s24le",
                32 => "pcm_f32le",
                _ => "pcm_s16le",
            }]),
        ),
        "flac" => ("flac", s(&["-c:a", "flac", "-sample_fmt", if bit_depth == 24 { "s32" } else { "s16" }, "-compression_level", "8"])),
        "ogg" => ("ogg", s(&["-c:a", "libvorbis", "-q:a", "6"])),
        "opus" => ("opus", s(&["-c:a", "libopus", "-b:a", "96k", "-vbr", "on"])),
        "aiff" => ("aiff", s(&["-c:a", if bit_depth == 24 { "pcm_s24be" } else { "pcm_s16be" }])),
        other => return Err(AppError::Invalid(format!("不支援的輸出格式：{other}（可用：{}）", FORMATS.join(" / ")))),
    })
}

/// ffprobe 的 codec_name 對到哪個格式（轉檔能不能直接 -c:a copy 用）。
pub fn format_of_codec(codec: &str) -> Option<&'static str> {
    match codec {
        "mp3" => Some("mp3"),
        "aac" => Some("m4a"),
        "flac" => Some("flac"),
        "vorbis" => Some("ogg"),
        "opus" => Some("opus"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golden_matches_ts_codec_args() {
        let j = |f: &str, b: u32| codec_args(f, b).unwrap().1.join(" ");
        assert_eq!(j("mp3", 0), "-c:a libmp3lame -q:a 2");
        assert_eq!(j("m4a", 0), "-c:a aac -b:a 192k -movflags +faststart");
        assert_eq!(j("wav", 0), "-c:a pcm_s16le");
        assert_eq!(j("wav", 24), "-c:a pcm_s24le");
        assert_eq!(j("wav", 32), "-c:a pcm_f32le");
        assert_eq!(j("flac", 0), "-c:a flac -sample_fmt s16 -compression_level 8");
        assert_eq!(j("flac", 24), "-c:a flac -sample_fmt s32 -compression_level 8");
        assert_eq!(j("ogg", 0), "-c:a libvorbis -q:a 6");
        assert_eq!(j("opus", 0), "-c:a libopus -b:a 96k -vbr on");
        assert_eq!(j("aiff", 0), "-c:a pcm_s16be");
        assert_eq!(j("aiff", 24), "-c:a pcm_s24be");
        assert_eq!(codec_args("m4a", 0).unwrap().0, "mp4");
        assert_eq!(codec_args("opus", 0).unwrap().0, "opus");
    }

    #[test]
    fn unknown_format_is_an_error_not_mp3() {
        let e = codec_args("wma", 0).unwrap_err();
        assert!(e.message().contains("wma"));
        assert!(!is_format("WAV"), "大小寫由前端正規化，這裡只認小寫");
    }

    #[test]
    fn chapters_only_in_mp3_and_m4a() {
        let with: Vec<&str> = FORMATS.iter().copied().filter(|f| supports_chapters(f)).collect();
        assert_eq!(with, vec!["mp3", "m4a"]);
        assert!(is_lossless("flac") && !is_lossless("opus"));
    }
}
