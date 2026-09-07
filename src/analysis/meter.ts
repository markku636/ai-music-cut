// 即時響度表（Audition / Reaper 那條一直在跳的 LUFS 表）。
//
// 響度目前只有兩個時機看得到：輸出後的驗收，以及逐段平衡的增益規劃表。剪的當下
// 完全看不到 —— 「這一段是不是太小聲」只能憑耳朵，而耳朵會被系統音量騙。
//
// 資料本來就有：分析時每 100 ms 就算了 momentary / short-term LUFS 與 RMS，
// 只是沒有人把它畫在播放線上。這一支就是把它讀出來並判斷「離目標多遠」。
//
// **這是監看不是驗收**：讀的是**來源**的響度，不是成品的。成品還會經過逐段平衡、
// loudnorm 兩趟與限幅器 —— 那個數字要等輸出後的驗收。UI 上要講清楚，
// 不然使用者會拿這個數字去對交件規範。

import type { LocalAnalysis } from "./peaks";

/** LUFS 的無聲下限。ffmpeg 對全靜音會回 -inf / -70 以下，畫面上一律當「靜音」。 */
export const SILENCE_LUFS = -70;

export interface MeterReading {
  /** 400 ms 窗（跳得快，看瞬間）。 */
  momentary: number;
  /** 3 s 窗（穩，看段落）。 */
  shortTerm: number;
  rmsDb: number;
  /** 這個時間點沒有資料（還沒分析 / 超出範圍）。 */
  silent: boolean;
}

const EMPTY: MeterReading = { momentary: SILENCE_LUFS, shortTerm: SILENCE_LUFS, rmsDb: -120, silent: true };

/** 讀某個時間點的響度。超出範圍回「靜音」而不是丟例外 —— 播放線會跑到結尾之外。 */
export function meterAt(a: LocalAnalysis | null | undefined, ms: number): MeterReading {
  if (!a || a.nWin === 0 || ms < 0) return EMPTY;
  const i = Math.min(a.nWin - 1, Math.floor(ms / a.hopMs));
  if (i < 0) return EMPTY;
  const momentary = a.win[i * 3];
  const shortTerm = a.win[i * 3 + 1];
  const rmsDb = a.win[i * 3 + 2];
  const silent = !Number.isFinite(momentary) || momentary <= SILENCE_LUFS;
  return { momentary: silent ? SILENCE_LUFS : momentary, shortTerm: Number.isFinite(shortTerm) ? shortTerm : SILENCE_LUFS, rmsDb, silent };
}

export type MeterVerdict = "silent" | "quiet" | "ok" | "loud";

/**
 * short-term 離目標多遠。
 *
 * 用 short-term（3 秒）不用 momentary：momentary 每 100 ms 就跳好幾 dB，
 * 拿它判斷「這一段夠不夠大聲」會一直在紅黃綠之間閃，看了反而更不知道。
 */
export function verdict(r: MeterReading, targetLufs: number, tolerance = 3): MeterVerdict {
  if (r.silent) return "silent";
  const d = r.shortTerm - targetLufs;
  if (d < -tolerance) return "quiet";
  if (d > tolerance) return "loud";
  return "ok";
}

/** 一段範圍的平均（能量平均，不是 dB 直接平均 —— 後者會被安靜的部分拉低太多）。 */
export function meanLufs(a: LocalAnalysis | null | undefined, fromMs: number, toMs: number): number {
  if (!a || a.nWin === 0 || toMs <= fromMs) return SILENCE_LUFS;
  const lo = Math.max(0, Math.floor(fromMs / a.hopMs));
  const hi = Math.min(a.nWin - 1, Math.floor(toMs / a.hopMs));
  let sum = 0;
  let n = 0;
  for (let i = lo; i <= hi; i++) {
    const v = a.win[i * 3];
    if (!Number.isFinite(v) || v <= SILENCE_LUFS) continue;
    sum += Math.pow(10, v / 10);
    n++;
  }
  return n === 0 ? SILENCE_LUFS : 10 * Math.log10(sum / n);
}

/** 給表格 / 條狀圖用：把 LUFS 映到 0–1（−40 LUFS 以下都當 0）。 */
export function meterFraction(lufs: number, floor = -40, ceil = -5): number {
  if (!Number.isFinite(lufs) || lufs <= floor) return 0;
  return Math.min(1, Math.max(0, (lufs - floor) / (ceil - floor)));
}
