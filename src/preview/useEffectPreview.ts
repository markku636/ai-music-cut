import { useEffect } from "react";
import { effectGainAt, type AudioEffect } from "../analysis/effects";
import { getPlayer } from "./playerRef";

/**
 * 效果預聽：播放時依來源時間套用靜音 / 增益 / 淡入淡出到 <audio>.volume。
 * 限制：volume 上限 1，正增益在預聽時只能維持 1（輸出時才真的放大）。
 */
export function useEffectPreview(effects: AudioEffect[]) {
  useEffect(() => {
    const el = getPlayer();
    if (!el) return;
    if (!effects.length) {
      el.volume = 1;
      return;
    }
    let raf = 0;
    let last = -1;
    const tick = () => {
      const v = Math.max(0, Math.min(1, effectGainAt(effects, el.currentTime * 1000)));
      if (Math.abs(v - last) > 0.002) {
        el.volume = v;
        last = v;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      el.volume = 1;
    };
  }, [effects]);
}
