import { useEffect } from "react";
import { effectGainAt, type AudioEffect } from "../analysis/effects";
import { usePlayback } from "../store/playback";
import { getPlayer } from "./playerRef";
import { releaseGainSource, setGainSource } from "./previewGain";
import { subscribeTick, TICK_PRIORITY } from "./ticker";

/**
 * 效果預聽：播放時依來源時間套用靜音 / 增益 / 淡入淡出。
 * 音量走 `previewGain` 的 "effect" 來源（與範圍播放的收尾斜坡相乘，不再互相覆蓋）。
 * 限制：volume 上限 1，正增益在預聽時只能維持 1（輸出時才真的放大）。
 */
export function useEffectPreview(effects: AudioEffect[]) {
  const playing = usePlayback((s) => s.playing);
  const currentMs = usePlayback((s) => s.currentMs);

  useEffect(() => {
    if (!effects.length) {
      releaseGainSource("effect");
      return;
    }
    const apply = () => {
      const el = getPlayer();
      if (el) setGainSource("effect", effectGainAt(effects, el.currentTime * 1000));
    };
    apply();
    if (!playing) return;
    return subscribeTick(apply, TICK_PRIORITY.effects);
  }, [effects, playing]);

  // 暫停時 scrub / seek 也要跟著更新（不必為此養一條每幀迴圈）。
  useEffect(() => {
    if (playing || !effects.length) return;
    const el = getPlayer();
    if (el) setGainSource("effect", effectGainAt(effects, el.currentTime * 1000));
  }, [currentMs, playing, effects]);

  useEffect(() => () => releaseGainSource("effect"), []);
}
