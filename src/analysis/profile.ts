// 響度輪廓：讓「聽不到聲音的人」也能對這一集的音訊講出話來。
//
// AI 助手拿得到逐字稿、候選、EDL，但**它聽不到聲音**。所以「這一集哪裡特別小聲」
// 「哪裡底噪最高」「來賓那段是不是比較吵」這種問題它一律答不出來，只能說「你自己聽
// 聽看」。而那些正是剪的時候最常問的問題。
//
// 這裡把音訊壓成幾十個數字：一條粗略的響度曲線 + 最安靜 / 最大聲的幾段 + 底噪估計。
// 少到可以整包塞進對話，又足以回答上面那些問題。
//
// **刻意只給粗的。** 逐毫秒的資料對模型沒有用（它不會去積分），而且會把上下文吃光。
// 桶子預設 30 秒，並且會自動加寬讓總數不超過上限 —— 一集三小時的節目不該回三百筆。

import { estimateGate, type GateEstimate } from "./gate";
import { meanLufs, SILENCE_LUFS } from "./meter";
import type { LocalAnalysis } from "./peaks";

/** 回給模型的桶子上限。再多它也讀不完，而且擠掉真正重要的上下文。 */
export const MAX_BUCKETS = 60;
/** 桶子最短這麼久（再細對模型沒有意義）。 */
export const MIN_BUCKET_MS = 5000;

export interface ProfileBucket {
  startMs: number;
  endMs: number;
  /** 這一段的平均響度；整段靜音時是 SILENCE_LUFS。 */
  lufs: number;
}

export interface LoudnessProfile {
  durationMs: number;
  bucketMs: number;
  /** 整集的平均（跳過靜音）。 */
  episodeLufs: number;
  buckets: ProfileBucket[];
  /** 底噪 / 人聲水準估計。 */
  gate: GateEstimate | null;
  /** 有聲音的桶子裡最安靜 / 最大聲的幾個。 */
  quietest: ProfileBucket[];
  loudest: ProfileBucket[];
}

/**
 * 依總長與上限決定桶子多寬。
 *
 * 先用要求的寬度；桶數超過上限就加寬到剛好不超過（無條件進位到 5 秒的倍數，
 * 免得出現 37.4 秒這種讓人看了想問「為什麼」的數字）。
 */
export function bucketWidthMs(durationMs: number, wantMs: number, maxBuckets = MAX_BUCKETS): number {
  const want = Math.max(MIN_BUCKET_MS, Math.round(wantMs));
  if (durationMs <= 0) return want;
  const n = Math.ceil(durationMs / want);
  if (n <= maxBuckets) return want;
  const needed = durationMs / maxBuckets;
  return Math.max(want, Math.ceil(needed / 5000) * 5000);
}

/** 這一集的響度輪廓。沒有分析資料時回 null（不要編一條假的曲線出來）。 */
export function loudnessProfile(a: LocalAnalysis | null | undefined, wantBucketMs = 30_000, maxBuckets = MAX_BUCKETS): LoudnessProfile | null {
  if (!a || a.nWin <= 0 || a.durationMs <= 0) return null;
  const bucketMs = bucketWidthMs(a.durationMs, wantBucketMs, maxBuckets);
  const buckets: ProfileBucket[] = [];
  for (let t = 0; t < a.durationMs; t += bucketMs) {
    const endMs = Math.min(a.durationMs, t + bucketMs);
    buckets.push({ startMs: t, endMs, lufs: meanLufs(a, t, endMs) });
  }
  // 整段靜音的桶子不參與排名 —— 「最安靜的一段」如果是片頭的空白，那句話沒有資訊
  const voiced = buckets.filter((b) => b.lufs > SILENCE_LUFS).sort((x, y) => x.lufs - y.lufs);
  return {
    durationMs: a.durationMs,
    bucketMs,
    episodeLufs: meanLufs(a, 0, a.durationMs),
    buckets,
    gate: a.nBuckets > 0 ? estimateGate(a) : null,
    quietest: voiced.slice(0, 3),
    loudest: voiced.slice(-3).reverse(),
  };
}

/** 這一段比整集大聲還小聲（LU）；量不到回 null。 */
export function vsEpisode(p: LoudnessProfile, b: ProfileBucket): number | null {
  if (b.lufs <= SILENCE_LUFS || p.episodeLufs <= SILENCE_LUFS) return null;
  return b.lufs - p.episodeLufs;
}
