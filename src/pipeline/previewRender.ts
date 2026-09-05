// 「剪後（成品）」預覽：用跟正式輸出**完全一樣**的剪接器渲染一份，只是跳過響度正規化。
//
// 為什麼需要這個：跳播預覽是「即時近似」—— 它只是在播放時跳過剪除區，沒有 crossfade、
// 沒有 room tone、沒有結尾淡出。使用者聽起來覺得順，不代表成品也順；
// 接點的爆音只有真的渲染過才聽得到。
//
// 快取鍵取自 plan 的內容雜湊：決策一改鍵就變，畫面自動退回「即時」，
// 而不是播一份過期的檔案。**不會自動重渲染** —— 那要幾十秒，只在按下按鈕時做。
import { api, type RenderPlan } from "../api";
import { useProject } from "../store/project";
import { buildRenderPlan, runRender, type RenderOptions } from "./render";

/** 只取會影響「聽起來如何」的欄位；out_path / format / 響度目標不算。 */
function planFingerprint(plan: RenderPlan): string {
  return JSON.stringify({
    s: plan.segs.map((x) => [Math.round(x.src_start_ms * 100), Math.round(x.src_end_ms * 100), Math.round(x.gain_db * 100)]),
    j: plan.joins.map((x) => [x.kind, Math.round(x.ms * 100)]),
    e: plan.effects.map((x) => [x.kind, Math.round(x.start_ms * 100), Math.round(x.end_ms * 100), Math.round((x.db ?? 0) * 100)]),
    c: plan.channels,
  });
}

/** FNV-1a 32-bit：不需要密碼學強度，只要內容一變鍵就變。 */
function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 這份計畫的預覽檔識別碼。內容一樣就命中同一個檔。 */
export function previewKey(plan: RenderPlan): string {
  return hash32(planFingerprint(plan));
}

function sep(p: string): string {
  return p.includes("\\") ? "\\" : "/";
}

/** 預覽檔放在 App 快取目錄（不是使用者的輸出資料夾 —— 那裡不該堆暫存檔）。 */
export function previewPath(cacheDir: string, fingerprint: string, key: string): string {
  const s = sep(cacheDir);
  return `${cacheDir}${s}preview${s}${(fingerprint || "unknown").slice(0, 16)}${s}preview-${key}.mp3`;
}

export interface PreviewResult {
  path: string;
  key: string;
  /** 是不是直接命中快取（沒有重新渲染）。 */
  cached: boolean;
  durationMs: number | null;
}

/** 預覽用的輸出選項：格式固定 mp3、關掉逐段平衡（那是成品才做的事）。 */
function previewOptions(outPath: string, targetLufs: number): RenderOptions {
  return { format: "mp3", outPath, leveling: false, targetLufs, preview: true };
}

/** 目前決策對應的預覽鍵（不渲染，只算）。畫面用它判斷手上的預覽檔還新不新。 */
export function currentPreviewKey(mediaId: string, targetLufs = -16): string | null {
  const built = buildRenderPlan(mediaId, previewOptions("", targetLufs));
  return built && built.plan.segs.length ? previewKey(built.plan) : null;
}

/**
 * 確保有一份對得上目前決策的預覽檔；已存在就直接回傳（不重跑）。
 * 回傳 null 代表沒有東西可以渲染（還沒探測 / 沒有保留段）。
 */
export async function ensurePreview(mediaId: string, opts: { targetLufs?: number } = {}): Promise<PreviewResult | null> {
  const media = useProject.getState().media.find((m) => m.id === mediaId);
  if (!media) return null;
  const targetLufs = opts.targetLufs ?? -16;
  const probe = buildRenderPlan(mediaId, previewOptions("", targetLufs));
  if (!probe || !probe.plan.segs.length) return null;
  const paths = await api.appPaths();
  const key = previewKey(probe.plan);
  const outPath = previewPath(paths.cache_dir, media.fingerprint || media.id, key);

  const existing = await api.mediaProbe(outPath).catch(() => null);
  if (existing && existing.duration_ms > 0) return { path: outPath, key, cached: true, durationMs: existing.duration_ms };

  // 走跟正式輸出同一條 runRender（進度、取消、錯誤處理都已經有了），只是帶 preview 旗標
  const r = await runRender(mediaId, previewOptions(outPath, targetLufs));
  if (!r.ok) throw new Error(r.error ?? "預覽渲染失敗");
  const p = await api.mediaProbe(outPath).catch(() => null);
  return { path: outPath, key, cached: false, durationMs: p?.duration_ms ?? null };
}
