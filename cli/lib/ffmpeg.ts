// ffmpeg / ffprobe（CLI 版）：探測、上傳用轉檔、依保留段剪接 + 效果 + loudnorm 兩趟。
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface Probe {
  durationMs: number;
  codec: string;
  sampleRate: number;
  channels: number;
}

function run(bin: string, args: string[], opts: { onStderr?: (line: string) => void } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    p.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      if (opts.onStderr) for (const line of s.split(/\r?\n|\r/)) if (line.trim()) opts.onStderr(line);
    });
    p.on("error", (e) => reject(new Error(`無法執行 ${bin}：${e.message}（請安裝 ffmpeg 並加入 PATH，或用 --ffmpeg 指定）`)));
    p.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

export class Ffmpeg {
  constructor(
    readonly ffmpeg = "ffmpeg",
    readonly ffprobe = "ffprobe",
  ) {}

  async probe(file: string): Promise<Probe> {
    const r = await run(this.ffprobe, ["-v", "error", "-select_streams", "a:0", "-show_entries", "format=duration:stream=codec_name,sample_rate,channels", "-of", "json", file]);
    if (r.code !== 0) throw new Error(`ffprobe 失敗：${r.stderr.trim().slice(-300)}`);
    const j = JSON.parse(r.stdout) as { format?: { duration?: string }; streams?: { codec_name?: string; sample_rate?: string; channels?: number }[] };
    const s = j.streams?.[0];
    if (!s) throw new Error("檔案裡沒有音軌");
    return { durationMs: Math.round(Number(j.format?.duration ?? 0) * 1000), codec: s.codec_name ?? "?", sampleRate: Number(s.sample_rate ?? 0), channels: s.channels ?? 1 };
  }


