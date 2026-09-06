// 章節標記 → 成品檔案裡的章節（ID3 CHAP / QuickTime chapters）。
//
// 三件事很容易做錯，所以整理成一支純函式：
//
// 1. **時間要換算。** 標記是釘在「來源」上的，但章節寫進的是**剪完的成品**。
//    中間剪掉了多少，章節就要往前移多少 —— 直接把來源時間寫進去，剪愈多錯愈遠。
// 2. **落在剪掉的地方要有交代。** 標記所在的那一段被剪掉了，它就沒有對應的成品時間；
//    往後挪到下一段保留段的開頭，比默默丟掉合理（使用者標的是「這裡開始講新主題」）。
// 3. **章節必須連續且不重疊。** ffmpeg 的 ffmetadata 要求 START < END，播放器對
//    重疊或倒退的章節反應從「忽略」到「整份 metadata 不讀」都有。所以排序、去重、
//    首章補到 0、末章補到成品結尾，中間一章接一章。
import type { Edl } from "./edl/build";
import { mapSrcToOut } from "./edl/map";
import type { Marker } from "./types";

export interface Chapter {
  startMs: number;
  endMs: number;
  title: string;
}

/** 章節標題上限。太長的標題在 Apple Podcasts 會被截掉，不如自己截得漂亮一點。 */
export const MAX_CHAPTER_TITLE = 60;

/** 兩個章節至少要差這麼多，否則視為同一個點（播放器對零長度章節的處理不一致）。 */
export const MIN_CHAPTER_MS = 1000;

export function sanitizeTitle(s: string): string {
  // ffmetadata 用 = ; # \ 當跳脫字元；換行會直接切斷 key=value
  const one = s.replace(/[\r\n]+/g, " ").trim();
  return one.length > MAX_CHAPTER_TITLE ? one.slice(0, MAX_CHAPTER_TITLE - 1) + "…" : one;
}

export interface BuildChaptersOptions {
  /** 成品總長（ms）。末章的 END。 */
  outDurationMs: number;
  /** 沒有標題的章節要叫什麼（會補上序號）。 */
  fallbackTitle?: string;
}

/**
 * 章節標記 → 章節清單（成品時間軸）。
 *
 * 只吃 kind = "chapter" 的標記；edl 為 null 時視為沒有剪過（來源時間＝成品時間）。
 */
export function buildChapters(markers: Marker[], edl: Edl | null, opts: BuildChaptersOptions): Chapter[] {
  const dur = Math.max(0, opts.outDurationMs);
  if (dur <= 0) return [];
  const fallback = opts.fallbackTitle ?? "章節";

  const points: { ms: number; title: string }[] = [];
  for (const m of markers) {
    if (m.kind !== "chapter") continue;
    // mapSrcToOut 吃的是 keeps 不是 edl，而且 snap="next" 已經處理「標記落在剪掉的區間」
    const outMs = edl ? mapSrcToOut(edl.keeps, m.ms, "next") : m.ms;
    if (outMs == null) continue;
    if (outMs > dur) continue;
    points.push({ ms: Math.max(0, Math.round(outMs)), title: sanitizeTitle(m.title) });
  }
  if (!points.length) return [];

  points.sort((a, b) => a.ms - b.ms);

  // 去重：靠太近的併成一個（保留第一個有標題的）
  const merged: { ms: number; title: string }[] = [];
  for (const p of points) {
    const last = merged[merged.length - 1];
    if (last && p.ms - last.ms < MIN_CHAPTER_MS) {
      if (!last.title && p.title) last.title = p.title;
      continue;
    }
    merged.push({ ...p });
  }

  // 第一章一定從 0 開始 —— 播放器普遍假設章節覆蓋整個檔案，
  // 從 0 到第一個標記之間沒有章節的話，那一段的章節顯示是空的。
  if (merged[0].ms > 0) merged.unshift({ ms: 0, title: "" });

  const out: Chapter[] = [];
  for (let i = 0; i < merged.length; i++) {
    const startMs = merged[i].ms;
    const endMs = i + 1 < merged.length ? merged[i + 1].ms : dur;
    if (endMs - startMs < 1) continue;
    out.push({ startMs, endMs, title: merged[i].title || `${fallback} ${out.length + 1}` });
  }
  return out;
}

/**
 * ffmetadata 文字（`ffmpeg -i meta.txt -map_metadata 1`）。
 * TIMEBASE=1/1000 讓 START / END 直接用毫秒，不必再換算成 sample。
 */
export function toFfmetadata(chapters: Chapter[]): string {
  const lines = [";FFMETADATA1"];
  for (const c of chapters) {
    lines.push("", "[CHAPTER]", "TIMEBASE=1/1000", `START=${Math.round(c.startMs)}`, `END=${Math.round(c.endMs)}`, `title=${escapeMeta(c.title)}`);
  }
  return lines.join("\n") + "\n";
}

function escapeMeta(s: string): string {
  return s.replace(/([=;#\\])/g, "\\$1");
}
