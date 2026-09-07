// 聲音體檢：逐字稿看不出來的毛病（Audition 的 Diagnostics / Auphonic 的分析那一層）。
//
// 這個 App 的判斷幾乎都建立在**文字**上：哪句是贅字、哪裡重講、章節該切在哪。
// 但把節目搞砸的常常是文字完全看不到的東西 —— 麥克風被撞了一下之後音量差 9 LU、
// 前級開太大整段削波、錄音介面有直流偏移、剪完之後中間留了 12 秒空白。
// 這些東西你要「聽過整集」才會發現，而剪的人通常只跳著聽。
//
// 資料來源是本機分析（peaks.ts 的 LocalAnalysis）：每 5 ms 一個 min/max/RMS 桶、
// 每 100 ms 一個響度視窗。**不需要重新解碼音檔**，開檔時就算好了。
//
// 誠實的界線：mins/maxs 是量化成 i8 的（−127..127），所以只能說「波形打到滿刻度」，
// 不能說「確定削波」—— 真正的削波偵測要看連續同值的取樣點，那個資訊在這裡已經被桶化掉了。
// 所以文案講的是事實（打到頂、連續多久），判斷留給人。
import type { LocalAnalysis } from "./peaks";
import { rmsU8ToDb } from "./peaks";

export type QcKind = "clipping" | "level_jump" | "dc_offset" | "dead_air";

export interface QcFinding {
  kind: QcKind;
  /** 來源時間軸（ms）。 */
  startMs: number;
  endMs: number;
  /**
   * 給人看的量值，各自不同單位：
   * clipping = 連續打頂的毫秒數；level_jump = 前後差幾 LU（正負有意義）；
   * dc_offset = 偏移佔滿刻度的百分比；dead_air = 空白的毫秒數。
   */
  value: number;
}

export interface QcOptions {
  /** 打頂判定：|峰值| ≥ 這個值（i8 滿刻度是 127）。 */
  clipLevel: number;
  /** 連續打頂至少這麼久才回報（單一個桶打到頂太常見，回報只會變成雜訊）。 */
  minClipMs: number;
  /** 前後各一秒的短期響度差超過這麼多 LU 就算突變。 */
  jumpLu: number;
  /** 比較兩側時，低於這個 LUFS 的一側不算（從靜音進到說話當然會跳）。 */
  jumpFloorLufs: number;
  /** 靜音門檻（dBFS）。 */
  silenceDb: number;
  /** 連續這麼久沒有聲音就算空白。 */
  deadAirMs: number;
  /** 直流偏移超過滿刻度的這個比例就回報。 */
  dcRatio: number;
  /** 每一種最多回報幾筆（清單太長沒有人看）。 */
  maxPerKind: number;
}

export const DEFAULT_QC: QcOptions = {
  clipLevel: 127,
  minClipMs: 20,
  jumpLu: 8,
  jumpFloorLufs: -45,
  silenceDb: -50,
  deadAirMs: 4000,
  dcRatio: 0.02,
  maxPerKind: 5,
};

export interface KeepRange {
  startMs: number;
  endMs: number;
}

function bucketMs(a: LocalAnalysis): number {
  return a.pps > 0 ? 1000 / a.pps : 5;
}

/** 這個時間點會留在成品裡嗎（keeps 是 null 代表全部都要看）。 */
function inKeeps(keeps: readonly KeepRange[] | null | undefined, ms: number): boolean {
  if (!keeps) return true;
  for (const k of keeps) if (ms >= k.startMs && ms < k.endMs) return true;
  return false;
}

/** 把連續的 true 收成區間。 */
function runsOf(n: number, at: (i: number) => boolean): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  let start = -1;
  for (let i = 0; i < n; i++) {
    if (at(i)) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      out.push({ from: start, to: i });
      start = -1;
    }
  }
  if (start >= 0) out.push({ from: start, to: n });
  return out;
}

function topBy(list: QcFinding[], n: number): QcFinding[] {
  return [...list].sort((a, b) => Math.abs(b.value) - Math.abs(a.value)).slice(0, Math.max(0, n)).sort((a, b) => a.startMs - b.startMs);
}

