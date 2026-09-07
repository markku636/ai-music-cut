// 專案範本（Hindenburg 的 template / Premiere 的 sequence preset）。
//
// 週更的節目每一集開頭都是同一首開場曲、結尾都是同一首片尾曲、目標響度一樣、
// 修聲設定一樣、激進度一樣。現在每一集都要從頭做一遍 —— 那是純粹的重複勞動。
//
// **範本只存「跨集會重複」的東西**：開場 / 片尾 / 固定音效、輸出目標、修聲、激進度。
// 剪輯決策、候選、逐字稿都不存 —— 那些是這一集的內容，跨集重用毫無意義而且危險。
//
// **片尾曲要錨在結尾，不是絕對時間。** 這是範本唯一真正難的地方：開場曲固定在
// 0 秒沒問題，但片尾曲的位置每一集都不一樣（每集長度不同）。存絕對時間的話，
// 套到比較短的一集就會掉在節目結束之後、比較長的一集就會壓在中間。

import type { CleanupSpec } from "./cleanup";
import type { Overlay, OverlayLane, OverlayPoint } from "./overlays";
import { overlayId } from "./overlays";

/** 這一段要錨在哪裡。 */
export type Anchor = "start" | "end";

export interface TemplateOverlay {
  /** 來源檔的絕對路徑（跨專案要用路徑，mediaId 是專案內的）。 */
  path: string;
  lane: OverlayLane;
  role?: string;
  srcInMs: number;
  srcOutMs: number;
  /**
   * 相對錨點的位移（ms）。
   * `start`：從節目開頭往後；`end`：從節目結尾往前（所以片尾曲用負的長度就會貼齊結尾）。
   */
  anchor: Anchor;
  offsetMs: number;
  gainDb: number;
  fadeInMs: number;
  fadeOutMs: number;
  points?: OverlayPoint[];
}

export interface ProjectTemplate {
  id: string;
  label: string;
  overlays: TemplateOverlay[];
  targetLufs: number;
  aggressiveness: number;
  cleanup?: CleanupSpec | null;
}

/** overlay 的長度。 */
function lengthOf(o: { srcInMs: number; srcOutMs: number }): number {
  return Math.max(0, o.srcOutMs - o.srcInMs);
}

/**
 * 猜這一段該錨在哪裡：**落在節目後半、而且結尾靠近節目結尾**的算片尾。
 *
 * 猜錯的代價不對稱：開場曲被當成片尾曲會整個跑掉，反過來只是位置差一點。
 * 所以門檻抓緊一些 —— 寧可當成開場（絕對位置），那至少是使用者原本放的地方。
 */
export function guessAnchor(o: { outStartMs: number; srcInMs: number; srcOutMs: number }, durationMs: number): Anchor {
  if (durationMs <= 0) return "start";
  const end = o.outStartMs + lengthOf(o);
  const nearEnd = durationMs - end <= Math.max(2000, durationMs * 0.05);
  return o.outStartMs > durationMs / 2 && nearEnd ? "end" : "start";
}

export interface BuildTemplateInput {
  label: string;
  overlays: Overlay[];
  /** mediaId → 絕對路徑。 */
  pathOf: (mediaId: string) => string | null;
  /** 成品長度，用來判斷錨點。 */
  durationMs: number;
  targetLufs: number;
  aggressiveness: number;
  cleanup?: CleanupSpec | null;
}

/** 從目前的專案做一個範本。找不到來源路徑的片段會被跳過（那個檔已經不在清單裡）。 */
export function buildTemplate(input: BuildTemplateInput): ProjectTemplate {
  const overlays: TemplateOverlay[] = [];
  for (const o of input.overlays) {
    const path = input.pathOf(o.mediaId);
    if (!path) continue;
    const anchor = guessAnchor(o, input.durationMs);
    overlays.push({
      path,
      lane: o.lane,
      role: o.role,
      srcInMs: o.srcInMs,
      srcOutMs: o.srcOutMs,
      anchor,
      offsetMs: anchor === "start" ? o.outStartMs : o.outStartMs - input.durationMs,
      gainDb: o.gainDb,
      fadeInMs: o.fadeInMs,
      fadeOutMs: o.fadeOutMs,
      points: o.points?.length ? o.points : undefined,
    });
  }
  return {
    id: templateId(input.label),
    label: input.label.trim(),
    overlays,
    targetLufs: input.targetLufs,
    aggressiveness: input.aggressiveness,
    cleanup: input.cleanup ?? null,
  };
}

export function templateId(label: string): string {
  return label.trim().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").toLowerCase() || "template";
}

export interface ApplyResult {
  overlays: Overlay[];
  /** 找不到來源檔而被跳過的段數。 */
  missing: number;
}

/**
 * 把範本套到一集上。
 *
 * `mediaIdOf` 回 null 代表那個檔案還沒加進媒體清單 —— 跳過並回報數量，
 * 而不是靜靜少一段（使用者會以為範本壞了）。
 *
 * 位置一律夾在 [0, durationMs] 內：片尾曲比節目還長的時候，硬放會產生負的起點。
 */
export function applyTemplate(
  tpl: ProjectTemplate,
  durationMs: number,
  mediaIdOf: (path: string) => string | null,
): ApplyResult {
  const overlays: Overlay[] = [];
  let missing = 0;
  for (const t of tpl.overlays) {
    const mediaId = mediaIdOf(t.path);
    if (!mediaId) {
      missing++;
      continue;
    }
    const raw = t.anchor === "start" ? t.offsetMs : durationMs + t.offsetMs;
    const outStartMs = Math.max(0, Math.min(Math.max(0, durationMs - 1), raw));
    overlays.push({
      id: overlayId(t.lane, outStartMs),
      lane: t.lane,
      role: t.role,
      mediaId,
      srcInMs: t.srcInMs,
      srcOutMs: t.srcOutMs,
      outStartMs,
      gainDb: t.gainDb,
      fadeInMs: t.fadeInMs,
      fadeOutMs: t.fadeOutMs,
      // 閃避的控制點是**針對那一集的人聲**算出來的，換一集就不對了 —— 不帶過去
      points: [],
    });
  }
  return { overlays, missing };
}

/** 讀設定檔時擋掉壞資料。 */
export function parseTemplates(raw: unknown): ProjectTemplate[] {
  if (!Array.isArray(raw)) return [];
  const out: ProjectTemplate[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const t = x as Partial<ProjectTemplate>;
    if (typeof t.id !== "string" || typeof t.label !== "string") continue;
    if (!Array.isArray(t.overlays)) continue;
    const overlays = t.overlays.filter(
      (o): o is TemplateOverlay =>
        !!o && typeof o === "object" && typeof (o as TemplateOverlay).path === "string" && ((o as TemplateOverlay).anchor === "start" || (o as TemplateOverlay).anchor === "end"),
    );
    out.push({
      id: t.id,
      label: t.label,
      overlays,
      targetLufs: typeof t.targetLufs === "number" && Number.isFinite(t.targetLufs) ? t.targetLufs : -16,
      aggressiveness: typeof t.aggressiveness === "number" && Number.isFinite(t.aggressiveness) ? t.aggressiveness : 50,
      cleanup: t.cleanup ?? null,
    });
  }
  return out;
}
