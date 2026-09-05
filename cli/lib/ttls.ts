// ttls（Seal-TTS REST）client for the CLI：金鑰只從 --key / 環境變數 / .env.local 讀，絕不印出。
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface TtlsClient {
  base: string;
  key: string;
}

export function resolveKey(explicit?: string, cwd = process.cwd()): string | null {
  if (explicit?.trim()) return explicit.trim();
  if (process.env.AICUT_TTLS_API_KEY?.trim()) return process.env.AICUT_TTLS_API_KEY.trim();
  return null;
}

/** 讀 .env.local（gitignored）的 AICUT_TTLS_API_KEY；找不到回 null。 */
export async function keyFromEnvFile(dir: string): Promise<string | null> {
  for (const d of [dir, path.dirname(dir), path.dirname(path.dirname(dir))]) {
    try {
      const txt = await readFile(path.join(d, ".env.local"), "utf8");
      const m = /^\s*AICUT_TTLS_API_KEY\s*=\s*"?([^"\r\n]+)"?/m.exec(txt);
      if (m?.[1]?.trim()) return m[1].trim();
    } catch {
      /* 沒有就下一層 */
    }
  }
  return null;
}

function headers(c: TtlsClient): Record<string, string> {
  return { "X-API-Key": c.key };
}

async function fail(r: Response): Promise<never> {
  const text = await r.text().catch(() => "");
  let detail = text.slice(0, 300);
  try {
    const j = JSON.parse(text) as { detail?: unknown };
    if (typeof j.detail === "string") detail = j.detail;
  } catch {
    /* 非 JSON */
  }
  if (r.status === 401 || r.status === 403) throw new Error("ttls 金鑰缺少或錯誤（401/403）");
  throw new Error(`ttls ${r.status}: ${detail}`);
}

export async function health(c: TtlsClient): Promise<{ ok: boolean; status: number; detail?: string }> {
  try {
    const r = await fetch(`${c.base}/healthz`, { signal: AbortSignal.timeout(10_000) });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, status: 0, detail: String(e) };
  }
}

export interface TranscribeOpts {
  language: string;
  model: string;
  hotwords: string;
  onProgress?: (status: string, progress: string | null, waitingSec: number) => void;
}

/** 上傳 → 202 job → 輪詢 → 取結果（伺服器原始 JSON，交給 normalizeTranscript）。 */
export async function transcribe(c: TtlsClient, uploadPath: string, opts: TranscribeOpts): Promise<unknown> {
  const buf = await readFile(uploadPath);
  const form = new FormData();
  form.append("audio", new Blob([buf], { type: "audio/ogg" }), path.basename(uploadPath));
  form.append("language", opts.language);
  form.append("model", opts.model);
  form.append("hotwords", opts.hotwords);
  form.append("zh_convert", "s2twp");
  let jobId: string | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(`${c.base}/v1/transcribe/jobs`, { method: "POST", headers: headers(c), body: form, signal: AbortSignal.timeout(180_000) });
    if (r.status === 202) {
      jobId = ((await r.json()) as { job_id: string }).job_id;
      break;
    }
    if (r.status === 503 || r.status === 429) {
      const wait = Math.min(60_000, 3000 * 2 ** attempt);
      opts.onProgress?.("busy", null, wait / 1000);
      await new Promise((res) => setTimeout(res, wait));
      continue;
    }
    await fail(r);
  }
  if (!jobId) throw new Error("ttls 持續忙碌，請稍後再試");
  const started = Date.now();
  for (;;) {
    await new Promise((res) => setTimeout(res, Date.now() - started < 60_000 ? 2000 : 5000));
    const r = await fetch(`${c.base}/v1/transcribe/jobs/${jobId}`, { headers: headers(c), signal: AbortSignal.timeout(30_000) });
    if (!r.ok) await fail(r);
    const info = (await r.json()) as { status: string; progress: string | null; error?: string | null; waiting_sec: number };
    opts.onProgress?.(info.status, info.progress, info.waiting_sec);
    if (info.status === "done") break;
    if (info.status === "failed") throw new Error(info.error ?? "轉寫失敗");
    if (info.status === "cancelled") throw new Error("轉寫任務已被取消");
  }
  const r = await fetch(`${c.base}/v1/transcribe/jobs/${jobId}/result`, { headers: headers(c), signal: AbortSignal.timeout(60_000) });
  if (!r.ok) await fail(r);
  return r.json();
}

