// 單一 <audio> 元素的全域參考：讓快捷鍵 / 工具 / 時間軸不必透過 React 樹就能控制播放。
import { usePlayback } from "../store/playback";
import { useTimeline } from "../store/timeline";
import { releaseGainSource, setGainSource } from "./previewGain";
import { rangeTick, tailGain, TAIL_RAMP_MS } from "./range";
import { subscribeTick, TICK_PRIORITY } from "./ticker";

let el: HTMLAudioElement | null = null;
let rangeStop: (() => void) | null = null;

/** 最近一次範圍播放怎麼結束的（只給 devBridge 的自動化驗收看，正式版不讀）。 */
export interface RangeStopInfo {
  reason: "natural" | "pause-event" | "play-rejected" | "manual" | "left-range";
  atMs: number;
  startMs: number;
  endMs: number;
}
let lastStop: RangeStopInfo | null = null;
export function lastRangeStop(): RangeStopInfo | null {
  return lastStop;
}

export function setPlayer(e: HTMLAudioElement | null) {
  el = e;
}

export function getPlayer(): HTMLAudioElement | null {
  return el;
}

export function togglePlay() {
  const p = el;
  if (!p || !p.src) return;
  if (p.paused) void p.play().catch(() => {});
  else p.pause();
}

export function seekBy(deltaMs: number) {
  const p = el;
  if (!p) return;
  const dur = Number.isFinite(p.duration) ? p.duration * 1000 : Number.POSITIVE_INFINITY;
  p.currentTime = Math.max(0, Math.min(dur, p.currentTime * 1000 + deltaMs)) / 1000;
}

export function seekTo(ms: number) {
  const p = el;
  if (!p) return;
  const dur = Number.isFinite(p.duration) ? p.duration * 1000 : Number.POSITIVE_INFINITY;
  p.currentTime = Math.max(0, Math.min(dur, ms)) / 1000;
}

/** 目前是否在播放某個範圍（預聽 / 選取播放）。 */
export function isRangePlaying(): boolean {
  return rangeStop !== null;
}

/** 停止範圍播放（沒有在播範圍則不動作）。 */
export function stopRange() {
  rangeStop?.();
}

/**
 * 「播放」這個動作的唯一定義：有時間選取就播那一段，而且**一律從選取起點開始**；
 * 沒有選取才是一般的播放 / 暫停。已經在播同一段就停（再按一次＝停）。
 *
 * 為什麼要抽出來：本來只有 Space 有這個行為（App.tsx 的 spaceKey），工具列的播放鈕卻直接
 * 呼叫 togglePlay()，所以拖好一段、播放線落在段落中間時按鈕會從中間開始播，跟 Space 不一樣。
 * 中文輸入法下字母鍵不會產生 keydown，很多人只能點按鈕 —— 兩條路徑必須是同一個行為。
 */
export function togglePlaySelectionAware() {
  const tl = useTimeline.getState();
  if (tl.selection && el) {
    const pv = usePlayback.getState().preview;
    const onThisSelection =
      isRangePlaying() && !!pv && pv.startMs === tl.selection.startMs && pv.endMs === tl.selection.endMs;
    if (onThisSelection) stopRange();
    else playRange(tl.selection.startMs, tl.selection.endMs, { skip: false, loop: tl.loopSelection });
    return;
  }
  togglePlay();
}

export interface PlayRangeOptions {
  /** false → 播原始（聽建議段落本身）；true → 沿用跳播（聽剪掉後的接法）。 */
  skip: boolean;
  loop?: boolean;
  /** 自然播到尾端才會呼叫（手動停止 / 使用者跳走不算）——審核佇列與巡接縫用來串下一筆。 */
  onEnd?: () => void;
}

/**
 * 播一段：從 startMs 播到 endMs 自動停（loop=true 則回頭重播）。
 * 期間 playback.preview 記錄狀態供 useSkipPlayback 與播放線疊層判斷。
 *
 * 收尾判斷走共用 ticker 每幀問一次 `rangeTick`，不是 `timeupdate` —— 那個事件只有 4 Hz，
 * 舊版拖選 3 秒按 Space 會多播最多 250 ms。尾端 30 ms 走音量斜坡（`previewGain` 的 "range"
 * 來源，與效果預聽相乘而不是互相覆蓋），避免在波形中間硬切出 click。
 *
 * 回傳停止函式，方便呼叫端串接（審核佇列 / 巡接縫）。
 */
export function playRange(startMs: number, endMs: number, opts: PlayRangeOptions): () => void {
  const p = el;
  if (!p || !p.src) return () => {};
  rangeStop?.();
  const loop = opts.loop === true;
  usePlayback.getState().setPreview({ startMs, endMs, skip: opts.skip });
  p.currentTime = Math.max(0, startMs) / 1000;

  let stopped = false;
  let started = false;
  let unTick: (() => void) | null = null;
  let endTimer: number | null = null;

  const stop = (natural: boolean, reason: RangeStopInfo["reason"] = natural ? "natural" : "manual") => {
    if (stopped) return;
    stopped = true;
    lastStop = { reason, atMs: p.currentTime * 1000, startMs, endMs };
    if (endTimer !== null) clearTimeout(endTimer);
    endTimer = null;
    unTick?.();
    p.removeEventListener("pause", onPause);
    p.removeEventListener("playing", onPlaying);
    rangeStop = null;
    usePlayback.getState().setPreview(null);
    if (!p.paused) p.pause();
    releaseGainSource("range");
    if (natural) opts.onEnd?.();
  };
  // 「還沒開始播就收到 pause」= 呼叫端在 playRange 之前剛 pause 過，那顆事件是非同步派發的、
  // 會晚一步打中我們剛掛上的監聽器，把這次播放當場殺掉（症狀：按下去完全沒聲音）。
  const onPause = () => {
    if (started) stop(false, "pause-event");
  };
  const onPlaying = () => {
    started = true;
  };

  const tick = () => {
    const cur = p.currentTime * 1000;
    switch (rangeTick(cur, startMs, endMs, loop)) {
      case "loop":
        p.currentTime = Math.max(0, startMs) / 1000;
        setGainSource("range", 1);
        return;
      case "stop":
        setGainSource("range", 0);
        stop(cur >= endMs, cur >= endMs ? "natural" : "left-range");
        return;
      default: {
        setGainSource("range", tailGain(cur, endMs, loop));
        // 只靠每幀輪詢，收尾會晚 30–50 ms（rAF 一幀 16.7 ms＋媒體時鐘本身量化到 ~20 ms）。
        // 進入尾端斜坡後改用 setTimeout 對準真正的結束時間，誤差降到個位數毫秒。
        if (!loop && endTimer === null) {
          const leftMs = (endMs - cur) / (p.playbackRate || 1);
          if (leftMs <= TAIL_RAMP_MS) {
            endTimer = setTimeout(() => {
              endTimer = null;
              const now = p.currentTime * 1000;
              // 使用者在這幾毫秒內往回跳了 → 交還給每幀輪詢
              if (now < endMs - TAIL_RAMP_MS) return;
              setGainSource("range", 0);
              stop(true, "natural");
            }, Math.max(0, leftMs));
          }
        }
      }
    }
  };

  unTick = subscribeTick(tick, TICK_PRIORITY.range);
  rangeStop = () => stop(false);
  p.addEventListener("pause", onPause);
  p.addEventListener("playing", onPlaying);
  void p
    .play()
    .then(() => {
      started = true;
    })
    .catch(() => stop(false, "play-rejected"));
  return () => stop(false);
}
