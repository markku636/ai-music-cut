// 墊樂 / 音效軌，以及「配樂在人聲下面閃避」的音量自動化。
//
// 位置釘在**成品時間**（剪完之後的時間軸），不是來源時間 —— 使用者是在剪好的節目上
// 決定「開場音樂放這裡」，之後再多剪掉幾個贅字，音樂不該跟著往前跑。
//
// 閃避刻意算成**看得見、拖得動的控制點**，而不是丟給 ffmpeg 的 sidechaincompress。
// 壓縮器是個黑盒子：聽起來不對的時候只能轉 threshold / ratio 猜，而剪輯師要的是
// 「這一句底下的音樂再低 3 dB」—— 那是拖一個點的事。這也是 Final Cut 的做法。
export type OverlayLane = "music" | "sfx";

export interface OverlayPoint {
  /** 相對片段起點的毫秒。 */
  ms: number;
  /** 相對 gainDb 的增減（0 = 不動）。 */
  db: number;
}

export interface Overlay {
  id: string;
  lane: OverlayLane;
  /** 來源媒體 id（媒體清單裡的那一份）。 */
  mediaId: string;
  srcInMs: number;
  srcOutMs: number;
  /** 成品時間軸上的起點。 */
  outStartMs: number;
  gainDb: number;
  fadeInMs: number;
  fadeOutMs: number;
  /** 音量控制點（空 = 整段固定 gainDb）。 */
  points?: OverlayPoint[];
}

export function overlayId(lane: OverlayLane, outStartMs: number): string {
  return `ov:${lane}:${Math.round(outStartMs)}:${Math.random().toString(36).slice(2, 7)}`;
}

export function overlayLengthMs(o: Overlay): number {
  return Math.max(0, o.srcOutMs - o.srcInMs);
}

export const LANE_LABEL: Record<OverlayLane, string> = {
  music: "配樂",
  sfx: "音效",
};

/** 新墊樂的預設值：−18 dB 是「聽得到但不搶戲」的起點，兩秒進出避免突然出現。 */
export const DEFAULT_MUSIC: Pick<Overlay, "gainDb" | "fadeInMs" | "fadeOutMs"> = { gainDb: -18, fadeInMs: 2000, fadeOutMs: 2000 };
export const DEFAULT_SFX: Pick<Overlay, "gainDb" | "fadeInMs" | "fadeOutMs"> = { gainDb: -6, fadeInMs: 20, fadeOutMs: 120 };

export interface DuckOptions {
  /** 人聲進來時要壓多少 dB（負值）。 */
  depthDb: number;
  /** 人聲開口前多久開始壓。 */
  attackMs: number;
  /** 人聲結束後多久回來。 */
  releaseMs: number;
  /** 兩段人聲間隔小於這個值就不放開（不然音樂會一直起伏，聽起來像在喘）。 */
  mergeGapMs: number;
}

export const DEFAULT_DUCK: DuckOptions = { depthDb: -9, attackMs: 250, releaseMs: 700, mergeGapMs: 1500 };

export interface Region {
  startMs: number;
  endMs: number;
}

/** 合併靠太近的區間。 */
export function mergeRegions(rs: Region[], gapMs: number): Region[] {
  const sorted = rs.filter((r) => r.endMs > r.startMs).sort((a, b) => a.startMs - b.startMs);
  const out: Region[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.startMs - last.endMs <= gapMs) last.endMs = Math.max(last.endMs, r.endMs);
    else out.push({ ...r });
  }
  return out;
}

/**
 * 由人聲區間（**成品時間**）算出一個片段的閃避控制點。
 *
 * 每一段人聲產生四個點：放開 → 壓下 → 維持 → 放開。片段之外的部分直接夾掉，
 * 而且如果人聲從片段開頭之前就在講，開頭那個點就直接是壓下去的狀態
 * （不然音樂會在人聲講到一半的時候先大聲一下再壓下去）。
 */
export function planDuck(voiceOut: Region[], clip: Overlay, opts: DuckOptions = DEFAULT_DUCK): OverlayPoint[] {
  const len = overlayLengthMs(clip);
  if (len <= 0) return [];
  const start = clip.outStartMs;
  const end = start + len;
  const merged = mergeRegions(voiceOut, opts.mergeGapMs).filter((r) => r.endMs > start && r.startMs < end);
  if (!merged.length) return [];

  const raw: OverlayPoint[] = [];
  const push = (ms: number, db: number) => raw.push({ ms: Math.round(Math.max(0, Math.min(len, ms))), db });

  for (const r of merged) {
    const a = r.startMs - start;
    const b = r.endMs - start;
    push(a - opts.attackMs, 0);
    push(a, opts.depthDb);
    push(b, opts.depthDb);
    push(b + opts.releaseMs, 0);
  }

  // 同一個 ms 上可能有「放開」與「壓下」兩個點（兩段人聲貼在一起）；壓下的優先，
  // 否則音樂會在兩句之間彈起來一瞬間。
  raw.sort((x, y) => x.ms - y.ms || x.db - y.db);
  const out: OverlayPoint[] = [];
  for (const p of raw) {
    const last = out[out.length - 1];
    if (last && last.ms === p.ms) {
      last.db = Math.min(last.db, p.db);
      continue;
    }
    out.push({ ...p });
  }
  return out;
}

/**
 * 人聲區間換算到成品時間軸。
 *
 * 用保留段本身當人聲範圍太粗（保留段裡也有停頓），所以吃的是 VAD / 字的區間，
 * 再逐段對映。落在剪除區的部分自然被丟掉。
 */
export function voiceRegionsInOutput(regions: Region[], keeps: { srcStartMs: number; srcEndMs: number; outStartMs: number }[]): Region[] {
  const out: Region[] = [];
  for (const r of regions) {
    for (const k of keeps) {
      const s = Math.max(r.startMs, k.srcStartMs);
      const e = Math.min(r.endMs, k.srcEndMs);
      if (e <= s) continue;
      out.push({ startMs: k.outStartMs + (s - k.srcStartMs), endMs: k.outStartMs + (e - k.srcStartMs) });
    }
  }
  return mergeRegions(out, 0);
}
