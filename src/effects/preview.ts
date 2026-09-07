import { api } from "../api";
import { t } from "../i18n";
import { runRender } from "../pipeline/render";
import type { TimeSelection } from "../store/timeline";
import type { EffectApplication } from "./spec";

/** A/B 試聽的長度：夠聽出差別，又不用等太久。 */
export const AB_MS = 8000;

export interface AbPair {
  dry: string;
  wet: string;
}

/** 試聽哪一段：從範圍開頭起最多 AB_MS。 */
export function abWindow(range: TimeSelection): TimeSelection {
  const startMs = Math.max(0, range.startMs);
  return { startMs, endMs: Math.max(startMs + 500, Math.min(range.endMs, startMs + AB_MS)) };
}

/**
 * 預設的 A/B：兩趟都走正式的 runRender（同一個剪接器、同一條濾鏡路徑），
 * 差別只有「有沒有這個效果」。輸出到快取目錄，dry / wet 各一個檔。
 */
export async function renderAbPair(mediaId: string, range: TimeSelection, app: EffectApplication): Promise<AbPair> {
  if (app.kind === "custom") throw new Error(t("這個效果沒有試聽"));
  const paths = await api.appPaths();
  const sep = paths.cache_dir.includes("\\") ? "\\" : "/";
  const dir = `${paths.cache_dir}${sep}effects`;
  const dry = `${dir}${sep}ab-dry.mp3`;
  const wet = `${dir}${sep}ab-wet.mp3`;
  const base = { format: "mp3" as const, leveling: false, targetLufs: -16, preview: true, rangeMs: abWindow(range) };
  const a = await runRender(mediaId, app.kind === "cleanup" ? { ...base, outPath: dry, cleanup: null } : { ...base, outPath: dry });
  if (!a.ok) throw new Error(a.error ?? t("原始試聽渲染失敗"));
  const b = await runRender(mediaId, app.kind === "cleanup" ? { ...base, outPath: wet, cleanup: app.spec } : { ...base, outPath: wet, extraEffects: app.effects });
  if (!b.ok) throw new Error(b.error ?? t("處理後試聽渲染失敗"));
  return { dry, wet };
}
