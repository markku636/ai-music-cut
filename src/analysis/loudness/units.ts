// 響度平衡單元：每個保留段在 VAD 靜音處再切成 ≤ maxUnitMs 的小段，各自量測 / 套增益。單元不跨保留段。
import type { KeepSegment } from "../edl/build";
import type { VadRegion } from "../types";

export interface Unit {
  id: number;
  keepId: number;
  startMs: number;
  endMs: number;
}

/** 保留段內的 VAD 靜音（≥ minSilenceMs）中點，供切割。 */
function silencePoints(vad: VadRegion[], fromMs: number, toMs: number, minSilenceMs: number): number[] {
  const pts: number[] = [];
  let prevEnd = fromMs;
  for (const r of vad) {
    if (r.endMs <= fromMs) continue;
    if (r.startMs >= toMs) break;
    const s = Math.max(fromMs, prevEnd);
    const e = Math.min(toMs, r.startMs);
    if (e - s >= minSilenceMs) pts.push((s + e) / 2);
    prevEnd = Math.max(prevEnd, r.endMs);
  }
  if (toMs - prevEnd >= minSilenceMs && prevEnd > fromMs) pts.push((prevEnd + toMs) / 2);
  return pts;
}

/**
 * 保留段內切成響度單元。
 *
 * `minUnitMs` 是給接點協定用的：輸出計畫送進 Rust 的是「單元」不是「保留段」，
 * 保留段邊界的 crossfade 會被夾在相鄰**單元**長度的一半以內（見 edl/joins.ts）。
 * 單元比 2×crossfade 還短時，實際交叉會被悄悄縮短，EDL 算的長度也就對不上成品。
 * 所以切完之後把過短的單元併回鄰居（同一保留段內；保留段本身太短就整段當一個單元）。
 */
export function splitUnits(keeps: KeepSegment[], vad: VadRegion[], maxUnitMs = 15_000, minSilenceMs = 150, minUnitMs = 200): Unit[] {
  const out: Unit[] = [];
  for (const k of keeps) {
    const spans: { start: number; end: number }[] = [];
    let cur = k.srcStartMs;
    const pts = silencePoints(vad, k.srcStartMs, k.srcEndMs, minSilenceMs);
    let pi = 0;
    while (k.srcEndMs - cur > maxUnitMs) {
      // 找 cur+maxUnit 之前最後一個靜音點；沒有就硬切
      let cut = -1;
      while (pi < pts.length && pts[pi] <= cur + maxUnitMs) {
        if (pts[pi] > cur + 1000) cut = pts[pi];
        pi += 1;
      }
      if (cut < 0) cut = cur + maxUnitMs;
      spans.push({ start: cur, end: cut });
      cur = cut;
    }
    if (k.srcEndMs > cur) spans.push({ start: cur, end: k.srcEndMs });
    if (!spans.length) continue;
    // 過短的單元併回鄰居（往前併；第一個就往後併）
    for (let i = 0; i < spans.length; ) {
      if (spans.length === 1 || spans[i].end - spans[i].start >= minUnitMs) {
        i += 1;
        continue;
      }
      if (i > 0) {
        spans[i - 1].end = spans[i].end;
        spans.splice(i, 1);
        i = Math.max(0, i - 1);
      } else {
        spans[1].start = spans[0].start;
        spans.splice(0, 1);
      }
    }
    for (const sp of spans) out.push({ id: out.length, keepId: k.id, startMs: sp.start, endMs: sp.end });
  }
  return out;
}
