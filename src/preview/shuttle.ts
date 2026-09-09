// J / K / L 轉盤（shuttle）的狀態機。
//
// 現況的 J 是「往回跳 5 秒」，那是 seek 不是轉盤。剪輯軟體的 JKL 是一個階梯：
// L 一直按往前加速、J 一直按往回加速、K 停；而且 **J 與 L 互相抵銷** ——
// 順向 4x 的時候按 J 不是立刻倒帶，是先降到 2x。這是找位置時最重要的手感：
// 衝過頭了就反手點兩下，而不是停下來重新拖。
//
// 純狀態機，不碰 DOM —— 驅動在 useShuttle.ts，測試只測轉移表。
export interface ShuttleState {
  /** -1 倒退、0 停、1 前進。 */
  dir: -1 | 0 | 1;
  /** 速率倍數（0 = 停）。慢速是 0.5。 */
  rate: number;
}

export const SHUTTLE_STOPPED: ShuttleState = { dir: 0, rate: 0 };

/** 階梯。每按一次 J / L 就在這上面走一格。 */
export const SHUTTLE_LADDER = [-4, -2, -1, 0, 1, 2, 4] as const;

export const SLOW_RATE = 0.5;

function valueOf(s: ShuttleState): number {
  return s.dir * s.rate;
}

function toState(v: number): ShuttleState {
  if (v === 0) return SHUTTLE_STOPPED;
  return { dir: v > 0 ? 1 : -1, rate: Math.abs(v) };
}

/**
 * 往階梯的某個方向走一格：取「嚴格大於（或小於）目前值」的第一格。
 *
 * 不用「找最近的一格再 ±1」—— 慢速 0.5x 剛好卡在 0 與 1 中間，最近的一格是平手，
 * 往哪邊解都會有一邊錯（從順向 0.5x 按 J 應該是停下來，不是直接倒退 1x）。
 */
function step(v: number, up: boolean): number {
  if (up) {
    for (const x of SHUTTLE_LADDER) if (x > v + 1e-9) return x;
    return SHUTTLE_LADDER[SHUTTLE_LADDER.length - 1];
  }
  for (let i = SHUTTLE_LADDER.length - 1; i >= 0; i--) if (SHUTTLE_LADDER[i] < v - 1e-9) return SHUTTLE_LADDER[i];
  return SHUTTLE_LADDER[0];
}

export interface ShuttleOpts {
  /** 按住 K 再點 J / L：慢速（0.5x）。 */
  slow?: boolean;
}

export function nextShuttle(state: ShuttleState, key: "J" | "K" | "L", opts: ShuttleOpts = {}): ShuttleState {
  if (key === "K") return SHUTTLE_STOPPED;
  if (opts.slow) return { dir: key === "L" ? 1 : -1, rate: SLOW_RATE };
  return toState(step(valueOf(state), key === "L"));
}

/** 傳輸列顯示用。 */
export function shuttleLabel(s: ShuttleState): string {
  if (!s.dir || !s.rate) return "";
  const arrows = s.dir < 0 ? "◀◀" : "▶▶";
  return `${arrows} ${s.rate}x`;
}

/**
 * `<audio>` 放不出倒轉，倒退時只移動播放線（靜音）。UI 要據此說明。
 *
 * **落點是準的**：實機量過（1 秒），倒退 1x/2x/4x 的誤差是 2 / 36 / 8 ms（≤ 1.8%）。
 * 順向靠 `playbackRate`，穩態倍率是精確的（實測 1.000 / 2.000 / 4.006），
 * 但每改一次速率媒體元素要重新同步，會吃掉約 57 ms 的來源時間 ——
 * 4x 下每按一次 L 就少聽約 230 ms。那是元素本身的成本，不是這裡算錯。
 */
export function isSilentDirection(s: ShuttleState): boolean {
  return s.dir < 0;
}
