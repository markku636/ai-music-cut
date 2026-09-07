// 輸出 / 轉檔格式的**單一來源**：格式 union、能力表、編碼參數。
//
// 以前 "mp3" | "m4a" | "wav" 散在六個地方（render / api / exportPresets / tools / cli ×2）+ 三個對話框的 <Select>；
// 加一種格式要改七處，漏一處就是「選了 flac 默默出 mp3」（render.rs 的 `_ => mp3`）。
// 現在全部 import 這裡；Rust 端 formats.rs 是同一張表的鏡像，codec 字串用 golden 測試互相釘死。
export type RenderFormat = "mp3" | "m4a" | "wav" | "flac" | "ogg" | "opus" | "aiff";

export const RENDER_FORMATS: readonly RenderFormat[] = ["mp3", "m4a", "wav", "flac", "ogg", "opus", "aiff"];

export type BitDepth = 16 | 24 | 32;

export interface FormatCaps {
  id: RenderFormat;
  /** 顯示名稱（zh key）。 */
  label: string;
  /** ffmpeg 編碼器。 */
  codec: string;
  /** ffmpeg 容器（-f）。 */
  muxer: string;
  lossless: boolean;
  /** 章節只有 mp3（ID3 CHAP）與 m4a（QuickTime）寫得進去。 */
  chapters: boolean;
  /** 可選的位元深度（無損才有意義）。 */
  bitDepths: readonly BitDepth[];
  /** 一句話（zh key）。 */
  note: string;
}

export const FORMATS: Record<RenderFormat, FormatCaps> = {
  mp3: { id: "mp3", label: "MP3", codec: "libmp3lame", muxer: "mp3", lossless: false, chapters: true, bitDepths: [], note: "最通用；Podcast 平台都收" },
  m4a: { id: "m4a", label: "M4A（AAC）", codec: "aac", muxer: "mp4", lossless: false, chapters: true, bitDepths: [], note: "Apple 生態、同音質比 mp3 小" },
  wav: { id: "wav", label: "WAV", codec: "pcm_s16le", muxer: "wav", lossless: true, chapters: false, bitDepths: [16, 24, 32], note: "無損、檔案大；給後製用" },
  flac: { id: "flac", label: "FLAC", codec: "flac", muxer: "flac", lossless: true, chapters: false, bitDepths: [16, 24], note: "無損壓縮，約 wav 一半大" },
  ogg: { id: "ogg", label: "OGG（Vorbis）", codec: "libvorbis", muxer: "ogg", lossless: false, chapters: false, bitDepths: [], note: "開放格式；遊戲 / 網頁常用" },
  opus: { id: "opus", label: "Opus", codec: "libopus", muxer: "opus", lossless: false, chapters: false, bitDepths: [], note: "語音最省空間；瀏覽器都能播" },
  aiff: { id: "aiff", label: "AIFF", codec: "pcm_s16be", muxer: "aiff", lossless: true, chapters: false, bitDepths: [16, 24], note: "Mac 的無損；Logic / GarageBand 用" },
};

export function isRenderFormat(v: unknown): v is RenderFormat {
  return typeof v === "string" && (RENDER_FORMATS as readonly string[]).includes(v);
}

/** 副檔名 → 格式（不認得回 null）。 */
export function formatOfExt(ext: string): RenderFormat | null {
  const e = ext.replace(/^\./, "").toLowerCase();
  return isRenderFormat(e) ? e : null;
}

/** 這個格式的編碼參數（與 Rust formats.rs 的 codec_args 逐字相同，golden 測試釘死）。 */
export function codecArgs(format: RenderFormat, bitDepth?: BitDepth): string[] {
  switch (format) {
    case "mp3":
      return ["-c:a", "libmp3lame", "-q:a", "2"];
    case "m4a":
      return ["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"];
    case "wav":
      return ["-c:a", bitDepth === 24 ? "pcm_s24le" : bitDepth === 32 ? "pcm_f32le" : "pcm_s16le"];
    case "flac":
      return ["-c:a", "flac", "-sample_fmt", bitDepth === 24 ? "s32" : "s16", "-compression_level", "8"];
    case "ogg":
      return ["-c:a", "libvorbis", "-q:a", "6"];
    case "opus":
      return ["-c:a", "libopus", "-b:a", "96k", "-vbr", "on"];
    case "aiff":
      return ["-c:a", bitDepth === 24 ? "pcm_s24be" : "pcm_s16be"];
  }
}

/** 輸出到這個格式時，哪些東西帶不過去（要列出來，不能默默少掉）。 */
export function droppedOnExport(format: RenderFormat, has: { chapters: boolean }): string[] {
  const out: string[] = [];
  if (has.chapters && !FORMATS[format].chapters) out.push("章節");
  return out;
}

/** 原檔的編碼器名稱（ffprobe codec_name）對到哪個格式；能對到就有機會直接複製不重編。 */
export function formatOfCodec(codec: string | null | undefined): RenderFormat | null {
  switch ((codec ?? "").toLowerCase()) {
    case "mp3":
      return "mp3";
    case "aac":
      return "m4a";
    case "flac":
      return "flac";
    case "vorbis":
      return "ogg";
    case "opus":
      return "opus";
    default:
      return null;
  }
}
