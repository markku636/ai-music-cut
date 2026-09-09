import { invoke } from "@tauri-apps/api/core";
import type { RenderFxRegion, RenderRangeFx } from "./analysis/fx/regions";
import type { RenderFormat } from "./analysis/formats";

// 單一 Rust 邊界：所有 invoke 集中在此，型別對齊 src-tauri（snake_case 欄位照 Rust struct）。

export interface AppSettings {
  ffmpeg_path: string | null;
  claude_model: string;
  /** 結構化產出的 CLI："claude" 或 "codex"。 */
  agent_backend: string;
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
  /** 使用者另存的輸出預設（內建的不存，見 analysis/exportPresets.ts）。 */
  export_presets: { id: string; label: string; format: string; target_lufs: number; leveling: boolean; stems: boolean }[];
  /** 專案範本（JSON 字串；形狀由 analysis/template.ts 定義）。 */
  project_templates: string[];
  /** 使用者親手做過的贅字裁決，一集一筆 JSON（形狀由 analysis/fillerLearn.ts 定義）。 */
  filler_observations: string[];
  /** 按過「不要」的詞表建議（norm）。不存的話下次打開又會跳出同一條。 */
  filler_dismissed: string[];
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

/** 轉寫工作的狀態快照。 */
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
  kind: "mute" | "gain" | "fade_in" | "fade_out" | "invert";
  start_ms: number;
  end_ms: number;
  db: number;
  /** fade 的曲線；省略 = linear。 */
  shape?: "linear" | "equal_power" | "exponential";
}
export interface RenderPlan {
  segs: RenderSeg[];
  effects: RenderEffect[];
  joins: RenderJoin[];
  crossfade_ms: number;
  target_lufs: number;
  true_peak_dbtp: number;
  format: RenderFormat;
  /** 無損格式的位元深度（0 / 省略 = 16）。 */
  bit_depth?: number;
  out_path: string;
  channels: number;
  /**
   * 範圍濾波（降噪 / 去爆音…）：**成品時間**的區域，剪好之後 Rust 另跑一趟 punch-in（fx.rs）。
   * 由 analysis/fx/regions.ts 從來源時間的效果換算；型別化 enum，數字在 Rust clamp。
   */
  fx_regions?: RenderFxRegion[];
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
  /**
   * 保留動態：寧可小聲也不要被動態壓縮。
   * 開了就把目標降到「純增益拉得到」的位置，loudnorm 才會留在 linear。
   */
  preserve_dynamics?: boolean;
}

/** 與 `analysis/cleanup.ts` 的 CleanupSpec 同一組數字，欄名用 Rust 的 snake_case。 */
export interface CleanupPlan {
  rumble_hz: number;
  denoise_db: number;
  noise_floor_db: number;
  deess_amount: number;
}

/** 本機辨識的可用狀態。 */
/** `local-asr-install` 事件：安裝過程逐行回報。 */
export interface LocalAsrInstallEvent {
  job_id: string;
  /** "step"（換一個階段）| "line"（一行輸出）| "done" */
  kind: "step" | "line" | "done";
  /** kind==="step" 時："package" | "model" */
  step?: string;
  line?: string;
  ok?: boolean;
  code?: number;
}

/** 一個本機辨識模型的規格（Rust 的 local_asr::ModelSpec）。 */
export interface AsrModelSpec {
  name: string;
  /** 下載大小（估計），例如 "~3 GB"。 */
  download: string;
  /** 參數量（百萬）。 */
  params_m: number;
  /** int8 跑在 GPU 上大約要多少顯存（MB，估計）。App 就是用 int8 跑的。 */
  vram_int8_mb: number;
  /** 退回 CPU 時大約要多少記憶體（MB，估計）。 */
  ram_int8_mb: number;
  /** 相對速度，以 large-v3 為 1（粗估）。 */
  speed_x: number;
}

export interface AsrGpuInfo {
  name: string;
  vram_mb: number;
}

/** 這台機器的顯示卡。只問 nvidia-smi —— faster-whisper 走 CUDA。 */
export interface AsrHardware {
  nvidia: boolean;
  gpus: AsrGpuInfo[];
}

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
  /**
   * `linear` 或 `dynamic`。我們送 linear=true 只是請求 —— 需要的增益會讓峰值超過上限時
   * ffmpeg 會自己退回 dynamic（動態壓縮），成品的動態會被壓掉。
   */
  normalization_type?: string | null;
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
  stage: "cut" | "fx" | "measure" | "encode";
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
  /** 沒帶進成品的東西（flac 不能寫章節…）。 */
  dropped?: string[];
}

export interface ConvertSpec {
  src: string;
  out_path: string;
  format: RenderFormat;
  sample_rate: number;
  channels: number;
  bit_depth: number;
  target_lufs: number | null;
  true_peak_dbtp: number;
  copy_if_possible: boolean;
}
export interface ConvertDone {
  out_path: string;
  copied: boolean;
  input_lufs: number | null;
  output_lufs: number | null;
  dropped: string[];
  elapsed_ms: number;
}
export interface MergeSpec {
  inputs: { path: string; gain_db: number }[];
  join: "gap" | "crossfade";
  join_ms: number;
  channels: number;
  out_path: string;
}
export interface MergeDone {
  out_path: string;
  elapsed_ms: number;
}
export interface AlignSpec {
  src: string;
  out_path: string;
  /** dub 相對 guide 的位移（正 = 前面補靜音；負 = 砍掉開頭）。 */
  offset_ms: number;
  segments: { dub_start_ms: number; tempo: number }[];
  channels: number;
}
export interface AlignDone {
  out_path: string;
  elapsed_ms: number;
}

