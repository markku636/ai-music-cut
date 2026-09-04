// 單一 <audio> 元素的全域參考：讓快捷鍵 / 工具 / 時間軸不必透過 React 樹就能控制播放。
let el: HTMLAudioElement | null = null;

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
