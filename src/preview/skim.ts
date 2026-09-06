/**
 * 滑過就聽得到（skimming）—— Final Cut 最常被模仿的那個手感。
 *
 * 真正的磁帶式刮盤（varispeed scrub）在瀏覽器裡做不到：`<audio>` 沒有反向播放，
 * 也沒有辦法用滑鼠速度即時改變重取樣率。實務上大家的做法都一樣 ——
 * **在游標位置丟一小段（grain）出來**，游標一動就換新的一段。
 *
 * 難的不是播，是**決定什麼時候重播**。三個都會出事的極端：
 * - 每次 pointermove 都重播：一秒幾十次，聽起來是連續的爆音，不是聲音。
 * - 只用時間節流：游標停著不動也一直重播同一段，像壞掉的唱片。
 * - 只用距離節流：慢慢拖過一個長檔案時，每一格都觸發，一樣是爆音。
 *
 * 所以兩個條件要**同時**成立才重播：離上次夠久，而且游標真的移動夠遠。
 * 這一支只負責這個決定，播放交給呼叫端 —— 這樣才測得出來。
 */

export interface SkimOptions {
  /** 兩段之間至少間隔多久（ms）。 */
  minIntervalMs: number;
  /** 游標至少要移動多少（來源 ms）才算「換位置了」。 */
  minMoveMs: number;
  /** 每一段播多長（ms）。 */
  grainMs: number;
}

/**
 * 預設值是在 34 秒的語音上調出來的：
 * 間隔 90 ms 夠讓每一段聽得出是「聲音」而不是點擊；
 * 移動門檻 60 ms 讓游標停著時安靜下來（手的微抖動不會超過它）；
 * 每段 180 ms 大約是一個字，短到跟得上手、長到聽得出是什麼字。
 */
export const DEFAULT_SKIM: SkimOptions = { minIntervalMs: 90, minMoveMs: 60, grainMs: 180 };

export interface SkimState {
  /** 上一次真的播出去的位置（來源 ms）；還沒播過是 null。 */
  lastMs: number | null;
  /** 上一次播出去的時間戳（performance.now()）。 */
  lastAt: number;
}

export const IDLE_SKIM: SkimState = { lastMs: null, lastAt: 0 };

export interface SkimGrain {
  startMs: number;
  endMs: number;
}

/**
 * 游標移到 `ms` 了，現在該不該播一段？
 *
 * 回 null = 不播（太快、或根本沒移動）。回 grain = 播這一段，並把回傳的 state 存起來。
 */
export function nextGrain(
  state: SkimState,
  ms: number,
  now: number,
  durationMs: number,
  opts: SkimOptions = DEFAULT_SKIM,
): { grain: SkimGrain; state: SkimState } | null {
  if (!Number.isFinite(ms) || ms < 0 || durationMs <= 0) return null;
  const at = Math.min(ms, durationMs);
  const movedEnough = state.lastMs === null || Math.abs(at - state.lastMs) >= opts.minMoveMs;
  const waitedEnough = now - state.lastAt >= opts.minIntervalMs;
  if (!movedEnough || !waitedEnough) return null;
  return {
    grain: { startMs: at, endMs: Math.min(durationMs, at + opts.grainMs) },
    state: { lastMs: at, lastAt: now },
  };
}
