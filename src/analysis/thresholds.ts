// 激進度 0–100 → 各規則門檻（線性插值）。A=0 最保守、A=100 最積極；A=50 為預設。

export interface Thresholds {
  /** 贅字候選自動套用的最低分（LLM 不可用時的規則保守模式也用它）。 */
  fillerAutoScore: number;
  pauseMinBetweenSentencesMs: number;
  pauseMinWithinSentenceMs: number;
  /** 長停頓縮短後保留的長度（規則層產生候選時用；EDL 的呼吸感走 edl/breath.ts）。 */
  pauseKeepMs: number;
  /** 開頭 / 結尾靜音保留。 */
  leadTrailKeepMs: number;
  stutterMaxGapMs: number;
  ngramRepeatMaxGapMs: number;
  restartMinOverlap: number;
  restartMaxChars: number;
  unclearWordProb: number;
  unclearMinRun: number;
  /** 比講者中位數低多少 LU 視為聽不清。 */
  unclearQuietLu: number;
  /** 非語音區高於底噪多少 LU 視為雜音。 */
  noiseAboveFloorLu: number;
  /** 30 秒內「然後 / 就是 / 其實」出現幾次算過度使用。 */
  markerOverusePer30s: number;
  /** 單句最多剪除比例（EDL 守門）。 */
  maxSentenceRemovalRatio: number;
}

const LO: Thresholds = {
  fillerAutoScore: 0.9,
  pauseMinBetweenSentencesMs: 2000,
  pauseMinWithinSentenceMs: 1500,
  pauseKeepMs: 450,
  leadTrailKeepMs: 700,
  stutterMaxGapMs: 300,
  ngramRepeatMaxGapMs: 500,
  restartMinOverlap: 0.75,
  restartMaxChars: 8,
  unclearWordProb: 0.35,
  unclearMinRun: 3,
  unclearQuietLu: 22,
  noiseAboveFloorLu: 16,
  markerOverusePer30s: 4,
  maxSentenceRemovalRatio: 0.35,
};

const HI: Thresholds = {
  fillerAutoScore: 0.6,
  pauseMinBetweenSentencesMs: 900,
  pauseMinWithinSentenceMs: 700,
  pauseKeepMs: 250,
  leadTrailKeepMs: 300,
  stutterMaxGapMs: 600,
  ngramRepeatMaxGapMs: 1000,
  restartMinOverlap: 0.55,
  restartMaxChars: 14,
  unclearWordProb: 0.5,
  unclearMinRun: 2,
  unclearQuietLu: 16,
  noiseAboveFloorLu: 10,
  markerOverusePer30s: 2,
  maxSentenceRemovalRatio: 0.6,
};

const INT_KEYS: (keyof Thresholds)[] = ["unclearMinRun", "markerOverusePer30s", "restartMaxChars"];

export function thresholdsFor(aggressiveness: number): Thresholds {
  const a = Math.max(0, Math.min(100, aggressiveness)) / 100;
  const out = {} as Thresholds;
  for (const k of Object.keys(LO) as (keyof Thresholds)[]) {
    const v = LO[k] + (HI[k] - LO[k]) * a;
    out[k] = INT_KEYS.includes(k) ? Math.round(v) : v;
  }
  return out;
}