/** 分離出來的各軌。 */
/** 本機 demucs 的就緒狀態。 */
export interface LocalSeparateStatus {
  python: boolean;
  python_version: string | null;
  demucs: boolean;
  install_hint: string;
}

/** 分離過程的事件（Rust 從 demucs 的 stderr 轉出來）。 */
export interface LocalSeparateEvent {
  job_id: string;
  event: "status" | "progress" | "line" | "done";
  message?: string;
  pct?: number;
}

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
  /** 本機分離（demucs）：python 與套件就緒了嗎。 */
  localSeparateDetect: () => invoke<LocalSeparateStatus>("local_separate_detect"),
  localSeparateInstallCommand: () => invoke<string[]>("local_separate_install_command"),
  localSeparateInstall: (jobId: string) => invoke<boolean>("local_separate_install", { jobId }),
  /** 去人聲 / 分軌（本機 demucs；用 mediaCancel(jobId) 放棄）。stems："2" 或 "4"。 */
  localSeparateRun: (jobId: string, path: string, stems: string, outDir: string | null) =>
    invoke<SeparateStem[]>("local_separate_run", { jobId, path, stems, outDir }),
  renderStart: (jobId: string, src: string, plan: RenderPlan) => invoke<void>("render_start", { jobId, src, plan }),
  /** 範圍濾波的 A/B 試聽：對來源檔切一段，dry / wet 各一份 mp3（快取在媒體目錄的 fx/）。 */
  fxPreview: (path: string, fingerprint: string, startMs: number, endMs: number, chain: RenderRangeFx[], key: string) =>
    invoke<{ dry: string; wet: string }>("fx_preview", { path, fingerprint, startMs, endMs, chain, key }),
  /** 頻譜圖 PNG（showspectrumpic），畫面看哪一段要哪一段；回快取路徑。 */
  mediaSpectrogram: (path: string, fingerprint: string, startMs: number, endMs: number, w: number, h: number, palette: string) =>
    invoke<string>("media_spectrogram", { path, fingerprint, startMs, endMs, w, h, palette }),
  /** 一段的平均功率譜（dB / bin）：嗡聲偵測用。 */
  mediaSpectrum: (path: string, startMs: number, endMs: number, n = 8192) =>
    invoke<{ sample_rate: number; n: number; db: number[]; frames: number }>("media_spectrum", { path, startMs, endMs, n }),
  /** 轉檔一個檔（格式 / 取樣率 / 聲道 / 位元深度 / 正規化；能複製就不重編）。 */
  convertFile: (spec: ConvertSpec) => invoke<ConvertDone>("convert_file", { spec }),
  /** 幾個檔接成一個 48k 24-bit wav。 */
  mergeFiles: (spec: MergeSpec) => invoke<MergeDone>("merge_files", { spec }),
  /** 時間對齊：dub 依分段速率（asendcmd 驅動的 atempo）扭到 guide 時間軸。 */
  alignRender: (spec: AlignSpec) => invoke<AlignDone>("align_render", { spec }),
  /** 對齊試聽：guide + 另一軌同一段（sum / split），回 mp3 路徑。 */
  alignPreview: (guide: string, other: string, fingerprint: string, startMs: number, durMs: number, split: boolean, key: string) =>
    invoke<string>("align_preview", { guide, other, fingerprint, startMs, durMs, split, key }),
  renderCancel: (jobId: string) => invoke<void>("render_cancel", { jobId }),
  projectSave: (path: string, doc: unknown) => invoke<void>("project_save", { path, doc }),
  /** 寫純文字檔（節目筆記的 .md）。不加 BOM。 */
  writeTextFile: (path: string, content: string) => invoke<void>("write_text_file", { path, content }),
  projectLoad: (path: string) => invoke<unknown>("project_load", { path }),
  /** 一批路徑存不存在（轉檔輸出 / 錄音 take 撞名用）。後端指令 paths_exist；還沒有時呼叫端要自己退回。 */
  pathsExist: (paths: string[]) => invoke<boolean[]>("paths_exist", { paths }),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  openExternal: (url: string) => invoke<void>("open_external", { url }),
  claudeDetect: () => invoke<ClaudeStatus>("claude_detect"),
  codexDetect: () => invoke<ClaudeStatus>("codex_detect"),
  localAsrDetect: () => invoke<LocalAsrStatus>("local_asr_detect"),
  /** 可以選的模型與規格（下載大小、參數量、顯存 / 記憶體估計、相對速度）。 */
  localAsrModels: () => invoke<AsrModelSpec[]>("local_asr_models"),
  /** 這台機器的顯示卡與顯存（沒有 NVIDIA 卡時 nvidia = false）。 */
  localAsrHardware: () => invoke<AsrHardware>("local_asr_hardware"),
  /** 安裝套件那一步實際會執行的參數（畫面上先給人看過再按）。 */
  localAsrInstallCommand: () => invoke<string[]>("local_asr_install_command"),
  /** 依使用者勾的項目安裝；輸出走 `local-asr-install` 事件。 */
  localAsrInstall: (jobId: string, pkg: boolean, model: string | null) =>
    invoke<boolean>("local_asr_install", { jobId, package: pkg, model }),
  /** 本機 faster-whisper 轉寫。 */
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
