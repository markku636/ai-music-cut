// 帶狀 DTW（Sakoe-Chiba 帶 + 斜率限制），只存 2 bit 的回溯碼。
//
// 每一列（guide 的第 i 格）只算 dub 的 [center(i) − W, center(i) + W] 這一帶；三列滾動成本，
// 回溯用 Uint8（一格一 byte，簡單優先；60 分鐘 5 ms 細對齊 ±200 ms ≈ 58 MB，可接受）。
// 步型：(1,1) 對角、(1,2) dub 走快、(2,1) dub 走慢 → 局部斜率 ∈ [½, 2]。非對角多付一點成本，
// 平的地方才不會亂走。`forceDiagonal(i)` 讓保護區內只能走對角（速率 1.0）。

export interface DtwOptions {
  /** guide 第 i 格對應到 dub 的哪一格（帶的中心）。 */
  center: (i: number) => number;
  /** 帶的半寬（格）。 */
  halfWidth: number;
  /** 兩格的距離。 */
  dist: (i: number, j: number) => number;
  /** 這一列只能走對角（保護區）。 */
  forceDiagonal?: (i: number) => boolean;
  /** 開放起點：guide 第 0 格可以對到 dub 帶內任何一格（take 前面有多餘的靜音）。 */
  openBegin?: boolean;
  /** 開放終點：guide 最後一格對到 dub 帶內成本最低的那一格。 */
  openEnd?: boolean;
  /** 非對角步的額外成本（相對於 dist 的倍數）。 */
  offDiagonalPenalty?: number;
}

export interface DtwResult {
  /** (i, j) 對，i 遞增；j 非遞減。 */
  path: [number, number][];
  /** 路徑總成本。 */
  cost: number;
  /** 每格平均成本。 */
  meanCost: number;
}

const MOVE_DIAG = 1; // (i-1, j-1)
const MOVE_FAST = 2; // (i-1, j-2)：dub 走得快
const MOVE_SLOW = 3; // (i-2, j-1)：dub 走得慢

/**
 * n = guide 格數、m = dub 格數。回傳的 path 是 (i, j)。
 * 帶外一律不可達；起點固定 (0, center(0)) 除非 openBegin。
 */
