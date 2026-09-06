// 多麥克風同步（Final Cut 的 Synchronize Clips）。
//
// 遠端錄 podcast 最常見的素材是「一人一軌」：每個人各自按下錄音，起點差幾秒到幾十秒。
// 對齊靠的是兩軌都聽得到的東西 —— 就算麥克風之間有隔音，講話的**節奏**還是一致的，
// 所以拿能量包絡（不是波形本身）做正規化互相關就夠了，而且對音色差異完全免疫。
//
// 為什麼不直接對波形：兩支麥收到的相位、音色、增益都不同，樣本層級的相關性很低；
// 而且 40 分鐘 × 48 kHz 的互相關算不完。能量包絡把資料量降到 1/2400，還更穩。
import type { LocalAnalysis } from "./peaks";
import { rmsU8ToDb } from "./peaks";

export interface SyncOptions {
  /** 比對用的取樣率（Hz）。20 Hz = 50 ms 一格，對齊精度綽綽有餘。 */
  rateHz: number;
  /** 最多允許差多少秒（超過就不找了）。 */
  maxLagSec: number;
  /** 拿多長的片段來比對。太短容易被單一段落騙、太長算得慢。 */
  windowSec: number;
  /** 低於這個 dB 視為靜音，不參與比對。 */
  silenceDb: number;
}

export const DEFAULT_SYNC: SyncOptions = { rateHz: 20, maxLagSec: 120, windowSec: 90, silenceDb: -50 };

export interface SyncResult {
  /** b 要往後移多少毫秒才會對齊 a（負數＝b 比較早開始）。 */
  offsetMs: number;
  /** 0–1，越高越可信。低於 0.3 大概是沒對上。 */
  confidence: number;
  /** 用來比對的視窗在 a 的哪裡（毫秒），除錯用。 */
  windowStartMs: number;
}

/** 能量包絡降到 rateHz，並轉成 0–1 的線性強度（靜音夾成 0）。 */
export function envelopeAt(a: LocalAnalysis, rateHz: number, silenceDb: number): Float32Array {
  const step = Math.max(1, Math.round(a.pps / rateHz));
  const n = Math.floor(a.nBuckets / step);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // 取這一格裡最大的（峰值比平均更能代表「有沒有人在講話」）
    let peak = 0;
    for (let k = i * step; k < (i + 1) * step && k < a.nBuckets; k++) {
      if (a.rmsU8[k] > peak) peak = a.rmsU8[k];
    }
    const db = rmsU8ToDb(peak);
    out[i] = db <= silenceDb ? 0 : (db - silenceDb) / -silenceDb;
  }
  return out;
}

/** 找出能量最集中的視窗起點（避免拿一整段安靜的地方去比對）。 */
export function bestWindowStart(env: Float32Array, winLen: number): number {
  if (env.length <= winLen) return 0;
  // 前綴和 → O(n) 掃過所有視窗
  const pre = new Float64Array(env.length + 1);
  for (let i = 0; i < env.length; i++) pre[i + 1] = pre[i] + env[i];
  let best = 0;
  let bestSum = -1;
  for (let s = 0; s + winLen <= env.length; s++) {
    const sum = pre[s + winLen] - pre[s];
    if (sum > bestSum) {
      bestSum = sum;
      best = s;
    }
  }
  return best;
}

/**
 * 正規化互相關：把 a 的一段視窗滑過 b，找相關性最高的位移。
 *
 * 回傳的 confidence 是「最佳分數」與「次佳分數」的差距比例，不是相關係數本身 ——
 * 講話的能量包絡本來就到處都有點像，光看相關係數會一直很高。真正代表「對上了」的是
 * **有沒有一個明顯勝出的位移**。
 */
export function correlate(a: Float32Array, b: Float32Array, maxLag: number, winLen: number): { lag: number; confidence: number; windowStart: number } {
  const ws = bestWindowStart(a, Math.min(winLen, a.length));
  const w = Math.min(winLen, a.length - ws);
  if (w <= 4) return { lag: 0, confidence: 0, windowStart: ws };

  let sa = 0;
  let sa2 = 0;
  for (let i = 0; i < w; i++) {
    sa += a[ws + i];
    sa2 += a[ws + i] * a[ws + i];
  }
  const ma = sa / w;
  const va = Math.sqrt(Math.max(1e-9, sa2 / w - ma * ma));

  let best = -2;
  let second = -2;
  let bestLag = 0;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const off = ws + lag;
    if (off < 0 || off + w > b.length) continue;
    let sb = 0;
    let sb2 = 0;
    let sab = 0;
    for (let i = 0; i < w; i++) {
      const x = a[ws + i];
      const y = b[off + i];
      sb += y;
      sb2 += y * y;
      sab += x * y;
    }
    const mb = sb / w;
    const vb = Math.sqrt(Math.max(1e-9, sb2 / w - mb * mb));
    const r = (sab / w - ma * mb) / (va * vb);
    if (r > best) {
      second = best;
      best = r;
      bestLag = lag;
    } else if (r > second) {
      second = r;
    }
  }
  if (best <= -1) return { lag: 0, confidence: 0, windowStart: ws };
  // 勝出幅度：最佳與次佳差多少（夾在 0–1）
  const margin = second <= -1 ? best : Math.max(0, best - second);
  const confidence = Math.max(0, Math.min(1, best <= 0 ? 0 : margin * 3));
  return { lag: bestLag, confidence, windowStart: ws };
}

/** 兩份本機分析 → b 相對 a 的位移。 */
export function estimateOffset(a: LocalAnalysis, b: LocalAnalysis, opts: SyncOptions = DEFAULT_SYNC): SyncResult {
  const ea = envelopeAt(a, opts.rateHz, opts.silenceDb);
  const eb = envelopeAt(b, opts.rateHz, opts.silenceDb);
  const maxLag = Math.round(opts.maxLagSec * opts.rateHz);
  const winLen = Math.round(opts.windowSec * opts.rateHz);
  const r = correlate(ea, eb, maxLag, winLen);
  return {
    // lag > 0 代表「a 的內容出現在 b 的更後面」→ b 要往前移（負的 delay）才對齊
    offsetMs: Math.round((-r.lag * 1000) / opts.rateHz),
    confidence: r.confidence,
    windowStartMs: Math.round((r.windowStart * 1000) / opts.rateHz),
  };
}

/**
 * 一組麥克風的對齊結果 → 每一軌要延遲多少毫秒（都 ≥ 0，最早的那一軌是 0）。
 *
 * ffmpeg 的 adelay 只能往後推不能往前拉，所以把整組平移到「最早的那一軌 = 0」。
 */
export function delaysFromOffsets(offsetsMs: number[]): number[] {
  if (!offsetsMs.length) return [];
  const min = Math.min(...offsetsMs);
  return offsetsMs.map((o) => Math.round(o - min));
}
