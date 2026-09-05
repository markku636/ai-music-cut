// `<audio>.volume` 只有一個，但有三個東西想控制它：效果預聽（靜音 / 淡入淡出）、
// 範圍播放的收尾斜坡、之後的 A-B 切換等功率淡接。以前各寫各的、互相蓋掉 ——
// 淡出到一半切走，音量就永遠停在 0.3。這裡讓每個來源各自登記係數，最終音量取乘積。

export type GainSource = "effect" | "range" | "ab";

const gains: Record<GainSource, number> = { effect: 1, range: 1, ab: 1 };
let target: HTMLAudioElement | null = null;
let applied = -1;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 三個來源相乘後的最終音量。 */
export function currentGain(): number {
  return clamp01(gains.effect * gains.range * gains.ab);
}

function apply() {
  const el = target;
  if (!el) return;
  const v = currentGain();
  // 死區：避免每幀都寫 volume（部分瀏覽器寫入會觸發 volumechange 事件風暴）
  if (Math.abs(v - applied) > 0.002) {
    el.volume = v;
    applied = v;
  }
}

/** 綁定要控制音量的元素（AudioPlayer 掛載 / 卸載時呼叫）。 */
export function bindGainTarget(el: HTMLAudioElement | null) {
  target = el;
  applied = -1;
  apply();
}

/** 設定某個來源的增益係數（自動夾在 0–1）。 */
export function setGainSource(src: GainSource, v: number) {
  gains[src] = clamp01(v);
  apply();
}

/** 把某個來源放回 1（不再干預音量）。 */
export function releaseGainSource(src: GainSource) {
  setGainSource(src, 1);
}

/** 測試用：全部歸位。 */
export function __resetGains() {
  gains.effect = 1;
  gains.range = 1;
  gains.ab = 1;
  applied = -1;
}
