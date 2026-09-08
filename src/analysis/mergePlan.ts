// 合併檔案的純決策：總長、對齊響度的增益。Rust merge.rs 只負責組 filter graph 與跑 ffmpeg。
import { effectiveXfMs } from "./edl/joins";

export type MergeJoin = "gap" | "crossfade";

export interface MergeItem {
  id: string;
  path: string;
  name: string;
  durationMs: number;
  /** 量到的整體響度（LUFS）；沒分析就 null。 */
  lufs: number | null;
  gainDb: number;
  /** probe 到的聲道數；不知道就 undefined（當 1）。 */
  channels?: number;
}

/**
 * 交越實際能用的長度：不能超過**最短檔的一半**。Rust 的 acrossfade 不會自己夾，
 * 交越比檔還長時那個檔會被整個吃掉 —— 所以夾在這裡，送去 Rust 的 join_ms 就是這個值。
 */
export function effectiveJoinMs(items: readonly { durationMs: number }[], join: MergeJoin, joinMs: number): number {
  const j = Math.max(0, Math.round(joinMs));
  if (join !== "crossfade" || items.length < 2) return j;
  const shortest = Math.min(...items.map((i) => Math.max(0, i.durationMs)));
  return Math.max(0, Math.min(j, Math.floor(shortest / 2)));
}

/** 輸出聲道：auto = 輸入裡最多的那個（有立體聲就立體聲）。 */
export type MergeChannelChoice = "auto" | "1" | "2";
export function mergeChannels(items: readonly { channels?: number }[], choice: MergeChannelChoice): 1 | 2 {
  if (choice !== "auto") return choice === "2" ? 2 : 1;
  return items.some((i) => (i.channels ?? 1) >= 2) ? 2 : 1;
}

/**
 * 合併後總長：gap 加 (N−1)·gap；crossfade 減 (N−1)·實際交越 ——
 * 交越用與 EDL 同一條夾限（不超過兩邊各一半），所以很短的檔不會被吃光。
 */
export function mergeTotalMs(items: readonly { durationMs: number }[], join: MergeJoin, joinMs: number): number {
  let total = items.reduce((a, b) => a + Math.max(0, b.durationMs), 0);
  for (let i = 0; i + 1 < items.length; i++) {
    if (join === "gap") total += Math.max(0, joinMs);
    else total -= effectiveXfMs(joinMs, items[i].durationMs, items[i + 1].durationMs);
  }
  return Math.max(0, total);
}

/** 把每個檔拉到同一響度：以量得到的檔的平均為基準，差多少補多少（±12 dB 夾住）；量不到的補 0。 */
export function normalizeGains(items: readonly MergeItem[]): number[] {
  const known = items.filter((i) => i.lufs != null && Number.isFinite(i.lufs));
  if (known.length < 2) return items.map(() => 0);
  const ref = known.reduce((a, b) => a + (b.lufs as number), 0) / known.length;
  return items.map((i) => (i.lufs == null || !Number.isFinite(i.lufs) ? 0 : Math.max(-12, Math.min(12, Math.round((ref - i.lufs) * 10) / 10))));
}

/** 預設輸出：第一個檔旁邊的 `<第一個檔名>_merged.wav`。 */
export function mergeOutPath(firstPath: string): string {
  const sep = firstPath.includes("\\") ? "\\" : "/";
  const dir = firstPath.slice(0, firstPath.lastIndexOf(sep) + 1);
  const base = firstPath.slice(dir.length).replace(/\.[^.]+$/, "");
  return `${dir}${base}_merged.wav`;
}

/** 上下移動一項。 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length || to < 0 || to >= out.length) return out;
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}
