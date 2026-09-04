import { invoke } from "@tauri-apps/api/core";

// 單一 Rust 邊界：所有 invoke 集中在此，型別對齊 src-tauri（snake_case 欄位照 Rust struct）。

export interface AppSettings {
  ttls_base_url: string;
  ffmpeg_path: string | null;
  claude_model: string;
  default_aggressiveness: number;
  target_lufs: number;
  output_dir: string | null;
  lang: string;
  judge_enabled: boolean;
  asr_language: string;
  asr_model: string;
  hotwords: string;
  recent_projects: string[];
}

export interface FfmpegStatus {
  found: boolean;
  ffmpeg_path: string | null;
  ffprobe_path: string | null;
  version: string | null;
  source: string | null;
}

export interface AudioStreamInfo {
  codec: string;
  sample_rate: number;
  channels: number;
  bit_rate: number | null;
}

export interface MediaProbe {
  path: string;
  size_bytes: number;
  duration_ms: number;
  container: string;
  audio: AudioStreamInfo | null;
  video: { codec: string; width: number; height: number } | null;
  fingerprint: string;
}

export interface TtlsHealth {
  ok: boolean;
  status: string | null;
  queue_pending: number | null;
  max_pending: number | null;
  gpu_locked: boolean | null;
  degraded: boolean | null;
  latency_ms: number | null;
  error: string | null;
}

export interface KeyStatus {
  present: boolean;
  hint: string | null;
}

export interface AppPaths {
  config_dir: string;
  cache_dir: string;
}

export interface CacheStatus {
  upload: boolean;
  analysis: boolean;
  transcript: boolean;
  dir: string;
}

export interface PrepareResult {
  upload_path: string;
  cached: boolean;
}

/** ttls `GET /v1/transcribe/jobs/{id}` snapshot。 */
export interface TranscribeJobInfo {
  job_id: string;
  status: "queued" | "running" | "post" | "done" | "failed" | "cancelled";
  error: string | null;
  progress: string | null;
  summary: Record<string, unknown>;
  result_url: string | null;
  waiting_sec: number;
  running_sec: number | null;
}

/** `media-progress` 事件 payload。 */
export interface MediaProgress {
  job_id: string;
  phase: string;
  pct: number;
}

export interface ClaudeStatus {
  installed: boolean;
  version: string | null;
  logged_in: boolean;
  path: string | null;
}

/** `claude-stream` 事件 payload。 */
export interface ClaudeStreamEvent {
  req_id: string;
  kind: "system" | "text" | "tool" | "tool_result" | "result" | "error" | "done";
  text?: string;
  session_id?: string;
  model?: string;
  tool?: string;
  is_error?: boolean;
  duration_ms?: number;
  code?: number;
}

/** `mcp-tool-call` 事件 payload。 */
export interface McpToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface McpInfo {
  port: number;
  url: string;
  tools: number;
}

export interface RenderSeg {
  src_start_ms: number;
  src_end_ms: number;
  gain_db: number;
}
export interface RenderJoin {
  kind: "crossfade" | "gap" | "seam";
  ms: number;
}
/** 區段效果（來源時間；Rust 逐 frame 乘上包絡）。 */
export interface RenderEffect {
  kind: "mute" | "gain" | "fade_in" | "fade_out";
  start_ms: number;
  end_ms: number;
  db: number;
}
export interface RenderPlan {
  segs: RenderSeg[];
  effects: RenderEffect[];
  joins: RenderJoin[];
  crossfade_ms: number;
  target_lufs: number;
  true_peak_dbtp: number;
  format: "mp3" | "m4a" | "wav";
  out_path: string;
  channels: number;
}
export interface RenderProgress {
  job_id: string;
  stage: "cut" | "measure" | "encode";
  pct: number;
}
export interface RenderDone {
  job_id: string;
  ok: boolean;
  out_path: string | null;
  error: string | null;
  input_lufs: number | null;
  output_lufs: number | null;
  output_tp: number | null;
  elapsed_ms: number;
}

/** ttls /v1/separate 各軌落地結果。 */
export interface SeparateStem {
  name: string;
  label: string;
  format: string;
  path: string;
  bytes: number;
}

/** Rust `AppError` 序列化形狀。 */
export interface AppErrorShape {
  kind: string;
  code: string;
  message: string;
  status?: number | null;
}

export function isAppError(e: unknown): e is AppErrorShape {
  return !!e && typeof e === "object" && "code" in e && "message" in e;
}

/** 任何 catch 到的東西 → 可顯示的訊息。 */
export function errMessage(e: unknown, fallback = "發生未知錯誤"): string {
  if (isAppError(e)) return e.message;
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return fallback;
}

export function errStatus(e: unknown): number | null {
  return isAppError(e) ? (e.status ?? null) : null;
}

