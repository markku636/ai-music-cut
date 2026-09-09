// 「這個辨識模型，我這台機器跑不跑得動？」
//
// 安裝面板原本只寫「large-v3（~3 GB）」—— 那是**下載大小**，跟跑得動與否沒有關係。
// 使用者真正要知道的是顯存夠不夠：3 GB 的下載檔，用 int8 跑起來要 3.1 GB 顯存，
// 一張 4 GB 的卡剛好卡在邊緣。
//
// **顯存不夠不會自動退回 CPU。** CUDA 配不到記憶體就是直接失敗，
// 所以判斷結果要講「會失敗」，不能講「會比較慢」。

import type { AsrModelSpec, AsrHardware } from "../api";

export type AsrFit =
  /** 顯存充裕。 */
  | "fits"
  /** 顯存剛好夠，但沒有餘裕 —— 同時開別的吃顯存的東西就會失敗。 */
  | "tight"
  /** 顯存不夠，會失敗。 */
  | "short"
  /** 沒有 NVIDIA 卡（或沒裝驅動）：會用 CPU 跑，看的是記憶體不是顯存。 */
  | "cpu";

export interface AsrFitResult {
  fit: AsrFit;
  /** 拿來比的那張卡的顯存（MB）。沒有卡就是 null。 */
  vramMb: number | null;
  /** 這個模型估計需要的顯存（MB）。 */
  needMb: number;
  /** fit === "short" 時還差多少 MB。 */
  shortByMb: number;
}

/** 顯存要留多少餘裕才算「充裕」。CUDA context、其他程式、驅動保留都吃在這裡。 */
export const HEADROOM = 1.25;

/** 多張卡時看**最大**的那一張 —— faster-whisper 只會用一張，不會拆開跑。 */
export function bestVramMb(hw: AsrHardware | null | undefined): number | null {
  if (!hw?.nvidia || !hw.gpus?.length) return null;
  let best = 0;
  for (const g of hw.gpus) if (g.vram_mb > best) best = g.vram_mb;
  return best > 0 ? best : null;
}

export function fitFor(spec: AsrModelSpec, hw: AsrHardware | null | undefined): AsrFitResult {
  const needMb = spec.vram_int8_mb;
  const vramMb = bestVramMb(hw);
  if (vramMb == null) return { fit: "cpu", vramMb: null, needMb, shortByMb: 0 };
  if (vramMb >= needMb * HEADROOM) return { fit: "fits", vramMb, needMb, shortByMb: 0 };
  if (vramMb >= needMb) return { fit: "tight", vramMb, needMb, shortByMb: 0 };
  return { fit: "short", vramMb, needMb, shortByMb: needMb - vramMb };
}

/**
 * 在這台機器上**建議**哪一個模型：跑得動的裡面挑最準的（清單本身就是由小到大排的）。
 * 一張都跑不動就回最小的那個，並讓 UI 說明它會用 CPU 跑。
 */
export function recommendModel(models: readonly AsrModelSpec[], hw: AsrHardware | null | undefined): AsrModelSpec | null {
  if (!models.length) return null;
  const vram = bestVramMb(hw);
  if (vram == null) return models[0];
  let best: AsrModelSpec | null = null;
  for (const m of models) if (vram >= m.vram_int8_mb * HEADROOM) best = m;
  return best ?? models[0];
}

/** MB → 給人看的字串。小於 1 GB 就用 MB，不然會出現「0.9 GB」這種不好讀的東西。 */
export function formatMb(mb: number): string {
  if (!Number.isFinite(mb) || mb <= 0) return "—";
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** 相對速度 → 給人看的字串（以 large-v3 為 1）。 */
export function formatSpeed(x: number): string {
  if (!Number.isFinite(x) || x <= 0) return "—";
  if (x <= 1.05) return "基準";
  // 2.5 倍不能四捨五入成 3 倍 —— 那是使用者拿來比較兩個模型的數字。
  // 整數就不要拖一個 .0（「4.0× 快」讀起來像量到小數點）。
  const n = Number.isInteger(x) ? String(x) : x.toFixed(1);
  return `≈ ${n}× 快`;
}
