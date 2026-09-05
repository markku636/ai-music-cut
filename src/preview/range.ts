// 範圍播放（選取播放 / 候選預聽）的收尾判斷。抽成純函式是為了能單元測試：
// 舊版用 `timeupdate` 事件判斷結束，那個事件只有 4 Hz，最多會超出 250 ms 才停下來 ——
// 拖選 3 秒按 Space 會聽到第 4 秒的內容。現在每幀問一次這個函式。

export type RangeAction = "play" | "loop" | "stop";

/** 使用者往回 seek 超過這個距離，就視為主動離開這段（不是播放自然推進）→ 結束範圍模式。 */
export const LEAVE_TOLERANCE_MS = 250;

/**
 * 收尾前的音量斜坡長度。8 ms 在理論上就夠掩蓋 click，但 rAF 一幀就 16.7 ms，
 * 8 ms 實際上只會被取樣到 0～1 次；用 30 ms 才穩定拿到 1～2 個中間值。
 */
export const TAIL_RAMP_MS = 30;

/**
 * 這一幀該做什麼：
 * - `"play"`：還在範圍內，繼續。
 * - `"loop"`：到尾巴且 loop=true → 跳回開頭。
 * - `"stop"`：到尾巴且不循環，或使用者已經跳出這段。
 */
export function rangeTick(curMs: number, startMs: number, endMs: number, loop: boolean): RangeAction {
  if (curMs < startMs - LEAVE_TOLERANCE_MS) return "stop";
  if (curMs >= endMs) return loop ? "loop" : "stop";
  return "play";
}

/**
 * 收尾斜坡的音量係數（1 → 0，最後 TAIL_RAMP_MS 毫秒）。
 * loop 時不做斜坡（會聽起來一頓一頓的）。
 */
export function tailGain(curMs: number, endMs: number, loop: boolean): number {
  if (loop) return 1;
  const left = endMs - curMs;
  if (left >= TAIL_RAMP_MS) return 1;
  if (left <= 0) return 0;
  return left / TAIL_RAMP_MS;
}
