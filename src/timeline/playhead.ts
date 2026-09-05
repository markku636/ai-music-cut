// 播放線的座標換算。跟 BeatGridOverlay 用同一組公式（時間 × px/s − 捲動量），
// 線才會跟拍線對得起來；放大到 300 px/s 時差 1 px 就看得出來。

/** 來源時間 → 波形容器內的 x（px）。scrollPx = wavesurfer 的水平捲動量。 */
export function playheadX(ms: number, pxPerSec: number, scrollPx: number): number {
  return (ms / 1000) * pxPerSec - scrollPx;
}

/** x 是否落在可視寬度內（pad 讓剛好壓在邊界的線也算看得到）。 */
export function isVisibleX(x: number, width: number, pad = 2): boolean {
  return x >= -pad && x <= width + pad;
}

/**
 * 翻頁跟隨（followMode = "page"）：線跑到右緣 threshold 比例就往前捲 step 比例的一頁，
 * 線因此停在畫面左側繼續往右走 —— 這才是「線在動」。往回 seek 出畫面則把線帶回左側 1/8 處。
 * 回傳新的 scroll；不需要捲動時回 null（呼叫端就不會每幀寫 setScroll）。
 */
export function pageScroll(
  x: number,
  width: number,
  scrollPx: number,
  maxScrollPx: number,
  threshold = 0.88,
  step = 0.8,
): number | null {
  if (width <= 0) return null;
  if (x > width * threshold) {
    const next = Math.min(Math.max(0, maxScrollPx), scrollPx + width * step);
    return next > scrollPx + 0.5 ? next : null;
  }
  if (x < 0) {
    const next = Math.max(0, scrollPx + x - width * 0.125);
    return next < scrollPx - 0.5 ? next : null;
  }
  return null;
}
