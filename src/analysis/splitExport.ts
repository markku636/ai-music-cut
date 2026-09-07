// 依章節分割輸出（Hindenburg / Audition 的 export ranges as separate files）。
//
// 一次錄三集、把一場長訪談切成上下集、把贊助口播單獨輸出一個檔 —— 這些現在都得
// 手動改「只輸出這一段」的範圍、輸出、改名字、再來一次。章節標記本來就已經標好了，
// 那就是分割點。
//
// **每一段都是完整走一次輸出管線**（逐段平衡、修聲、配樂、響度正規化），不是把成品
// 切開。切成品的話每一段的響度都是照整集算的，單獨聽會偏掉；而且切點會落在樣本中間，
// 接縫的淡入淡出也對不上。
//
// 章節標記存的是**來源時間**，而輸出的 `rangeMs` 要的也是來源時間 —— 這裡不需要換算，
// 但每一段在成品裡有多長就要換算（中間可能剪掉很多）。

import type { Edl } from "./edl/build";
import { mapSrcToOut } from "./edl/map";
import type { Marker } from "./types";

export interface SplitPart {
  /** 1 起算。 */
  index: number;
  title: string;
  /** 來源時間，直接給 render 的 rangeMs。 */
  startMs: number;
  endMs: number;
  /** 這一段在成品裡的長度（中間剪掉的不算）。 */
  outMs: number;
  /** 建議檔名（不含目錄，含副檔名）。 */
  fileName: string;
}

export interface SplitOptions {
  /** 檔名前綴，通常是原始檔名去掉副檔名。 */
  baseName: string;
  ext: string;
  /** 來源總長度（最後一段的結尾）。 */
  durationMs: number;
  /** 第一個章節之前那一段的名字（通常是「開場」）。 */
  leadTitle: string;
  /** 成品短於這麼久的段落丟掉（整段都被剪掉了）。 */
  minOutMs?: number;
}

/** Windows 不接受的字元、路徑分隔符與控制字元。連字號不動 —— 標題裡的連字號是內容。 */
const BAD_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
/** Windows 的保留裝置名（CON、PRN、AUX、NUL、COM1–9、LPT1–9），大小寫不分。 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_STEM = 60;

/**
 * 把章節標題變成安全的檔名片段。
 *
 * 這件事**一定要做**：章節標題是使用者打的，裡面很可能有 `/`、`:`、`?`。
 * 直接拿去當檔名，輕則寫檔失敗，重則寫到別的目錄去。
 */
export function safeFileName(title: string): string {
  let s = title.replace(BAD_CHARS, " ").replace(/\s+/g, " ").trim();
  // 結尾的點與空白在 Windows 上會被悄悄吃掉，兩個檔案就撞名了
  s = s.replace(/[.\s]+$/, "");
  if (s.length > MAX_STEM) s = s.slice(0, MAX_STEM).trim();
  if (!s || RESERVED.test(s)) return "";
  return s;
}

/**
 * 章節標記 → 要輸出的段落。
 *
 * 第一個章節不在 0 的時候會**補一段開頭**：不補的話那段話就這樣不見了，而且是安靜地
 * 不見（使用者要對照時間才發現）。
 */
export function splitByChapters(markers: Marker[], edl: Edl | null, opts: SplitOptions): SplitPart[] {
  const minOut = opts.minOutMs ?? 200;
  const chapters = markers
    .filter((m) => m.kind === "chapter")
    .map((m) => ({ ms: Math.max(0, Math.min(opts.durationMs, m.ms)), title: m.title }))
    .sort((a, b) => a.ms - b.ms);
  if (!chapters.length || opts.durationMs <= 0) return [];

  // 同一個時間點兩個章節：留第一個（後面那個沒有長度）
  const uniq: typeof chapters = [];
  for (const c of chapters) if (!uniq.length || c.ms > uniq[uniq.length - 1].ms) uniq.push(c);

  const bounds: { startMs: number; endMs: number; title: string }[] = [];
  if (uniq[0].ms > 0) bounds.push({ startMs: 0, endMs: uniq[0].ms, title: opts.leadTitle });
  for (let i = 0; i < uniq.length; i++) {
    bounds.push({ startMs: uniq[i].ms, endMs: uniq[i + 1]?.ms ?? opts.durationMs, title: uniq[i].title });
  }

  const used = new Set<string>();
  const out: SplitPart[] = [];
  for (const b of bounds) {
    if (b.endMs <= b.startMs) continue;
    const outMs = edl ? mapSrcToOut(edl.keeps, b.endMs, "prev") - mapSrcToOut(edl.keeps, b.startMs, "next") : b.endMs - b.startMs;
    if (outMs < minOut) continue;
    const index = out.length + 1;
    out.push({ index, title: b.title, startMs: b.startMs, endMs: b.endMs, outMs, fileName: "" });
  }
  // 檔名最後才編：編號要連續，而且要等丟掉太短的之後才知道總共幾段
  return out.map((p) => ({ ...p, fileName: fileNameFor(opts.baseName, p.index, p.title, opts.ext, used) }));
}

/** `原檔名-01-章節標題.mp3`；標題不能用時退回 `原檔名-01.mp3`。撞名的加流水號。 */
export function fileNameFor(baseName: string, index: number, title: string, ext: string, used = new Set<string>()): string {
  const base = safeFileName(baseName) || "output";
  const stem = safeFileName(title);
  const num = String(index).padStart(2, "0");
  let name = stem ? `${base}-${num}-${stem}` : `${base}-${num}`;
  if (used.has(name.toLowerCase())) {
    let n = 2;
    while (used.has(`${name}-${n}`.toLowerCase())) n++;
    name = `${name}-${n}`;
  }
  used.add(name.toLowerCase());
  return `${name}.${ext}`;
}

/** 全部段落加起來的成品長度。 */
export function totalOutMs(parts: SplitPart[]): number {
  return parts.reduce((a, p) => a + p.outMs, 0);
}
