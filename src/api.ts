import { invoke } from "@tauri-apps/api/core";

// 單一 Rust 邊界：所有 invoke 集中在此，型別對齊 src-tauri（snake_case 欄位照 Rust struct）。

export interface AppSettings {
  ttls_base_url: string;
  ffmpeg_path: string | null;
  claude_model: string;
  /** 結構化產出的 CLI："claude" 或 "codex"。 */
  agent_backend: string;
  /** 逐字稿來源："ttls"（預設，上傳到伺服器）或 "local"（本機 faster-whisper）。 */
  asr_source: string;
  claude_review_model: string;
  /** "editor" | "editor+reviewer" */
  judge_roles: string;
  default_aggressiveness: number;
  target_lufs: number;
  output_dir: string | null;
  lang: string;
  judge_enabled: boolean;
  asr_language: string;
  asr_model: string;
  hotwords: string;
  recent_projects: string[];
  /** 使用者改過的提示詞（id -> 內容）；只存被改過的那幾條。 */
  prompt_overrides: Record<string, string>;
  /** 使用者的贅字裁決（詞 -> "always" | "context" | "never"）；只存被動過的那幾個。 */
  filler_rules: Record<string, string>;
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
  /** gap 接點的前段淡出 / 後段淡入（毫秒）；省略時 Rust 用預設值。 */
  fade_out_ms?: number;
  fade_in_ms?: number;
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
  /** 預覽模式：跳過 loudnorm 兩趟，只做 limiter + mp3 q5。 */
  preview?: boolean;
  /** 章節（ffmetadata 全文；mp3 → ID3 CHAP、m4a → QuickTime 章節）。wav / 預覽會忽略。 */
  chapters_meta?: string;
  /** 墊樂 / 音效軌（位置是成品時間）。 */
  overlays?: RenderOverlay[];
  /** 分軌輸出：主聲軌靜音，只留 overlays（配樂 stem）。 */
  mute_main?: boolean;
  /** 已量好的響度；有值就跳過量測那一趟。分軌一定要沿用主混音的那一組。 */
  loudnorm_measured?: LoudnormStats | null;
  /**
   * 修聲（去隆隆 / 降噪 / 齒音）。濾鏡字串在 Rust 端組（`cleanup.rs`），這裡只送數字。
   * 這條鏈會同時進響度量測與編碼兩趟 —— 只進編碼那趟的話成品響度會偏。
   */
  cleanup?: CleanupPlan | null;
}

/** 與 `analysis/cleanup.ts` 的 CleanupSpec 同一組數字，欄名用 Rust 的 snake_case。 */
export interface CleanupPlan {
  rumble_hz: number;
  denoise_db: number;
  noise_floor_db: number;
  deess_amount: number;
}

/** 本機辨識的可用狀態。 */
export interface LocalAsrStatus {
  python: boolean;
  python_version: string | null;
  faster_whisper: boolean;
  install_hint: string;
}

/** loudnorm 第一趟量到的數字。 */
export interface LoudnormStats {
  input_i: number;
  input_tp: number;
  input_lra: number;
  input_thresh: number;
  target_offset: number;
  output_i: number | null;
  output_tp: number | null;
}

/** 串音衰減（ffmpeg agate 的參數；門檻由該軌自己的能量分布量出來）。 */
export interface RenderGate {
  threshold: number;
  range: number;
  attack_ms: number;
  release_ms: number;
}

