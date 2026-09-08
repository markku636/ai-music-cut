import { describe, expect, it } from "vitest";
import { DEFAULT_CONVERT, describeConvert, effectiveBitDepth, outPathFor, sourceBitDepth, willCopy } from "./convertPlan";

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

describe("effectiveBitDepth / sourceBitDepth", () => {
  it("有損格式沒有位元深度；無損不支援的深度往下夾到最接近的一級", () => {
    expect(effectiveBitDepth("mp3", 24)).toBeNull();
    expect(effectiveBitDepth("opus", 32)).toBeNull();
    expect(effectiveBitDepth("wav", 32)).toBe(32);
    expect(effectiveBitDepth("flac", 16)).toBe(16);
    expect(effectiveBitDepth("flac", 24)).toBe(24);
    // FLAC / AIFF 只有 16 / 24：選 32 實際會編成 24，不能寫 32
    expect(effectiveBitDepth("flac", 32)).toBe(24);
    expect(effectiveBitDepth("aiff", 32)).toBe(24);
  });
  it("來源深度：bits_per_sample 優先，再看 sample_fmt（s16 / flt）；s32 分不出 24 或 32 → null", () => {
    const base = { codec: "flac", sample_rate: 48000, channels: 2 };
    expect(sourceBitDepth({ ...base, bits_per_sample: 24 })).toBe(24);
    expect(sourceBitDepth({ ...base, bits_per_sample: 0, sample_fmt: "s16p" })).toBe(16);
    expect(sourceBitDepth({ ...base, sample_fmt: "flt" })).toBe(32);
    expect(sourceBitDepth({ ...base, sample_fmt: "s32" })).toBeNull();
    expect(sourceBitDepth(base)).toBeNull();
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
  it("無損格式：要的位元深度跟來源不一樣就不算複製；有損格式不看深度", () => {
    const flac16 = { codec: "flac", sample_rate: 48000, channels: 2, bits_per_sample: 16 };
    expect(willCopy({ ...DEFAULT_CONVERT, format: "flac", bitDepth: 16 }, flac16)).toBe(true);
    expect(willCopy({ ...DEFAULT_CONVERT, format: "flac", bitDepth: 24 }, flac16)).toBe(false);
    // FLAC 選 32 實際會編成 24：來源是 24-bit 就還是複製
    expect(willCopy({ ...DEFAULT_CONVERT, format: "flac", bitDepth: 32 }, { ...flac16, bits_per_sample: 24 })).toBe(true);
    // 深度只從 sample_fmt 知道也算
    expect(willCopy({ ...DEFAULT_CONVERT, format: "flac", bitDepth: 24 }, { ...flac16, bits_per_sample: null, sample_fmt: "s16" })).toBe(false);
    // 有損格式：位元深度沒有意義
    expect(willCopy({ ...DEFAULT_CONVERT, format: "m4a", bitDepth: 24 }, aac)).toBe(true);
  });
  it("probe 沒回深度時判不出「不一樣」，維持原判（Rust 端實際上會複製）", () => {
    expect(willCopy({ ...DEFAULT_CONVERT, format: "flac", bitDepth: 24 }, { codec: "flac", sample_rate: 48000, channels: 2 })).toBe(true);
  });
});

describe("describeConvert", () => {
  it("只講有改的東西", () => {
    expect(describeConvert(DEFAULT_CONVERT)).toBe("MP3");
    expect(describeConvert({ ...DEFAULT_CONVERT, format: "flac", bitDepth: 24, sampleRate: 48000, channels: 1, targetLufs: -16 })).toBe("FLAC · 24-bit · 48 kHz · 單聲道 · -16 LUFS");
    expect(describeConvert({ ...DEFAULT_CONVERT, format: "opus", bitDepth: 24 })).toBe("Opus");
  });
  it("講的是實際會編成的深度：FLAC / AIFF 選 32 是 24，WAV 選 32 才是 32", () => {
    expect(describeConvert({ ...DEFAULT_CONVERT, format: "flac", bitDepth: 32 })).toBe("FLAC · 24-bit");
    expect(describeConvert({ ...DEFAULT_CONVERT, format: "aiff", bitDepth: 32 })).toBe("AIFF · 24-bit");
    expect(describeConvert({ ...DEFAULT_CONVERT, format: "wav", bitDepth: 32 })).toBe("WAV · 32-bit");
  });
});
