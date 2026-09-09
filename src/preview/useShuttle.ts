// 轉盤驅動：把 shuttle.ts 的狀態變成 <audio> 的實際行為。
//
// 順向直接用 playbackRate（1 / 2 / 4 / 0.5 都在瀏覽器允許的範圍內）。
// 倒退**沒有辦法出聲** —— `<audio>` 不支援負的 playbackRate，MediaElement 也沒有反向解碼。
// 所以倒退時暫停元素、每幀把 currentTime 往回推，播放線照常移動但靜音；
// 這是刻意的取捨，UI 上用「◀◀ 2x（靜音）」講清楚，不要讓使用者以為是壞了。
import { useEffect } from "react";
import { usePlayback } from "../store/playback";
import { getPlayer } from "./playerRef";
import { SHUTTLE_STOPPED, type ShuttleState } from "./shuttle";
import { subscribeTick, TICK_PRIORITY } from "./ticker";

/** 倒退到 0 就停 —— 一直卡在開頭空轉沒有意義。 */
function reverseStep(el: HTMLAudioElement, rate: number, dtMs: number): boolean {
  const next = el.currentTime - (rate * dtMs) / 1000;
  if (next <= 0) {
    el.currentTime = 0;
    return false;
  }
  el.currentTime = next;
  return true;
}

export function useShuttle() {
  const shuttle = usePlayback((s) => s.shuttle);
  const setShuttle = usePlayback((s) => s.setShuttle);

  useEffect(() => {
    const el = getPlayer();
    if (!el) return;
    if (!shuttle.dir || !shuttle.rate) {
      // 停：回到一般播放的速率，避免下次按 Space 還在 4 倍速
      el.playbackRate = usePlayback.getState().rate;
      if (!el.paused) el.pause();
      return;
    }
    if (shuttle.dir > 0) {
      el.playbackRate = shuttle.rate;
      void el.play().catch(() => {});
      // 這裡**不需要** cleanup 還原速率：effect 的相依是 shuttle 本身，連按 L
      // （1x → 2x → 4x）時每一步都會先跑一次 cleanup，速率先彈回一般播放速率再設新的。
      // 停下來的還原由上面 `!shuttle.dir` 那一支負責，那是唯一真的要還原的時機。
      //
      // **那一彈不是效能問題** —— 本來以為它就是切速率時掉內容的原因，量了才知道不是：
      // 「直接設 4」與「先彈回 1 再設 4」在同一個元素上各跑四次，平均差 −229 vs −227 ms，
      // 完全在雜訊裡。真正的成本是媒體元素每次改速率都要重新同步一次
      // （約 57 ms 的來源時間，所以 4x 下每按一次少聽 230 ms），那個從 JS 這一層省不掉。
      // 拿掉這個 cleanup 只是因為它是一個沒有用途的中間狀態，不是因為它慢。
      return;
    }
    // 倒退：暫停元素，改用共用 ticker 推 currentTime
    el.pause();
    let last = performance.now();
    const un = subscribeTick(() => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      if (!reverseStep(el, shuttle.rate, dt)) setShuttle(SHUTTLE_STOPPED);
    }, TICK_PRIORITY.skip);
    return un;
  }, [shuttle, setShuttle]);
}

/** 給快捷鍵用：套用一次 J / K / L。 */
export function applyShuttle(next: ShuttleState) {
  usePlayback.getState().setShuttle(next);
}
