import type { LocalAnalysis } from "./peaks";
import { percentileDb } from "./gate";

/**
 * 修聲：把錄音本身的底噪 / 隆隆聲 / 齒音處理掉。
 *
 * 這一支只負責**決定數字**，濾鏡字串在 Rust 端組（`src-tauri/src/cleanup.rs`），
 * 前端不送 ffmpeg 濾鏡語法過去 —— 那等於把任意濾鏡執行權交出去。
 *
 * 三件事各自解一個不同的問題，不要混為一談：
 * - 隆隆（rumble）：桌子撞擊、冷氣、腳步，全在 80 Hz 以下。人聲基頻最低約 85 Hz，
 *   所以這一刀砍下去對語音幾乎零成本，是三者中最安全的。
 * - 底噪（noise floor）：麥克風本底與環境嘶聲。要先量到「安靜的時候有多吵」才知道要減多少。
 * - 齒音（sibilance）：ㄙ / ㄕ / s 的高頻突刺。過量會讓人聲變鈍，所以預設保守。
 */

export interface CleanupSpec {
  /** 高通截止（Hz）。0 = 不做。 */
  rumbleHz: number;
  /** 降噪量（dB）。0 = 不做。 */
  denoiseDb: number;
  /** 量到的底噪（dBFS），餵給 afftdn 的 nf。 */
  noiseFloorDb: number;
  /** 齒音抑制強度 0–1。0 = 不做。 */
  deessAmount: number;
}

export const CLEANUP_OFF: CleanupSpec = { rumbleHz: 0, denoiseDb: 0, noiseFloorDb: -60, deessAmount: 0 };

export interface CleanupEstimate {
  /** 安靜段落的音量（dBFS）—— 這就是底噪。 */
  floorDb: number;
  /** 說話時的音量（dBFS）。 */
  speechDb: number;
  /** 兩者差距。差距大 = 錄得乾淨。 */
  marginDb: number;
  /** 建議值（使用者可以再調）。 */
  suggested: CleanupSpec;
  /** 這份錄音值不值得降噪。 */
  worthDenoise: boolean;
  /** 給人看的一句話。 */
  summary: string;
}

/** 安靜到這個程度就不用降噪了 —— 再減只會傷到語音尾音。 */
const QUIET_ENOUGH_DB = -58;
/** 人聲基頻最低大約 85 Hz（低男聲），高通擺在它下面。 */
export const RUMBLE_HZ = 80;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * 量這份錄音的底噪，給出建議的修聲設定。
 *
 * 底噪取第 5 百分位的窗（夠低才是真的安靜，又不會取到單一個異常靜的窗），
 * 語音取第 90 百分位。用的是與閘門估計同一份 `percentileDb`，兩邊的「安靜」定義一致。
 */
export function estimateCleanup(a: LocalAnalysis | null): CleanupEstimate {
  if (!a || !a.rmsU8.length) {
    return { floorDb: -60, speechDb: -20, marginDb: 40, suggested: { ...CLEANUP_OFF }, worthDenoise: false, summary: "沒有分析資料可以量底噪" };
  }
  const floorDb = percentileDb(a, 0.05);
  const speechDb = percentileDb(a, 0.9);
  const marginDb = speechDb - floorDb;
  const worthDenoise = floorDb > QUIET_ENOUGH_DB;

  // 底噪 −58 dB 以下不動；越吵減越多，但上限 18 dB ——
  // afftdn 減超過這個量，安靜處會開始出現「水聲」（musical noise），比原本的嘶聲更難聽。
  const denoiseDb = worthDenoise ? Math.round(clamp((floorDb - QUIET_ENOUGH_DB) * 0.9 + 6, 6, 18)) : 0;

  const suggested: CleanupSpec = {
    rumbleHz: RUMBLE_HZ,
    denoiseDb,
    noiseFloorDb: Math.round(clamp(floorDb, -80, -20)),
    // 齒音沒有可靠的量測依據（這份分析只有能量包絡、沒有頻譜），所以預設不開，
    // 讓使用者 A/B 聽過再決定。給一個保守的預設值放在滑桿上。
    deessAmount: 0,
  };

  const summary = worthDenoise
    ? `底噪 ${floorDb.toFixed(1)} dBFS、語音 ${speechDb.toFixed(1)} dBFS（差 ${marginDb.toFixed(1)} dB）；建議降噪 ${denoiseDb} dB`
    : `底噪 ${floorDb.toFixed(1)} dBFS，已經夠安靜，不建議降噪（再減會傷到尾音）`;

  return { floorDb, speechDb, marginDb, suggested, worthDenoise, summary };
}

/** 這組設定實際上有沒有要做事。 */
export function isCleanupActive(s: CleanupSpec | null | undefined): boolean {
  return !!s && (s.rumbleHz > 0 || s.denoiseDb > 0 || s.deessAmount > 0);
}

/** 把設定講成人話，UI 與 MCP 共用。 */
export function describeCleanup(s: CleanupSpec | null | undefined): string {
  if (!isCleanupActive(s)) return "不修聲";
  const parts: string[] = [];
  if (s!.rumbleHz > 0) parts.push(`去 ${s!.rumbleHz} Hz 以下隆隆聲`);
  if (s!.denoiseDb > 0) parts.push(`降噪 ${s!.denoiseDb} dB（底噪 ${s!.noiseFloorDb} dBFS）`);
  if (s!.deessAmount > 0) parts.push(`齒音抑制 ${Math.round(s!.deessAmount * 100)}%`);
  return parts.join("、");
}

/** 夾到 Rust 端接受的範圍；UI 滑桿與 MCP 參數都先過這一關。 */
export function normalizeCleanup(s: Partial<CleanupSpec> | null | undefined): CleanupSpec {
  return {
    rumbleHz: s?.rumbleHz ? clamp(Math.round(s.rumbleHz), 20, 200) : 0,
    denoiseDb: s?.denoiseDb ? clamp(Math.round(s.denoiseDb), 1, 30) : 0,
    noiseFloorDb: clamp(Math.round(s?.noiseFloorDb ?? -60), -80, -20),
    deessAmount: s?.deessAmount ? clamp(s.deessAmount, 0.05, 1) : 0,
  };
}