/** 波形打到滿刻度，而且連續一段時間。 */
export function findClipping(a: LocalAnalysis, keeps: readonly KeepRange[] | null, opts: QcOptions = DEFAULT_QC): QcFinding[] {
  const bm = bucketMs(a);
  const lvl = Math.max(1, opts.clipLevel);
  const hot = (i: number) => a.maxs[i] >= lvl || a.mins[i] <= -lvl;
  const out: QcFinding[] = [];
  for (const r of runsOf(a.nBuckets, hot)) {
    const startMs = Math.round(r.from * bm);
    const endMs = Math.round(r.to * bm);
    if (endMs - startMs < opts.minClipMs) continue;
    if (!inKeeps(keeps, startMs)) continue;
    out.push({ kind: "clipping", startMs, endMs, value: endMs - startMs });
  }
  return topBy(out, opts.maxPerKind);
}

/**
 * 音量突然變化：麥克風被撞、有人換了位置、後製時某一段被單獨調過。
 *
 * 用短期響度（100 ms 一格）比較前後各一秒的**中位數** —— 用平均的話，
 * 一個爆音就會把整個窗口拉走，變成到處都是假警報。
 */
export function findLevelJumps(a: LocalAnalysis, keeps: readonly KeepRange[] | null, opts: QcOptions = DEFAULT_QC): QcFinding[] {
  const hop = a.hopMs > 0 ? a.hopMs : 100;
  const span = Math.max(1, Math.round(1000 / hop));
  const shortTerm = (w: number) => a.win[w * 3 + 1];
  const median = (from: number, to: number): number | null => {
    const vals: number[] = [];
    for (let w = from; w < to; w++) {
      const v = shortTerm(w);
      if (Number.isFinite(v)) vals.push(v);
    }
    if (!vals.length) return null;
    vals.sort((x, y) => x - y);
    return vals[Math.floor(vals.length / 2)];
  };

  // 1) 哪些視窗的「前後一秒中位數」差超過門檻
  const diffs = new Float64Array(a.nWin);
  const flagged = new Uint8Array(a.nWin);
  for (let w = span; w + span <= a.nWin; w++) {
    const before = median(w - span, w);
    const after = median(w, w + span);
    if (before == null || after == null) continue;
    // 兩側都要有人在講話 —— 從靜音進到說話本來就會跳，那不是毛病
    if (before < opts.jumpFloorLufs || after < opts.jumpFloorLufs) continue;
    const d = after - before;
    diffs[w] = d;
    if (Math.abs(d) >= opts.jumpLu) flagged[w] = 1;
  }

  // 2) 一次跳變會連續好幾格都超過門檻 —— 收成一段，一段只回報一筆
  const out: QcFinding[] = [];
  for (const run of runsOf(a.nWin, (w) => flagged[w] === 1)) {
    // 量值取這一段裡最劇烈的
    let value = 0;
    for (let w = run.from; w < run.to; w++) if (Math.abs(diffs[w]) > Math.abs(value)) value = diffs[w];

    // 3) 位置**不能**直接用第一個超過門檻的視窗。
    //    一秒的中位數在「後半段有六格換了音量」時就會翻過去，所以它會比真正的
    //    落差點早 0.4 秒 —— 使用者點下去會聽到變化之前的那一段，以為報錯了。
    //    在這一段附近找**相鄰視窗落差最大**的那一格，那才是真正的轉折。
    const lo = Math.max(1, run.from - span);
    const hi = Math.min(a.nWin, run.to + span);
    let at = run.from;
    let sharpest = -1;
    for (let w = lo; w < hi; w++) {
      const step = Math.abs(shortTerm(w) - shortTerm(w - 1));
      if (Number.isFinite(step) && step > sharpest) {
        sharpest = step;
        at = w;
      }
    }
    const atMs = at * hop;
    if (!inKeeps(keeps, atMs)) continue;
    // 兩段「超過門檻」的區間可能各自把位置修到同一個轉折上（例如降下去又降一次，
    // 中間短暫回到門檻以下）。同一個時間點只留最劇烈的那一筆，不然報告會出現重複的兩行。
    const same = out.find((f) => f.startMs === atMs);
    if (same) {
      if (Math.abs(value) > Math.abs(same.value)) same.value = Math.round(value * 10) / 10;
      continue;
    }
    out.push({ kind: "level_jump", startMs: atMs, endMs: atMs + hop, value: Math.round(value * 10) / 10 });
  }
  return topBy(out, opts.maxPerKind);
}

