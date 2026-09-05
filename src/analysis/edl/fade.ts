// 剪點的淡化長度。
//
// 使用者說剪除贅字要「剪完整波形 + 漸弱漸強」。R3 已經把接點協定接好（per-join 的
// crossfade / gap 淡出淡入），這裡決定「這一刀該用多長」。
//
// 關鍵取捨：交叉越長越聽不出接縫，但**長交叉會吃掉下一個字的字頭**。
// 兩側都已經是靜音時 4 ms 就夠（只是防 click）；語音直接接語音才需要 24 ms 去糊掉轉折。
import type { EnergyProbe } from "./build";

export interface FadePolicy {
  /** 兩側都安靜：只要防 click。 */
  quietXfMs: number;
  /** 一側有聲：中等。 */
  mixedXfMs: number;
  /** 語音接語音：需要糊掉轉折。 */
  speechXfMs: number;
  /** gap 接點的前段淡出 / 後段淡入。 */
  gapFadeOutMs: number;
  gapFadeInMs: number;
  /** 任何情況下的上限（再長就會吃掉字頭）。 */
  maxXfMs: number;
}

export const DEFAULT_FADE_POLICY: FadePolicy = {
  quietXfMs: 4,
  mixedXfMs: 12,
  speechXfMs: 24,
  gapFadeOutMs: 18,
  gapFadeInMs: 25,
  maxXfMs: 40,
};

/** 判定「安靜」的門檻（dBFS）。比這更小聲就當作沒有內容。 */
export const QUIET_DB = -45;

export interface JoinShape {
  kind: "crossfade" | "gap";
  /** crossfade：重疊長度；gap：room tone 長度。 */
  ms: number;
  fadeOutMs?: number;
  fadeInMs?: number;
}

/**
 * 依接點兩側的響度挑淡化長度。
 * probe 沒有提供 rmsDbAt（例如測試用的 MIDPOINT_PROBE）時，一律當成語音接語音 ——
 * 那是最保守的選擇：寧可交叉長一點，也不要在兩個字中間硬切。
 */
export function chooseJoin(
  probe: EnergyProbe,
  beforeMs: number,
  afterMs: number,
  policy: FadePolicy,
  gapMs: number,
): JoinShape {
  if (gapMs > 0) {
    return { kind: "gap", ms: gapMs, fadeOutMs: policy.gapFadeOutMs, fadeInMs: policy.gapFadeInMs };
  }
  const rms = probe.rmsDbAt;
  if (!rms) return { kind: "crossfade", ms: Math.min(policy.speechXfMs, policy.maxXfMs) };
  // 取接點前後各 30 ms 的響度
  const a = rms(beforeMs - 30, beforeMs);
  const b = rms(afterMs, afterMs + 30);
  const quietA = a <= QUIET_DB;
  const quietB = b <= QUIET_DB;
  const ms = quietA && quietB ? policy.quietXfMs : quietA || quietB ? policy.mixedXfMs : policy.speechXfMs;
  return { kind: "crossfade", ms: Math.min(ms, policy.maxXfMs) };
}
