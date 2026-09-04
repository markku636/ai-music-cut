// 單一 <audio> 元素的全域參考：讓快捷鍵 / 工具 / 時間軸不必透過 React 樹就能控制播放。
import { usePlayback } from "../store/playback";

let el: HTMLAudioElement | null = null;
let rangeStop: (() => void) | null = null;

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

/**
 * 預聽一段：從 startMs 播到 endMs 自動停。skip=false → 播原始（聽建議段落本身）；
 * skip=true → 沿用跳播（聽剪掉後的接法）。期間 playback.preview 記錄狀態供 useSkipPlayback 判斷。
 */
export function playRange(startMs: number, endMs: number, opts: { skip: boolean }) {
  const p = el;
  if (!p || !p.src) return;
  rangeStop?.();
  const pb = usePlayback.getState();
  pb.setPreview({ startMs, endMs, skip: opts.skip });
  p.currentTime = Math.max(0, startMs) / 1000;
  const onTime = () => {
    if (p.currentTime * 1000 >= endMs) stop();
  };
  const stop = () => {
    p.removeEventListener("timeupdate", onTime);
    p.removeEventListener("pause", stop);
    rangeStop = null;
    usePlayback.getState().setPreview(null);
    if (!p.paused) p.pause();
  };
  rangeStop = stop;
  p.addEventListener("timeupdate", onTime);
  p.addEventListener("pause", stop);
  void p.play().catch(() => stop());
}