/** 疊在主聲軌上的一段音訊（Rust 端逐 frame 混音，包絡與淡入淡出同一套）。 */
export interface RenderOverlay {
  path: string;
  src_start_ms: number;
  src_end_ms: number;
  out_start_ms: number;
  gain_db: number;
  fade_in_ms: number;
  fade_out_ms: number;
  points: { ms: number; db: number }[];
  lane: string;
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
  /** 這一趟量到的響度（分軌輸出要沿用同一組）。 */
  measured?: LoudnormStats | null;
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

/** POST /v1/gpu/release 的結果。 */
export interface GpuRelease {
  ok: boolean;
  before_free_mb: number;
  after_free_mb: number;
  freed_mb: number;
}

/** ACE-Step 音樂生成送單參數（對齊伺服器 MusicRequest）。 */
export interface MusicOpts {
  prompt: string;
  duration_sec: number;
  /** 0 = 不指定。 */
  bpm: number;
  /** fast | fine | max；空字串 = 伺服器預設。 */
  quality: string;
  n_candidates: number;
  format: string;
  /** -1 = 隨機。 */
  seed: number;
}

/** 曲風轉換送單參數（POST /v1/music/style，audio2audio）。 */
export interface MusicStyleOpts {
  prompt: string;
  /** 參考音檔路徑（通常是選取範圍切出來的 wav）。 */
  audio_path: string;
  /** 0–1，越高越貼近原曲。 */
  cover_strength: number;
  /** 0 = 跟隨參考長度。 */
  duration_sec: number;
  n_candidates: number;
  format: string;
  seed: number;
}

export interface MusicJobInfo {
  job_id: string;
  kind: string;
  status: "queued" | "running" | "post" | "done" | "failed" | "cancelled";
  error: string | null;
  audio_format: string | null;
  outputs: { index: number; audio_url: string; seed?: number; audio_format?: string }[];
  seed: number | null;
  waiting_sec: number;
  running_sec: number | null;
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
  /** 把 [startMs, endMs] 切成 wav（曲風轉換的參考片段）；回輸出路徑。 */
  /** 多支麥克風對齊後併成一軌（delaysMs 都必須 ≥ 0；adelay 只能往後推）。gates 為每軌的串音衰減（null = 不處理）。 */
  mediaCombine: (srcs: string[], delaysMs: number[], outPath: string, gates?: (RenderGate | null)[]) =>
    invoke<string>("media_combine", { srcs, delaysMs, outPath, gates: gates ?? null }),
  mediaClip: (path: string, fingerprint: string, startMs: number, endMs: number) =>
    invoke<string>("media_clip", { path, fingerprint, startMs, endMs }),
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
  /** ACE-Step 配樂：送單 → 輪詢 → 下載候選（非同步，30 秒～數分鐘）。 */
  /** 顯存不夠時請伺服器讓位（預設停掉音樂服務）。 */
  ttlsGpuRelease: (musicAction: "stop" | "none" = "stop") => invoke<GpuRelease>("ttls_gpu_release", { musicAction }),
  ttlsMusicStart: (opts: MusicOpts) => invoke<string>("ttls_music_start", { opts }),
  ttlsMusicStyleStart: (opts: MusicStyleOpts) => invoke<string>("ttls_music_style_start", { opts }),
  ttlsMusicPoll: (jobId: string) => invoke<MusicJobInfo>("ttls_music_poll", { jobId }),
  ttlsMusicFetch: (jobId: string, index: number, outDir: string, fileStem: string, ext: string) =>
    invoke<string>("ttls_music_fetch", { jobId, index, outDir, fileStem, ext }),
  ttlsMusicCancel: (jobId: string) => invoke<void>("ttls_music_cancel", { jobId }),
  renderStart: (jobId: string, src: string, plan: RenderPlan) => invoke<void>("render_start", { jobId, src, plan }),
  renderCancel: (jobId: string) => invoke<void>("render_cancel", { jobId }),
  projectSave: (path: string, doc: unknown) => invoke<void>("project_save", { path, doc }),
  /** 寫純文字檔（節目筆記的 .md）。不加 BOM。 */
  writeTextFile: (path: string, content: string) => invoke<void>("write_text_file", { path, content }),
  projectLoad: (path: string) => invoke<unknown>("project_load", { path }),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  openExternal: (url: string) => invoke<void>("open_external", { url }),
  claudeDetect: () => invoke<ClaudeStatus>("claude_detect"),
  codexDetect: () => invoke<ClaudeStatus>("codex_detect"),
  localAsrDetect: () => invoke<LocalAsrStatus>("local_asr_detect"),
  /** 本機 faster-whisper 轉寫；回傳與 ttls 相同形狀的逐字稿。 */
  localAsrTranscribe: (jobId: string, audioPath: string, model: string, language: string) =>
    invoke<unknown>("local_asr_transcribe", { jobId, audioPath, model, language }),
  claudeSend: (reqId: string, prompt: string, sessionId: string | null, model: string | null, mode: "agent" | "advise", systemPrompt: string | null) =>
    invoke<void>("claude_send", { reqId, prompt, sessionId, model, mode, systemPrompt }),
  claudeCancel: (reqId: string) => invoke<void>("claude_cancel", { reqId }),
  /**
   * 結構化產出。`backend` 給 "codex" 就走 codex CLI，其餘一律 claude。
   * 助手的工具迴圈沒有這個開關 —— codex 要連我們的 MCP server 得靠使用者自己的
   * config.toml，App 寫不進去，所以助手仍然只走 claude。
   */
  claudeStructured: (prompt: string, schema: unknown, model: string | null, systemPrompt: string | null, timeoutMs?: number, backend?: string | null) =>
    invoke<unknown>("claude_structured", { prompt, schema, model, systemPrompt, timeoutMs: timeoutMs ?? null, backend: backend ?? null }),
  mcpSetTools: (tools: McpToolDef[]) => invoke<number>("mcp_set_tools", { tools }),
  mcpToolResult: (id: string, result: unknown, error: string | null) => invoke<boolean>("mcp_tool_result", { id, result, error }),
  mcpInfo: () => invoke<McpInfo>("mcp_info"),
};
