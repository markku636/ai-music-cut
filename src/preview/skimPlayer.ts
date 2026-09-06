import { convertFileSrc } from "@tauri-apps/api/core";
import { IDLE_SKIM, nextGrain, type SkimState } from "./skim";

/**
 * 滑過就聽得到：播放的那一半（決定何時播的那一半在 `skim.ts`）。
 *
 * 用**自己的** `<audio>`，不共用主聲軌那顆。共用的話滑鼠一動就會把播放位置弄掉，
 * 而且暫停 / 播放狀態會跟 store 打架 —— skim 是「偷聽一下」，不該改變任何狀態。
 */

let el: HTMLAudioElement | null = null;
let stopTimer: number | null = null;
let state: SkimState = IDLE_SKIM;
let srcPath: string | null = null;
/** 補時的次數上限：擋住「檔案播不動卻一直補時」變成無窮迴圈。 */
const MAX_REARM = 8;

function ensure(): HTMLAudioElement {
  if (!el) {
    el = new Audio();
    el.preload = "auto";
    el.volume = 0.9;
  }
  return el;
}

/** 換檔案時重設；同一個檔案重複呼叫不會重載（重載會讓第一段沒聲音）。 */
export function setSkimSource(path: string | null): void {
  if (path === srcPath) return;
  srcPath = path;
  stopSkim();
  const a = ensure();
  if (path) a.src = convertFileSrc(path);
  else a.removeAttribute("src");
}

/** 游標移到 `ms`。回傳有沒有真的播出一段（給測試與 UI 指示用）。 */
export function skimTo(ms: number, durationMs: number): boolean {
  if (!srcPath) return false;
  const r = nextGrain(state, ms, performance.now(), durationMs);
  if (!r) return false;
  state = r.state;
  const a = ensure();
  if (stopTimer !== null) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
  try {
    a.currentTime = r.grain.startMs / 1000;
  } catch {
    return false; // 還沒 seekable
  }
  const endSec = r.grain.endMs / 1000;
  const lenMs = r.grain.endMs - r.grain.startMs;

  // 用**媒體時間**收尾，不是用牆上時間。
  // 量出來的事實：play() 之後前 ~45 ms 音訊裝置在暖機，currentTime 完全不動 ——
  // 180 ms 的計時器只換到 140 ms 真正聽得到的內容。差這一截就是「聽不出是哪個字」。
  // 所以到期時先看媒體走到哪，沒走完就補時，走完才停。
  // 不用 timeupdate 事件：那每 250 ms 才一次，比整個 grain 還長。
  let left = MAX_REARM;
  const check = () => {
    if (a.currentTime >= endSec || a.paused || left-- <= 0) {
      a.pause();
      stopTimer = null;
      return;
    }
    stopTimer = window.setTimeout(check, Math.max(20, (endSec - a.currentTime) * 1000));
  };
  stopTimer = window.setTimeout(check, lenMs);
  void a.play().catch(() => {});
  return true;
}

/** 滑鼠離開波形 / 關掉功能 / 開始正式播放時呼叫。 */
export function stopSkim(): void {
  if (stopTimer !== null) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
  el?.pause();
  state = IDLE_SKIM;
}

/**
 * 目前 skim 元素的狀態。
 *
 * 存在的理由是「有沒有真的出聲」不能用 `skimTo` 的回傳值判斷 —— 它只說有沒有觸發，
 * 而 `play()` 是 promise，被自動播放政策擋掉時是靜默失敗的。煙霧測試要量的是這個。
 */
export function skimStatus(): { hasSrc: boolean; paused: boolean; currentTime: number; readyState: number } {
  const a = el;
  return {
    hasSrc: !!srcPath,
    paused: a ? a.paused : true,
    currentTime: a ? a.currentTime : -1,
    readyState: a ? a.readyState : -1,
  };
}

/** 測試用：把模組狀態清乾淨。 */
export function resetSkimForTest(): void {
  stopSkim();
  el = null;
  srcPath = null;
}
