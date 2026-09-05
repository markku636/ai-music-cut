// 「剪後（成品）」用的第二個 <audio>。
//
// 為什麼不把 playerRef 改成雙元素登記表：Timeline 把 wavesurfer 綁在 getPlayer() 上
// （`media: getPlayer()`），一改成可切換的來源，切到剪後時波形會整個壞掉 —— 波形畫的是
// 原始檔，時間軸也是原始時間。所以來源播放器維持單一，成品預覽另外開一顆，
// 由 A-B 切換決定誰在響。
import { mapOutToSrc, mapSrcToOut } from "../analysis/edl/map";
import type { KeepSegment } from "../analysis/edl/build";
import { getPlayer, stopRange } from "./playerRef";

let cutEl: HTMLAudioElement | null = null;

export function setCutPlayer(e: HTMLAudioElement | null) {
  cutEl = e;
}

export function getCutPlayer(): HTMLAudioElement | null {
  return cutEl;
}

/** 目前哪一顆在響。 */
export type ActiveSource = "src" | "cut";
let active: ActiveSource = "src";

export function activeSource(): ActiveSource {
  return active;
}

/** 等功率淡接的長度（切換時避免 click）。 */
export const AB_RAMP_MS = 20;

/**
 * 等功率淡接曲線：淡入 sin、淡出 cos。
 * 用線性的話兩邊音量在交叉點各剩一半，合起來的功率會凹下去一個洞，聽起來像「咚」一下。
 */
export function abGain(progress: number, dir: "in" | "out"): number {
  const p = Math.max(0, Math.min(1, progress));
  const th = p * (Math.PI / 2);
  return dir === "in" ? Math.sin(th) : Math.cos(th);
}

function ramp(el: HTMLAudioElement, dir: "in" | "out", ms: number) {
  const steps = Math.max(1, Math.round(ms / 8));
  el.volume = abGain(0, dir);
  let i = 0;
  const tick = () => {
    i += 1;
    el.volume = abGain(i / steps, dir);
    if (i < steps) setTimeout(tick, 8);
  };
  setTimeout(tick, 8);
}

export interface SwitchOptions {
  keeps: KeepSegment[];
  /** 成品預覽檔的長度（用來夾住 seek）。 */
  cutDurationMs?: number | null;
}

/**
 * 切到另一個來源，並把位置換算過去（聽的人在意的是「同一句話」，不是「同一個秒數」）。
 * 回傳實際切到哪一個（沒有成品預覽檔時會留在 src）。
 */
export function switchTo(target: ActiveSource, opts: SwitchOptions): ActiveSource {
  const src = getPlayer();
  const cut = cutEl;
  if (!src) return active;
  if (target === "cut" && (!cut || !cut.src)) return active;
  if (target === active) return active;

  const wasPlaying = target === "cut" ? !src.paused : !!cut && !cut.paused;
  stopRange();

  if (target === "cut" && cut) {
    const outMs = mapSrcToOut(opts.keeps, src.currentTime * 1000);
    const dur = opts.cutDurationMs ?? (Number.isFinite(cut.duration) ? cut.duration * 1000 : Number.POSITIVE_INFINITY);
    cut.currentTime = Math.max(0, Math.min(dur - 1, outMs)) / 1000;
    cut.volume = 0;
    if (wasPlaying) void cut.play().catch(() => {});
    ramp(cut, "in", AB_RAMP_MS);
    ramp(src, "out", AB_RAMP_MS);
    setTimeout(() => src.pause(), AB_RAMP_MS + 16);
  } else if (cut) {
    const srcMs = mapOutToSrc(opts.keeps, cut.currentTime * 1000);
    src.currentTime = Math.max(0, srcMs) / 1000;
    src.volume = 0;
    if (wasPlaying) void src.play().catch(() => {});
    ramp(src, "in", AB_RAMP_MS);
    ramp(cut, "out", AB_RAMP_MS);
    setTimeout(() => cut.pause(), AB_RAMP_MS + 16);
  }
  active = target;
  return active;
}

/** 強制回到來源（換媒體 / 決策變動時）。 */
export function resetToSource() {
  const cut = cutEl;
  if (cut && !cut.paused) cut.pause();
  const src = getPlayer();
  if (src) src.volume = 1;
  active = "src";
}
