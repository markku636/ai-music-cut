// 把配樂試聽接上共用的每幀 ticker。
//
// 只在「有配樂 ∧ 正在播」的時候訂閱：ticker 沒有訂閱者才會停，長期掛著等於
// 暫停時也一直跑 rAF。暫停時位置不同步沒關係 —— 按下播放的第一幀就會校正回來。
//
// 位置一律從 `<audio>.currentTime` 現讀（不是 store）：store 的位置是上一幀寫進去的，
// 拿它對時會固定慢一幀，聽起來就是音樂永遠晚一點點。
import { useEffect } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Edl } from "../analysis/edl/build";
import { mapSrcToOut } from "../analysis/edl/map";
import type { Overlay } from "../analysis/overlays";
import { rolesInUse } from "../analysis/roles";
import { usePlayback } from "../store/playback";
import { useProject } from "../store/project";
import { useRoleMix } from "../store/roleMix";
import { mainGainFactor } from "./roleMix";
import { releaseGainSource, setGainSource } from "./previewGain";
import { setOverlaySrcResolver, stopAllOverlays, tickOverlays } from "./overlayMonitor";
import { getPlayer } from "./playerRef";
import { subscribeTick, TICK_PRIORITY } from "./ticker";

export function useOverlayMonitor(overlays: Overlay[], edl: Edl | null) {
  const playing = usePlayback((s) => s.playing);
  const mix = useRoleMix((s) => s.mix);

  // 角色被刪光時清掉殘留的獨奏 —— 不然畫面上什麼都沒獨奏卻整個安靜
  useEffect(() => {
    useRoleMix.getState().prune(rolesInUse(overlays));
  }, [overlays]);

  // 主聲軌的靜音走共用的增益層，跟效果 / A-B 比較同一條路
  useEffect(() => {
    const f = mainGainFactor(mix);
    if (f === 1) releaseGainSource("roles");
    else setGainSource("roles", f);
    return () => releaseGainSource("roles");
  }, [mix]);

  useEffect(() => {
    setOverlaySrcResolver((mediaId) => {
      const m = useProject.getState().media.find((x) => x.id === mediaId);
      return m ? convertFileSrc(m.path) : null;
    });
    return stopAllOverlays;
  }, []);

  useEffect(() => {
    if (!overlays.length || !playing) {
      stopAllOverlays();
      return;
    }
    const keeps = edl?.keeps ?? [];
    // 排在效果增益之後：這一層只讀播放位置，不碰主聲軌的音量
    const un = subscribeTick(() => {
      const el = getPlayer();
      if (!el) return;
      const srcMs = el.currentTime * 1000;
      const outMs = keeps.length ? mapSrcToOut(keeps, srcMs) : srcMs;
      tickOverlays(overlays, { outMs, playing: !el.paused, rate: el.playbackRate || 1, mix: useRoleMix.getState().mix });
    }, TICK_PRIORITY.effects + 1);
    return () => {
      un();
      stopAllOverlays();
    };
  }, [overlays, edl, playing]);
}