export function bandedDtw(n: number, m: number, opts: DtwOptions): DtwResult {
  const W = Math.max(1, Math.floor(opts.halfWidth));
  const width = 2 * W + 1;
  const pen = 1 + (opts.offDiagonalPenalty ?? 0.5);
  if (n <= 0 || m <= 0) return { path: [], cost: 0, meanCost: 0 };
  const INF = Number.POSITIVE_INFINITY;
  // 三列滾動：row[i-2], row[i-1], row[i]（各 width 寬，帶內索引 k = j − (center(i) − W)）
  let rowA = new Float64Array(width).fill(INF); // i-2
  let rowB = new Float64Array(width).fill(INF); // i-1
  let rowC = new Float64Array(width).fill(INF); // i
  const centers = new Int32Array(n);
  for (let i = 0; i < n; i++) centers[i] = Math.max(0, Math.min(m - 1, Math.round(opts.center(i))));
  const moves = new Uint8Array(n * width);
  const jOf = (i: number, k: number) => centers[i] - W + k;
  const kOf = (i: number, j: number) => j - (centers[i] - W);

  for (let i = 0; i < n; i++) {
    rowC.fill(INF);
    const diagOnly = opts.forceDiagonal?.(i) ?? false;
    for (let k = 0; k < width; k++) {
      const j = jOf(i, k);
      if (j < 0 || j >= m) continue;
      const d = opts.dist(i, j);
      if (i === 0) {
        // 起點：openBegin 時帶內任一格都可以起跑（成本只有自己）；否則只有帶中心
        if (opts.openBegin || j === centers[0]) {
          rowC[k] = d;
          moves[i * width + k] = 0;
        }
        continue;
      }
      let best = INF;
      let mv = 0;
      // (i-1, j-1)
      const kd = kOf(i - 1, j - 1);
      if (kd >= 0 && kd < width && rowB[kd] < INF) {
        best = rowB[kd] + d;
        mv = MOVE_DIAG;
      }
      if (!diagOnly) {
        // (i-1, j-2)：dub 快
        const kf = kOf(i - 1, j - 2);
        if (kf >= 0 && kf < width && rowB[kf] < INF) {
          // 跳過的 (i, j-1) 也要付費：一步斜步走過兩格，不能比兩步對角便宜（開放端會偏向 0.5×/2× 漂走）
          const c = rowB[kf] + (d + opts.dist(i, j - 1)) * pen;
          if (c < best) {
            best = c;
            mv = MOVE_FAST;
          }
        }
        // (i-2, j-1)：dub 慢
        if (i >= 2) {
          const ks = kOf(i - 2, j - 1);
          if (ks >= 0 && ks < width && rowA[ks] < INF) {
            const c = rowA[ks] + (d + opts.dist(i - 1, j)) * pen;
            if (c < best) {
              best = c;
              mv = MOVE_SLOW;
            }
          }
        }
      }
      if (best < INF) {
        rowC[k] = best;
        moves[i * width + k] = mv;
      }
    }
    const t = rowA;
    rowA = rowB;
    rowB = rowC;
    rowC = t;
  }
  // 終點：rowB 現在是第 n-1 列
  let endK = -1;
  let endCost = INF;
  if (opts.openEnd) {
    for (let k = 0; k < width; k++) if (rowB[k] < endCost) (endCost = rowB[k]), (endK = k);
  } else {
    const k = kOf(n - 1, centers[n - 1]);
    if (k >= 0 && k < width && rowB[k] < INF) {
      endK = k;
      endCost = rowB[k];
    } else {
      // 中心不可達（被斜率限制卡住）→ 退回帶內最好的
      for (let k2 = 0; k2 < width; k2++) if (rowB[k2] < endCost) (endCost = rowB[k2]), (endK = k2);
    }
  }
  if (endK < 0) return { path: [], cost: INF, meanCost: INF };

  // 回溯
  const path: [number, number][] = [];
  let i = n - 1;
  let j = jOf(n - 1, endK);
  while (i >= 0) {
    path.push([i, j]);
    const mv = moves[i * width + kOf(i, j)];
    if (mv === MOVE_DIAG) {
      i -= 1;
      j -= 1;
    } else if (mv === MOVE_FAST) {
      i -= 1;
      j -= 2;
    } else if (mv === MOVE_SLOW) {
      i -= 2;
      j -= 1;
    } else break;
  }
  path.reverse();
  return { path, cost: endCost, meanCost: endCost / Math.max(1, path.length) };
}

/** 沿一條固定位移的對角線算成本（拿來跟 DTW 路徑比：差多少才叫「真的對上了」）。 */
export function straightCost(n: number, m: number, offset: number, dist: (i: number, j: number) => number): number {
  let c = 0;
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    const j = i + offset;
    if (j < 0 || j >= m) continue;
    c += dist(i, j);
    cnt++;
  }
  return cnt ? c / cnt : Number.POSITIVE_INFINITY;
}

/**
 * 信心 0–1：DTW 路徑的平均成本比「隨便一條錯位的路」低多少。
 * 錯位的路：把路徑整條往 dub 平移 shift 格再算一次；如果差不多，代表訊號到處都像（或到處都不像），不能信。
 */
export function pathConfidence(path: [number, number][], m: number, shift: number, dist: (i: number, j: number) => number): number {
  if (!path.length) return 0;
  let on = 0;
  let off = 0;
  let cnt = 0;
  for (const [i, j] of path) {
    const j2 = j + shift;
    if (j2 < 0 || j2 >= m) continue;
    on += dist(i, j);
    off += dist(i, j2);
    cnt++;
  }
  if (!cnt || off <= 1e-9) return 0;
  const ratio = Math.max(0, Math.min(1, (off - on) / off));
  // 也看絕對成本：特徵是 0–1，平均每格差超過 0.3 就不像同一段內容（DTW 在寬帶裡什麼都扭得到，只比相對值會太樂觀）
  const abs = Math.max(0, Math.min(1, 1 - on / cnt / 0.3));
  return ratio * abs;
}
