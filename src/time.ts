/** 毫秒 → "m:ss.mmm"（>1h 則 "h:mm:ss.mmm"）。 */
export function formatMs(ms: number, opts: { millis?: boolean } = {}): string {
  const millis = opts.millis ?? true;
  const total = Math.max(0, Math.floor(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const frac = total % 1000;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const base = `${h > 0 ? `${h}:` : ""}${mm}:${String(s).padStart(2, "0")}`;
  return millis ? `${base}.${String(frac).padStart(3, "0")}` : base;
}

/** 毫秒 → 簡短時長（"12:34" / "1:02:03"）。 */
export function formatDuration(ms: number): string {
  return formatMs(ms, { millis: false });
}

/** 秒（小數）→ "1.8 秒" 之類的短字串。 */
export function formatSec(ms: number): string {
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} 秒`;
}
