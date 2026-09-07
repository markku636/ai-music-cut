import { describe, expect, it } from "vitest";
import { codecArgs, droppedOnExport, FORMATS, formatOfCodec, formatOfExt, isRenderFormat, RENDER_FORMATS } from "./formats";

describe("formats", () => {
  it("七種格式都有能力表，且 id 一致", () => {
    for (const f of RENDER_FORMATS) expect(FORMATS[f].id).toBe(f);
    expect(RENDER_FORMATS).toHaveLength(7);
  });

  it("章節只有 mp3 與 m4a 寫得進去", () => {
    expect(RENDER_FORMATS.filter((f) => FORMATS[f].chapters)).toEqual(["mp3", "m4a"]);
    expect(droppedOnExport("flac", { chapters: true })).toEqual(["章節"]);
    expect(droppedOnExport("mp3", { chapters: true })).toEqual([]);
    expect(droppedOnExport("wav", { chapters: false })).toEqual([]);
  });

  it("編碼參數 golden（Rust formats.rs 的 codec_args 逐字相同）", () => {
    expect(codecArgs("mp3")).toEqual(["-c:a", "libmp3lame", "-q:a", "2"]);
    expect(codecArgs("m4a")).toEqual(["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]);
    expect(codecArgs("wav")).toEqual(["-c:a", "pcm_s16le"]);
    expect(codecArgs("wav", 24)).toEqual(["-c:a", "pcm_s24le"]);
    expect(codecArgs("wav", 32)).toEqual(["-c:a", "pcm_f32le"]);
    expect(codecArgs("flac")).toEqual(["-c:a", "flac", "-sample_fmt", "s16", "-compression_level", "8"]);
    expect(codecArgs("flac", 24)).toEqual(["-c:a", "flac", "-sample_fmt", "s32", "-compression_level", "8"]);
    expect(codecArgs("ogg")).toEqual(["-c:a", "libvorbis", "-q:a", "6"]);
    expect(codecArgs("opus")).toEqual(["-c:a", "libopus", "-b:a", "96k", "-vbr", "on"]);
    expect(codecArgs("aiff")).toEqual(["-c:a", "pcm_s16be"]);
    expect(codecArgs("aiff", 24)).toEqual(["-c:a", "pcm_s24be"]);
  });

  it("副檔名 / 編碼器對應", () => {
    expect(formatOfExt(".FLAC")).toBe("flac");
    expect(formatOfExt("mkv")).toBeNull();
    expect(isRenderFormat("opus")).toBe(true);
    expect(isRenderFormat("wma")).toBe(false);
    expect(formatOfCodec("aac")).toBe("m4a");
    expect(formatOfCodec("vorbis")).toBe("ogg");
    expect(formatOfCodec("pcm_s16le")).toBeNull();
  });
});