  /**
   * 解碼成 mono f32 並算 5 ms RMS 桶（與 Rust media.rs 的 analysis.bin 同一套 u8 映射：0..255 ↔ −60..0 dBFS）。
   * 給 CLI 的節拍偵測用；App 走 Rust 版本。
   */
  async rmsBuckets(file: string, pps = 200): Promise<{ rmsU8: Uint8Array; pps: number; sampleRate: number; totalSamples: number }> {
    const sr = 48000;
    const per = Math.max(1, Math.round(sr / pps));
    return new Promise((resolve, reject) => {
      const p = spawn(this.ffmpeg, ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(sr), "-f", "f32le", "-"], { windowsHide: true });
      const out: number[] = [];
      let acc = 0;
      let n = 0;
      let total = 0;
      let carry = Buffer.alloc(0);
      let err = "";
      p.stderr.on("data", (d: Buffer) => (err += d.toString()));
      p.stdout.on("data", (chunk: Buffer) => {
        const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
        const usable = buf.length - (buf.length % 4);
        for (let i = 0; i < usable; i += 4) {
          const v = buf.readFloatLE(i);
          acc += v * v;
          n += 1;
          total += 1;
          if (n === per) {
            const rms = Math.sqrt(acc / n);
            const db = rms > 0 ? 20 * Math.log10(rms) : -120;
            out.push(Math.max(0, Math.min(255, Math.round(((db + 60) / 60) * 255))));
            acc = 0;
            n = 0;
          }
        }
        carry = buf.subarray(usable);
      });
      p.on("error", (e) => reject(new Error(`無法執行 ${this.ffmpeg}：${e.message}`)));
      p.on("close", (code) => {
        if (code !== 0) return reject(new Error(`解碼失敗：${err.trim().slice(-200)}`));
        resolve({ rmsU8: Uint8Array.from(out), pps, sampleRate: sr, totalSamples: total });
      });
    });
  }

  /** 切出 [startMs, endMs] 成 44.1k 立體聲 wav（曲風轉換的參考片段）。 */
  async clip(file: string, startMs: number, endMs: number, out: string): Promise<void> {
    const ss = Math.max(0, startMs) / 1000;
    const dur = Math.max(0.05, (endMs - startMs) / 1000);
    const r = await run(this.ffmpeg, ["-y", "-v", "error", "-ss", ss.toFixed(3), "-t", dur.toFixed(3), "-i", file, "-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", "-f", "wav", out]);
    if (r.code !== 0) throw new Error(`切片失敗：${r.stderr.trim().slice(-300)}`);
  }

  /** 上傳用 16k mono opus（與 App 相同）。 */
  async toUploadOpus(file: string, out: string): Promise<void> {
    const r = await run(this.ffmpeg, ["-y", "-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "libopus", "-b:a", "48k", "-f", "ogg", out]);
    if (r.code !== 0) throw new Error(`轉檔失敗：${r.stderr.trim().slice(-300)}`);
  }

  /**
   * 剪接：每個保留段 atrim + 段內增益 + 頭尾 8 ms 淡入淡出（避免爆音）→ concat → 效果包絡（volume 表達式）→ loudnorm 兩趟。
   * 效果以 ffmpeg volume filter 的 `eval=frame` 表達式套用在來源時間上（剪接前），語意與 App 的 analysis/effects.ts 相同（邊緣 5 ms 平滑）。
   */
  async render(
    src: string,
    segs: { startMs: number; endMs: number; gainDb: number }[],
    effects: { kind: "mute" | "gain" | "fade_in" | "fade_out"; startMs: number; endMs: number; db?: number }[],
    out: string,
    opts: { targetLufs: number; truePeak: number; format: "mp3" | "m4a" | "wav"; onProgress?: (stage: string) => void },
  ): Promise<{ inputLufs: number | null; outputLufs: number | null }> {
    if (!segs.length) throw new Error("沒有任何保留段");
    const tmp = await mkdtemp(path.join(os.tmpdir(), "aicut-"));
    try {
      const wav = path.join(tmp, "cut.wav");
      const fx = effects.length ? `volume=volume='${effectExpr(effects)}':eval=frame,` : "";
      const parts: string[] = [];
      const labels: string[] = [];
      segs.forEach((s, i) => {
        const len = Math.max(0.02, (s.endMs - s.startMs) / 1000);
        const fade = Math.min(0.008, len / 4);
        parts.push(
          `[0:a]${fx}atrim=start=${(s.startMs / 1000).toFixed(3)}:end=${(s.endMs / 1000).toFixed(3)},asetpts=PTS-STARTPTS,volume=${s.gainDb.toFixed(2)}dB,afade=t=in:st=0:d=${fade.toFixed(3)},afade=t=out:st=${Math.max(0, len - fade).toFixed(3)}:d=${fade.toFixed(3)}[s${i}]`,
        );
        labels.push(`[s${i}]`);
      });
      const graph = `${parts.join(";")};${labels.join("")}concat=n=${segs.length}:v=0:a=1[out]`;
      opts.onProgress?.("cut");
      let r = await run(this.ffmpeg, ["-y", "-v", "error", "-i", src, "-filter_complex", graph, "-map", "[out]", "-ar", "48000", "-c:a", "pcm_f32le", wav]);
      if (r.code !== 0) throw new Error(`剪接失敗：${r.stderr.trim().slice(-400)}`);

      opts.onProgress?.("measure");
      const base = `loudnorm=I=${opts.targetLufs}:TP=${opts.truePeak}:LRA=11`;
      r = await run(this.ffmpeg, ["-hide_banner", "-nostats", "-i", wav, "-af", `${base}:print_format=json`, "-f", "null", "-"]);
      const m = parseLoudnorm(r.stderr);
      if (!m) throw new Error(`loudnorm 量測失敗：${r.stderr.trim().slice(-300)}`);

      opts.onProgress?.("encode");
      const af = `${base}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=json,alimiter=limit=${Math.pow(10, opts.truePeak / 20).toFixed(3)}:level=false`;
      const enc = opts.format === "mp3" ? ["-c:a", "libmp3lame", "-q:a", "2"] : opts.format === "m4a" ? ["-c:a", "aac", "-b:a", "160k"] : ["-c:a", "pcm_s16le"];
      r = await run(this.ffmpeg, ["-y", "-hide_banner", "-nostats", "-i", wav, "-af", af, "-ar", "48000", ...enc, "-f", opts.format === "m4a" ? "ipod" : opts.format, out]);
      if (r.code !== 0) throw new Error(`編碼失敗：${r.stderr.trim().slice(-400)}`);
      const m2 = parseLoudnorm(r.stderr);
      return { inputLufs: m ? Number(m.input_i) : null, outputLufs: m2 ? Number(m2.output_i) : null };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}

/** 效果 → ffmpeg volume 表達式（t 為來源秒數）。 */
export function effectExpr(effects: { kind: string; startMs: number; endMs: number; db?: number; shape?: string }[]): string {
  const EDGE = 0.005;
  const terms = effects.map((e) => {
    const s = (e.startMs / 1000).toFixed(4);
    const en = (e.endMs / 1000).toFixed(4);
    const len = Math.max(0.001, (e.endMs - e.startMs) / 1000).toFixed(4);
    const inside = `between(t,${s},${en})`;
    switch (e.kind) {
      case "fade_in":
      case "fade_out": {
        // 曲線與 analysis/effects.ts 的 fadeCurve 一致：等功率 sin/cos、指數 10^(−3·…)
        const p = `((t-${s})/${len})`;
        const fin = e.kind === "fade_in";
        let curve: string;
        if (e.shape === "equal_power") curve = fin ? `sin(${p}*PI/2)` : `cos(${p}*PI/2)`;
        else if (e.shape === "exponential") curve = fin ? `pow(10,-3*(1-${p}))` : `pow(10,-3*${p})`;
        else curve = fin ? p : `(1-${p})`;
        return `if(${inside},${curve},1)`;
      }
      case "invert": {
        const edge = Math.min(EDGE, Number(len) / 2).toFixed(4);
        const w = `clip(min(t-${s},${en}-t)/${edge},0,1)`;
        return `if(${inside},1-2*${w},1)`;
      }
      case "mute":
      case "gain": {
        const target = e.kind === "mute" ? "0" : Math.pow(10, (e.db ?? 0) / 20).toFixed(4);
        const edge = Math.min(EDGE, Number(len) / 2).toFixed(4);
        const w = `clip(min(t-${s},${en}-t)/${edge},0,1)`;
        return `if(${inside},1+(${target}-1)*${w},1)`;
      }
      default:
        return "1";
    }
  });
  return terms.length ? terms.join("*") : "1";
}

interface Loudnorm {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  output_i: string;
  target_offset: string;
}

export function parseLoudnorm(stderr: string): Loudnorm | null {
  const i = stderr.lastIndexOf('"input_i"');
  if (i < 0) return null;
  const start = stderr.lastIndexOf("{", i);
  const end = stderr.indexOf("}", i);
  if (start < 0 || end < 0) return null;
  try {
    return JSON.parse(stderr.slice(start, end + 1)) as Loudnorm;
  } catch {
    return null;
  }
}
