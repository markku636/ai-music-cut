// 轉檔的純決策：輸出檔名、撞名處理、一批的摘要。Rust convert.rs 決定「能不能直接複製」與跑 ffmpeg。
import { FORMATS, formatOfCodec, type BitDepth, type RenderFormat } from "./formats";

export interface ConvertOptions {
  format: RenderFormat;
  /** 0 = 沿用來源 */
  sampleRate: 0 | 44100 | 48000;
  /** 0 = 沿用來源 */
  channels: 0 | 1 | 2;
  bitDepth: BitDepth;
  /** null = 不正規化 */
  targetLufs: number | null;
  copyIfPossible: boolean;
}

export const DEFAULT_CONVERT: ConvertOptions = { format: "mp3", sampleRate: 0, channels: 0, bitDepth: 16, targetLufs: null, copyIfPossible: true };

function sepOf(p: string): string {
  return p.includes("\\") ? "\\" : "/";
}

export function dirOf(p: string): string {
  return p.slice(0, p.lastIndexOf(sepOf(p)) + 1);
}

export function baseOf(p: string): string {
  return p.slice(dirOf(p).length).replace(/\.[^.]+$/, "");
}

/**
 * 輸出路徑：來源旁邊、換副檔名；撞到來源本身（同副檔名）就加 `_converted`。
 * `taken` 是這一批已經分配掉的路徑（Windows 大小寫不分，用小寫比）—— 兩個來源同名不同副檔名時第二個要再加序號。
 */
export function outPathFor(src: string, format: RenderFormat, outDir: string | null, taken: Set<string>, sources?: ReadonlySet<string>): string {
  const dir = outDir ? outDir + (outDir.endsWith("\\") || outDir.endsWith("/") ? "" : sepOf(outDir || src)) : dirOf(src);
  const base = baseOf(src);
  const lc = (s: string) => s.toLowerCase();
  // `sources` 是這一批**所有來源**（小寫）：a.wav → mp3 時同批還有 a.mp3，輸出不能把它蓋掉
  const isSource = (c: string) => lc(c) === lc(src) || (sources?.has(lc(c)) ?? false);
  let candidate = `${dir}${base}.${format}`;
  if (isSource(candidate)) candidate = `${dir}${base}_converted.${format}`;
  let n = 2;
  while (taken.has(lc(candidate)) || isSource(candidate)) {
    candidate = `${dir}${base}_${n}.${format}`;
    n++;
  }
  taken.add(lc(candidate));
  return candidate;
}

/** UI 拿得到的來源音軌資訊。位元深度是選填：probe 目前還沒回，哪天回了就自動生效。 */
export interface SourceAudio {
  codec: string;
  sample_rate: number;
  channels: number;
  /** ffprobe 的 bits_per_sample（0 / 缺 = 不知道）。 */
  bits_per_sample?: number | null;
  /** ffprobe 的 sample_fmt（s16 / s16p / flt…）。 */
  sample_fmt?: string | null;
}

/**
 * 這個格式**實際**會編成幾位元。能力表（FORMATS[f].bitDepths）沒有的深度往下夾到最接近的一級：
 * FLAC 選 32 → 24，不能寫「FLAC · 32-bit」然後編出別的東西。有損格式沒有位元深度這回事 → null。
 */
export function effectiveBitDepth(format: RenderFormat, requested: BitDepth): BitDepth | null {
  const depths = FORMATS[format].bitDepths;
  if (!depths.length) return null;
  if (depths.includes(requested)) return requested;
  const below = depths.filter((d) => d < requested);
  return (below.length ? Math.max(...below) : Math.min(...depths)) as BitDepth;
}

/** 來源的位元深度：bits_per_sample 優先，再看 sample_fmt；判不出（含 s32 —— 24 或 32 都會這樣報）回 null。 */
export function sourceBitDepth(audio: SourceAudio): BitDepth | null {
  const bps = audio.bits_per_sample ?? 0;
  if (bps === 16 || bps === 24 || bps === 32) return bps;
  switch ((audio.sample_fmt ?? "").toLowerCase().replace(/p$/, "")) {
    case "s16":
      return 16;
    case "flt":
      return 32;
    default:
      return null;
  }
}

/** 這個來源在這組選項下會不會直接複製（給 UI 預告用；Rust 端是最終裁決）。 */
export function willCopy(opts: ConvertOptions, audio: SourceAudio | null | undefined): boolean {
  if (!audio || !opts.copyIfPossible || opts.targetLufs != null) return false;
  if (opts.sampleRate && opts.sampleRate !== audio.sample_rate) return false;
  if (opts.channels && opts.channels !== audio.channels) return false;
  if (formatOfCodec(audio.codec) !== opts.format) return false;
  // 無損格式：複製會原樣保留來源的深度，所以要的深度跟來源不一樣就不能說是「複製」。
  // probe 沒回深度時判不出「不一樣」，維持原判（Rust 端目前也不看深度，實際上就是會複製）。
  const want = effectiveBitDepth(opts.format, opts.bitDepth);
  const have = sourceBitDepth(audio);
  return want == null || have == null || want === have;
}

/** 一句話講這組選項會做什麼。 */
export function describeConvert(opts: ConvertOptions): string {
  const f = FORMATS[opts.format];
  const parts = [f.label];
  // 講實際會編成的深度，不是使用者選的那個（FLAC 選 32 實際是 24）
  const depth = effectiveBitDepth(opts.format, opts.bitDepth);
  if (depth != null) parts.push(`${depth}-bit`);
  if (opts.sampleRate) parts.push(`${opts.sampleRate / 1000} kHz`);
  if (opts.channels) parts.push(opts.channels === 1 ? "單聲道" : "立體聲");
  if (opts.targetLufs != null) parts.push(`${opts.targetLufs} LUFS`);
  return parts.join(" · ");
}
