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

export const api = {
  showMainWindow: () => invoke<void>("show_main_window"),
  settingsGet: () => invoke<AppSettings>("settings_get"),
  settingsSet: (settings: AppSettings) => invoke<AppSettings>("settings_set", { settings }),
  appPaths: () => invoke<AppPaths>("app_paths"),
  ffmpegDetect: (custom?: string | null) => invoke<FfmpegStatus>("ffmpeg_detect", { custom: custom ?? null }),
  mediaProbe: (path: string) => invoke<MediaProbe>("media_probe", { path }),
  mediaFingerprint: (path: string) => invoke<string>("media_fingerprint", { path }),
  ttlsHealth: () => invoke<TtlsHealth>("ttls_health"),
  ttlsKeyStatus: () => invoke<KeyStatus>("ttls_key_status"),
  ttlsKeySet: (key: string) => invoke<KeyStatus>("ttls_key_set", { key }),
  ttlsKeyClear: () => invoke<KeyStatus>("ttls_key_clear"),
  ttlsKeyVerify: () => invoke<boolean>("ttls_key_verify"),
  projectSave: (path: string, doc: unknown) => invoke<void>("project_save", { path, doc }),
  projectLoad: (path: string) => invoke<unknown>("project_load", { path }),
  openPath: (path: string) => invoke<void>("open_path", { path }),
  openExternal: (url: string) => invoke<void>("open_external", { url }),
};
