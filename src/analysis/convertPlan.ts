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
export function outPathFor(src: string, format: RenderFormat, outDir: string | null, taken: Set<string>): string {
  const dir = outDir ? outDir + (outDir.endsWith("\\") || outDir.endsWith("/") ? "" : sepOf(outDir || src)) : dirOf(src);
  const base = baseOf(src);
  let candidate = `${dir}${base}.${format}`;
  if (candidate.toLowerCase() === src.toLowerCase()) candidate = `${dir}${base}_converted.${format}`;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${dir}${base}_${n}.${format}`;
    n++;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

/** 這個來源在這組選項下會不會直接複製（給 UI 預告用；Rust 端是最終裁決）。 */
export function willCopy(opts: ConvertOptions, audio: { codec: string; sample_rate: number; channels: number } | null | undefined): boolean {
  if (!audio || !opts.copyIfPossible || opts.targetLufs != null) return false;
  if (opts.sampleRate && opts.sampleRate !== audio.sample_rate) return false;
  if (opts.channels && opts.channels !== audio.channels) return false;
  return formatOfCodec(audio.codec) === opts.format;
}

/** 一句話講這組選項會做什麼。 */
export function describeConvert(opts: ConvertOptions): string {
  const f = FORMATS[opts.format];
  const parts = [f.label];
  if (f.lossless && f.bitDepths.length) parts.push(`${opts.bitDepth}-bit`);
  if (opts.sampleRate) parts.push(`${opts.sampleRate / 1000} kHz`);
  if (opts.channels) parts.push(opts.channels === 1 ? "單聲道" : "立體聲");
  if (opts.targetLufs != null) parts.push(`${opts.targetLufs} LUFS`);
  return parts.join(" · ");
}
