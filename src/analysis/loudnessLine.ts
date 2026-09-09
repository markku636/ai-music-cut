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

/**
 * 逐段平衡會對每個像素加多少 dB。
 *
 * 「93% 偏小聲」講完之後，使用者的下一個問題一定是「那我該怎麼辦」。
 * 逐段平衡就是答案，但它預設開著、而且要輸出之後才聽得到 ——
 * 所以把它的結果**直接畫在同一張圖上**：一條是現在的樣子，一條是輸出之後的樣子。
 *
 * 用的是 `planGains` 算出來的那一份，跟輸出時 Rust 真的套的是同一組數字，
 * 不是另外估一次（估一次就是第二份公式，兩邊會慢慢漂開）。
 *
 * @param units  響度單元（來源時間）
 * @param gainDb 對應每個單元的增益，長度要跟 `units` 一樣
 * @returns 長度 = width；那一像素不在任何單元裡（剪掉了 / 靜音）時是 `NaN`
 */
export function gainLine(
  units: readonly { startMs: number; endMs: number }[],
  gainDb: readonly number[],
  durationMs: number,
  width: number,
): Float32Array {
  const w = Math.max(1, Math.floor(width));
  const out = new Float32Array(w).fill(NaN);
  if (!units.length || durationMs <= 0) return out;
  for (let x = 0; x < w; x++) {
    // 取像素中心對應的時刻：用左緣的話，單元邊界剛好落在像素上時會歸錯邊
    const t = ((x + 0.5) / w) * durationMs;
    for (let i = 0; i < units.length; i++) {
      if (t >= units[i].startMs && t < units[i].endMs) {
        out[x] = gainDb[i] ?? 0;
        break;
      }
    }
  }
  return out;
}

/** 兩條線相加（來源響度 + 平衡增益）。任一邊是 NaN 就是 NaN。 */
export function addLines(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length).fill(NaN);
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (Number.isFinite(x) && Number.isFinite(y)) out[i] = x + y;
  }
  return out;
}

/**
 * loudnorm 那兩趟會把整段的 integrated 推到目標，所以圖上那條「平衡後」要一起平移。
 *
 * 不平移的話圖是在講半個真相：實測（sample90、目標 −16）平衡後的中位是 −17.1，
 * 但成品量出來是 −16.0 —— 圖說「還有 13% 偏小聲」，而成品其實沒有那個問題。
 * 那是個假警報，而假警報會讓人開始不相信這張圖。
 *
 * @param integrated 逐段平衡之後、只算保留段的 integrated LUFS（null = 量不到）
 */
export function loudnormOffset(integrated: number | null, targetLufs: number): number {
  if (integrated == null || !Number.isFinite(integrated)) return 0;
  return targetLufs - integrated;
}

/** 整條線加一個固定偏移（NaN 保持 NaN）。 */
export function shiftLine(line: Float32Array, db: number): Float32Array {
  if (!db) return line;
  const out = new Float32Array(line.length).fill(NaN);
  for (let i = 0; i < line.length; i++) if (Number.isFinite(line[i])) out[i] = line[i] + db;
  return out;
}
