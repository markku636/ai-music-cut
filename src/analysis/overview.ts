// 總覽導航條：整份錄音壓成一條，上面畫出「你現在在看哪一段」。
//
// 為什麼需要：一集 57 分鐘的節目放大到聽得出接縫的程度時，畫面上只剩幾秒鐘 ——
// 捲了幾下就完全不知道自己在整集的哪裡。Audition / Audacity / Reaper 都有這條，
// 而且它同時是**導航**（點一下就跳過去）與**地圖**（哪裡剪過、標記在哪一眼看完）。
//
// 這裡只放純函式：畫布怎麼畫是 UI 的事，但「一個像素代表哪一段時間」「視窗矩形在哪」
// 這種算術錯了會很難查（差一個像素看不出來，差一個 bucket 就跳錯位置），所以獨立出來測。

/**
 * 把每個 hop 一個位元組的 RMS 壓成 `width` 根柱子，每根取該區間的**最大值**。
 *
 * 取最大而不是平均：總覽要看的是「哪裡有聲音」，平均會把短促的爆音抹平成一片，
 * 整條看起來像沒有起伏，也就失去當地圖的用處。
 */
export function overviewBars(rms: Uint8Array | number[], width: number): Uint8Array {
  const w = Math.max(1, Math.floor(width));
  const out = new Uint8Array(w);
  const n = rms.length;
  if (n === 0) return out;
  for (let i = 0; i < w; i++) {
    const a = Math.floor((i * n) / w);
    const b = Math.max(a + 1, Math.floor(((i + 1) * n) / w));
    let m = 0;
    for (let k = a; k < b && k < n; k++) if (rms[k] > m) m = rms[k];
    out[i] = m;
  }
  return out;
}

/** 總覽條上的 x 座標 → 來源時間。 */
export function msFromX(x: number, stripWidth: number, durationMs: number): number {
  if (stripWidth <= 0) return 0;
  const r = Math.min(1, Math.max(0, x / stripWidth));
  return Math.round(r * durationMs);
}

/** 來源時間 → 總覽條上的 x 座標。 */
export function xFromMs(ms: number, stripWidth: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  const r = Math.min(1, Math.max(0, ms / durationMs));
  return r * stripWidth;
}

export interface Viewport {
  /** 總覽條上的左緣（px）。 */
  x: number;
  /** 寬度（px），至少 2 —— 放到最大時視窗只佔千分之一，畫不出來就等於沒有。 */
  w: number;
  /** 目前看得到的來源時間範圍。 */
  startMs: number;
  endMs: number;
  /** 整段都看得到（沒有捲動空間）—— UI 用它決定要不要顯示這條。 */
  full: boolean;
}

/**
 * 目前的可視範圍在總覽條上的位置。
 *
 * `pxPerSec` 是時間軸的縮放；`viewWidthPx` 是時間軸容器寬度。
 * 兩者相除就是看得到幾秒。
 */
export function viewportOf(opts: {
  viewStartMs: number;
  viewWidthPx: number;
  pxPerSec: number;
  durationMs: number;
  stripWidth: number;
}): Viewport {
  const { viewWidthPx, pxPerSec, durationMs, stripWidth } = opts;
  const visibleMs = pxPerSec > 0 ? (viewWidthPx / pxPerSec) * 1000 : durationMs;
  const full = visibleMs >= durationMs - 1;
  const maxStart = Math.max(0, durationMs - visibleMs);
  const startMs = Math.min(Math.max(0, opts.viewStartMs), maxStart);
  const endMs = Math.min(durationMs, startMs + visibleMs);
  const x = xFromMs(startMs, stripWidth, durationMs);
  const w = Math.max(2, xFromMs(endMs, stripWidth, durationMs) - x);
  return { x, w, startMs, endMs, full };
}

/**
 * 在總覽條上點 x → 應該捲到哪個「視窗起點」（把點到的位置放在正中間）。
 * 點在最前面 / 最後面時會被夾住，不會捲出去。
 */
export function scrollTargetMs(opts: {
  x: number;
  stripWidth: number;
  durationMs: number;
  viewWidthPx: number;
  pxPerSec: number;
}): number {
  const { x, stripWidth, durationMs, viewWidthPx, pxPerSec } = opts;
  const visibleMs = pxPerSec > 0 ? (viewWidthPx / pxPerSec) * 1000 : durationMs;
  const center = msFromX(x, stripWidth, durationMs);
  const maxStart = Math.max(0, durationMs - visibleMs);
  return Math.round(Math.min(maxStart, Math.max(0, center - visibleMs / 2)));
}

export interface OverviewSpan {
  startMs: number;
  endMs: number;
}

/**
 * 把剪除區間壓成總覽條上畫得出來的矩形（**至少 1 px**）。
 *
 * 沒有下限的話，一集裡幾百個 200 ms 的贅字在 57 分鐘的尺度上每個都不到 0.1 px，
 * 整條會是空的 —— 而「剪了哪裡」正是這條要回答的問題之一。
 */
export function spansToRects(spans: OverviewSpan[], stripWidth: number, durationMs: number): { x: number; w: number }[] {
  if (durationMs <= 0) return [];
  return spans
    .filter((s) => s.endMs > s.startMs)
    .map((s) => {
      const x = xFromMs(s.startMs, stripWidth, durationMs);
      return { x, w: Math.max(1, xFromMs(s.endMs, stripWidth, durationMs) - x) };
    });
}