export function errKind(e: unknown): string | null {
  return isAppError(e) ? e.kind : null;
}

export const api = {
  showMainWindow: () => invoke<void>("show_main_window"),
  clientLog: (msg: string) => invoke<void>("client_log", { msg }),
  devEnv: (name: string) => invoke<string | null>("dev_env", { name }),
  settingsGet: () => invoke<AppSettings>("settings_get"),
  settingsSet: (settings: AppSettings) => invoke<AppSettings>("settings_set", { settings }),
  appPaths: () => invoke<AppPaths>("app_paths"),
  ffmpegDetect: (custom?: string | null) => invoke<FfmpegStatus>("ffmpeg_detect", { custom: custom ?? null }),
  mediaProbe: (path: string) => invoke<MediaProbe>("media_probe", { path }),
  mediaFingerprint: (path: string) => invoke<string>("media_fingerprint", { path }),
  mediaCacheStatus: (fingerprint: string) => invoke<CacheStatus>("media_cache_status", { fingerprint }),
  mediaPrepare: (path: string, fingerprint: string) => invoke<PrepareResult>("media_prepare", { path, fingerprint }),
  /** 回自訂二進位（見 analysis/peaks.ts）。 */
  mediaAnalyzeLocal: (jobId: string, path: string, fingerprint: string, durationMs: number) =>
    invoke<ArrayBuffer>("media_analyze_local", { jobId, path, fingerprint, durationMs }),
  mediaCancel: (jobId: string) => invoke<void>("media_cancel", { jobId }),
  mediaCacheWriteTranscript: (fingerprint: string, doc: unknown) => invoke<void>("media_cache_write_transcript", { fingerprint, doc }),
  mediaCacheReadTranscript: (fingerprint: string) => invoke<unknown | null>("media_cache_read_transcript", { fingerprint }),
  mediaCacheClear: (fingerprint?: string) => invoke<void>("media_cache_clear", { fingerprint: fingerprint ?? null }),
  ttlsHealth: () => invoke<TtlsHealth>("ttls_health"),
  ttlsKeyStatus: () => invoke<KeyStatus>("ttls_key_status"),
  ttlsKeySet: (key: string) => invoke<KeyStatus>("ttls_key_set", { key }),
  ttlsKeyClear: () => invoke<KeyStatus>("ttls_key_clear"),
  ttlsKeyVerify: () => invoke<boolean>("ttls_key_verify"),
  ttlsTranscribeStart: (uploadPath: string, language: string, model: string, hotwords: string) =>
    invoke<string>("ttls_transcribe_start", { uploadPath, language, model, hotwords }),
  ttlsTranscribePoll: (jobId: string) => invoke<TranscribeJobInfo>("ttls_transcribe_poll", { jobId }),
  ttlsTranscribeResult: (jobId: string) => invoke<unknown>("ttls_transcribe_result", { jobId }),
  ttlsTranscribeCancel: (jobId: string) => invoke<void>("ttls_transcribe_cancel", { jobId }),
  /** 去人聲 / 分軌（同步等待伺服器；用 mediaCancel(jobId) 放棄）。 */
  ttlsSeparate: (jobId: string, path: string, stems: string, targetFormat: string, outDir: string | null) =>
    invoke<SeparateStem[]>("ttls_separate", { jobId, path, stems, targetFormat, outDir }),
  renderStart: (jobId: string, src: string, plan: RenderPlan) => invoke<void>("render_start", { jobId, src, plan }),
  renderCancel: (jobId: string) => invoke<void>("render_cancel", { jobId }),
  projectSave: (path: string, doc: unknown) => invoke<void>("project_save", { path, doc }),
  projectLoad: (path: string) => invoke<unknown>("project_load", { path }),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  openExternal: (url: string) => invoke<void>("open_external", { url }),
  claudeDetect: () => invoke<ClaudeStatus>("claude_detect"),
  claudeSend: (reqId: string, prompt: string, sessionId: string | null, model: string | null, mode: "agent" | "advise", systemPrompt: string | null) =>
    invoke<void>("claude_send", { reqId, prompt, sessionId, model, mode, systemPrompt }),
  claudeCancel: (reqId: string) => invoke<void>("claude_cancel", { reqId }),
  claudeStructured: (prompt: string, schema: unknown, model: string | null, systemPrompt: string | null, timeoutMs?: number) =>
    invoke<unknown>("claude_structured", { prompt, schema, model, systemPrompt, timeoutMs: timeoutMs ?? null }),
  mcpSetTools: (tools: McpToolDef[]) => invoke<number>("mcp_set_tools", { tools }),
  mcpToolResult: (id: string, result: unknown, error: string | null) => invoke<boolean>("mcp_tool_result", { id, result, error }),
  mcpInfo: () => invoke<McpInfo>("mcp_info"),
};
