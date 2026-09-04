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

export function splitUnits(keeps: KeepSegment[], vad: VadRegion[], maxUnitMs = 15_000, minSilenceMs = 150): Unit[] {
  const out: Unit[] = [];
  for (const k of keeps) {
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
      out.push({ id: out.length, keepId: k.id, startMs: cur, endMs: cut });
      cur = cut;
    }
    if (k.srcEndMs > cur) out.push({ id: out.length, keepId: k.id, startMs: cur, endMs: k.srcEndMs });
  }
  return out;
}
