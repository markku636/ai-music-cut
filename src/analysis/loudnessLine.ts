// 整集的響度形狀：把逐視窗的 short-term LUFS 壓成「一像素一個值」。
//
// 響度目前只有兩個地方看得到：播放線上的即時表，以及輸出後的驗收。兩個都回答
// 「**這一刻**多大聲」，但剪 podcast 的人真正要問的是「**哪幾段**要處理」——
// 那是一張圖的事，不是一個數字。Hindenburg / Audition / Auphonic 都有這張圖。
//
// 資料本來就在（`analysis.bin` 每 100 ms 一個視窗，40 分鐘約 24000 個），
// 所以這裡只是把它壓到帶子的寬度。

/** 低於這個值視為靜音，不參與統計 —— 停頓不是「這一段很小聲」。 */
export const SILENT_LUFS = -60;

/**
 * 每個像素取那一段裡**有聲視窗的中位數**。
 *
 * 不用平均：一段話中間夾一個 −70 的停頓就會把平均拉下去，圖上出現一個不存在的低谷。
 * 也不用最大值：那會把「整段偏小聲」畫得跟正常一樣，而那正是這張圖要回答的問題。
 *
 * @param win  每視窗 3 個 f32：[momentary, shortTerm, rmsDb]
 * @returns 長度 = width 的陣列；那一段完全沒有聲音時是 `NaN`（呼叫端不要畫）。
 */
export function loudnessLine(win: Float32Array, nWin: number, width: number): Float32Array {
  const w = Math.max(1, Math.floor(width));
  const out = new Float32Array(w).fill(NaN);
  if (nWin <= 0) return out;
  const per = nWin / w;
  const buf: number[] = [];
  for (let x = 0; x < w; x++) {
    const from = Math.floor(x * per);
    const to = Math.max(from + 1, Math.floor((x + 1) * per));
    buf.length = 0;
    for (let i = from; i < to && i < nWin; i++) {
      const v = win[i * 3 + 1];
      if (Number.isFinite(v) && v > SILENT_LUFS) buf.push(v);
    }
    if (!buf.length) continue;
    buf.sort((a, b) => a - b);
    out[x] = buf[buf.length >> 1];
  }
  return out;
}

/** 畫的時候用的上下界：以目標為中心，上下各留這麼多 LU。 */
export const LOUD_RANGE_LU = 18;

/** LUFS → 0（底）..1（頂）。超出範圍夾住 —— 圖是給人看形狀的，不是量測儀器。 */
export function loudnessFraction(lufs: number, targetLufs: number, rangeLu = LOUD_RANGE_LU): number {
  if (!Number.isFinite(lufs)) return NaN;
  const lo = targetLufs - rangeLu;
  const hi = targetLufs + rangeLu / 3; // 上面留少一點：比目標大聲太多的情況少，而且更該擠在頂端顯眼
  return Math.max(0, Math.min(1, (lufs - lo) / (hi - lo)));
}

/**
 * 整集有多少比例明顯低於目標。
 *
 * 「明顯」= 3 LU 以上 —— 那大約是聽得出來「這個人比較小聲」的門檻，
 * 也是逐段平衡會出手的量級。
 */
export function quietShare(line: Float32Array, targetLufs: number, marginLu = 3): number {
  let voiced = 0;
  let quiet = 0;
  for (const v of line) {
    if (!Number.isFinite(v)) continue;
    voiced++;
    if (v < targetLufs - marginLu) quiet++;
  }
  return voiced ? quiet / voiced : 0;
}