/**
 * 直流偏移：波形的中線不在零。
 *
 * 聽不出來，但會吃掉動態餘裕、讓每一個剪接點都爆一下（波形從 +0.05 直接跳到 −0.03），
 * 而且會讓響度量測偏掉。是錄音介面 / 便宜的 USB 麥克風的典型毛病。
 *
 * 只看**有聲音**的桶：靜音段落的中線本來就會被量化雜訊拉來拉去。
 */
export function findDcOffset(a: LocalAnalysis, opts: QcOptions = DEFAULT_QC): QcFinding[] {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.nBuckets; i++) {
    if (rmsU8ToDb(a.rmsU8[i]) < opts.silenceDb) continue;
    sum += (a.maxs[i] + a.mins[i]) / 2;
    n += 1;
  }
  if (n < 20) return [];
  const ratio = sum / n / 127;
  if (Math.abs(ratio) < opts.dcRatio) return [];
  return [{ kind: "dc_offset", startMs: 0, endMs: a.durationMs, value: Math.round(ratio * 1000) / 10 }];
}

/** 成品裡連續好幾秒沒有聲音。keeps 是 null 就整份掃（還沒剪之前看原始錄音）。 */
export function findDeadAir(a: LocalAnalysis, keeps: readonly KeepRange[] | null, opts: QcOptions = DEFAULT_QC): QcFinding[] {
  const bm = bucketMs(a);
  const quiet = (i: number) => rmsU8ToDb(a.rmsU8[i]) < opts.silenceDb && inKeeps(keeps, i * bm);
  const out: QcFinding[] = [];
  for (const r of runsOf(a.nBuckets, quiet)) {
    const startMs = Math.round(r.from * bm);
    const endMs = Math.round(r.to * bm);
    if (endMs - startMs < opts.deadAirMs) continue;
    out.push({ kind: "dead_air", startMs, endMs, value: endMs - startMs });
  }
  return topBy(out, opts.maxPerKind);
}

/** 全部跑一遍。 */
export function scanAudio(a: LocalAnalysis, keeps: readonly KeepRange[] | null = null, opts: QcOptions = DEFAULT_QC): QcFinding[] {
  return [
    ...findClipping(a, keeps, opts),
    ...findLevelJumps(a, keeps, opts),
    ...findDcOffset(a, opts),
    ...findDeadAir(a, keeps, opts),
  ].sort((x, y) => x.startMs - y.startMs);
}

/** 摘要成「幾個削波、最大跳變幾 LU」這種一行講得完的東西，給 preflight 用。 */
export interface QcSummary {
  clipping: number;
  clippingMs: number;
  levelJumps: number;
  maxJumpLu: number;
  dcPercent: number;
  deadAir: number;
  longestDeadAirMs: number;
}

export function summarizeQc(findings: readonly QcFinding[]): QcSummary {
  const of = (k: QcKind) => findings.filter((f) => f.kind === k);
  const clip = of("clipping");
  const jumps = of("level_jump");
  const dead = of("dead_air");
  const dc = of("dc_offset")[0];
  return {
    clipping: clip.length,
    clippingMs: clip.reduce((n, f) => n + f.value, 0),
    levelJumps: jumps.length,
    maxJumpLu: jumps.reduce((n, f) => Math.max(n, Math.abs(f.value)), 0),
    dcPercent: dc ? dc.value : 0,
    deadAir: dead.length,
    longestDeadAirMs: dead.reduce((n, f) => Math.max(n, f.value), 0),
  };
}