export interface StemOut {
  name: string;
  label: string;
  format: string;
  data: Buffer;
}

/** POST /v1/separate（同步）：回各軌 bytes。 */
export async function separate(c: TtlsClient, filePath: string, stems: "vocals_accom" | "all", format: string): Promise<StemOut[]> {
  const buf = await readFile(filePath);
  const form = new FormData();
  form.append("audio", new Blob([buf]), path.basename(filePath));
  form.append("stems", stems);
  form.append("target_format", format);
  form.append("device", "auto");
  const r = await fetch(`${c.base}/v1/separate`, { method: "POST", headers: headers(c), body: form, signal: AbortSignal.timeout(1_200_000) });
  if (!r.ok) await fail(r);
  const j = (await r.json()) as { stems: { name: string; label: string; format: string; audio_b64: string }[] };
  return (j.stems ?? []).map((s) => ({ name: s.name, label: s.label, format: s.format, data: Buffer.from(s.audio_b64, "base64") }));
}

export interface MusicParams {
  prompt: string;
  durationSec: number;
  bpm: number;
  quality: string;
  nCandidates: number;
  format: string;
  onProgress?: (status: string, sec: number) => void;
}

export interface MusicOut {
  index: number;
  format: string;
  data: Buffer;
  seed?: number;
}

/** ACE-Step 配樂：POST /v1/music → 輪詢 → 下載每首候選。 */
export async function generateMusic(c: TtlsClient, p: MusicParams): Promise<MusicOut[]> {
  const body: Record<string, unknown> = {
    prompt: p.prompt,
    duration_sec: p.durationSec,
    n_candidates: Math.max(1, Math.min(4, p.nCandidates)),
    format: p.format,
    seed: -1,
  };
  if (p.bpm > 0) body.bpm = p.bpm;
  if (p.quality) body.quality = p.quality;
  const r = await fetch(`${c.base}/v1/music`, {
    method: "POST",
    headers: { ...headers(c), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (r.status !== 202) await fail(r);
  const { job_id: jobId } = (await r.json()) as { job_id: string };
  const started = Date.now();
  let info: { status: string; error?: string | null; audio_format?: string | null; outputs?: { index: number; audio_format?: string; seed?: number }[] };
  for (;;) {
    await new Promise((res) => setTimeout(res, 3000));
    const s = await fetch(`${c.base}/v1/music/jobs/${jobId}`, { headers: headers(c), signal: AbortSignal.timeout(30_000) });
    if (!s.ok) await fail(s);
    info = (await s.json()) as typeof info;
    p.onProgress?.(info.status, Math.round((Date.now() - started) / 1000));
    if (info.status === "done") break;
    if (info.status === "failed") throw new Error(info.error ?? "音樂生成失敗");
    if (info.status === "cancelled") throw new Error("任務已取消");
  }
  const outs = info.outputs?.length ? info.outputs : [{ index: 0, audio_format: info.audio_format ?? p.format }];
  const files: MusicOut[] = [];
  for (const o of outs) {
    const a = await fetch(`${c.base}/v1/music/jobs/${jobId}/audio?i=${o.index}`, { headers: headers(c), signal: AbortSignal.timeout(300_000) });
    if (!a.ok) await fail(a);
    files.push({ index: o.index, format: o.audio_format || info.audio_format || p.format, data: Buffer.from(await a.arrayBuffer()), seed: o.seed });
  }
  return files;
}
