import { describe, expect, it } from "vitest";
import { DEFAULT_CONVERT, describeConvert, outPathFor, willCopy } from "./convertPlan";

describe("outPathFor", () => {
  it("來源旁邊換副檔名；撞到來源加 _converted（大小寫不分）；同名不同副檔名的第二個加序號", () => {
    const taken = new Set<string>();
    expect(outPathFor("C:\\a\\ep1.mp4", "m4a", null, taken)).toBe("C:\\a\\ep1.m4a");
    // 同副檔名的來源：先閃自己（_converted），大小寫不分
    expect(outPathFor("C:\\a\\ep1.M4A", "m4a", null, taken)).toBe("C:\\a\\ep1_converted.m4a");
    expect(outPathFor("C:\\a\\ep2.mp3", "mp3", null, taken)).toBe("C:\\a\\ep2_converted.mp3");
    // 兩個同名不同副檔名的來源轉同一格式：第二個加序號
    expect(outPathFor("C:\\a\\ep3.wav", "mp3", null, taken)).toBe("C:\\a\\ep3.mp3");
    expect(outPathFor("C:\\a\\EP3.flac", "mp3", null, taken)).toBe("C:\\a\\EP3_2.mp3");
    expect(outPathFor("/x/song.flac", "opus", "/out", new Set())).toBe("/out/song.opus");
  });
  it("輸出不會蓋到同一批裡別的來源（a.wav → mp3 時 a.mp3 也在批次裡）", () => {
    const sources = new Set(["c:\\a\\a.wav", "c:\\a\\a.mp3"]);
    const taken = new Set<string>();
    expect(outPathFor("C:\\a\\a.wav", "mp3", null, taken, sources)).toBe("C:\\a\\a_converted.mp3");
    expect(outPathFor("C:\\a\\a.mp3", "mp3", null, taken, sources)).toBe("C:\\a\\a_2.mp3");
    expect(outPathFor("/x/song.flac", "opus", "/out/", new Set())).toBe("/out/song.opus");
  });
});

describe("willCopy", () => {
  const aac = { codec: "aac", sample_rate: 48000, channels: 2 };
  it("同編碼器、不改取樣率 / 聲道、不正規化才會複製", () => {
    expect(willCopy({ ...DEFAULT_CONVERT, format: "m4a" }, aac)).toBe(true);
    expect(willCopy({ ...DEFAULT_CONVERT, format: "mp3" }, aac)).toBe(false);
    expect(willCopy({ ...DEFAULT_CONVERT, format: "m4a", targetLufs: -16 }, aac)).toBe(false);
    expect(willCopy({ ...DEFAULT_CONVERT, format: "m4a", sampleRate: 44100 }, aac)).toBe(false);
    expect(willCopy({ ...DEFAULT_CONVERT, format: "m4a", channels: 1 }, aac)).toBe(false);
    expect(willCopy({ ...DEFAULT_CONVERT, format: "m4a", copyIfPossible: false }, aac)).toBe(false);
    expect(willCopy({ ...DEFAULT_CONVERT, format: "m4a" }, null)).toBe(false);
  });
});

describe("describeConvert", () => {
  it("只講有改的東西", () => {
    expect(describeConvert(DEFAULT_CONVERT)).toBe("MP3");
    expect(describeConvert({ ...DEFAULT_CONVERT, format: "flac", bitDepth: 24, sampleRate: 48000, channels: 1, targetLufs: -16 })).toBe("FLAC · 24-bit · 48 kHz · 單聲道 · -16 LUFS");
    expect(describeConvert({ ...DEFAULT_CONVERT, format: "opus", bitDepth: 24 })).toBe("Opus");
  });
});
