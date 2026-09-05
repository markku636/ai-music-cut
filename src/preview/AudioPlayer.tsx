import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { usePlayback } from "../store/playback";
import { setPlayer } from "./playerRef";
import { bindGainTarget } from "./previewGain";
import { subscribeTick, TICK_PRIORITY } from "./ticker";

/**
 * 隱藏的 <audio>：來源走 Tauri asset protocol（支援 Range → seek）。
 * 播放位置以共用 ticker 回寫 playback store（timeupdate 只有 4Hz，游標會頓）；
 * 排在跳播與效果之後、播放線之前，所以 store 讀到的一定是這一幀的最終位置。
 */
export default function AudioPlayer({ path }: { path: string | null }) {
  const ref = useRef<HTMLAudioElement>(null);
  const seekReq = usePlayback((s) => s.seekReq);
  const rate = usePlayback((s) => s.rate);

  useEffect(() => {
    setPlayer(ref.current);
    bindGainTarget(ref.current);
    return () => {
      setPlayer(null);
      bindGainTarget(null);
    };
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || !seekReq) return;
    el.currentTime = seekReq.ms / 1000;
  }, [seekReq]);

  useEffect(() => {
    const el = ref.current;
    if (el) el.playbackRate = rate;
  }, [rate]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pb = usePlayback.getState();
    let unTick: (() => void) | null = null;
    const tick = () => pb.setCurrent(el.currentTime * 1000);
    const onPlay = () => {
      pb.setPlaying(true);
      unTick?.();
      unTick = subscribeTick(tick, TICK_PRIORITY.store);
    };
    const onPause = () => {
      pb.setPlaying(false);
      unTick?.();
      unTick = null;
      pb.setCurrent(el.currentTime * 1000);
    };
    const onTime = () => {
      if (el.paused) pb.setCurrent(el.currentTime * 1000);
    };
    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onPause);
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("seeked", onTime);
    return () => {
      unTick?.();
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onPause);
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("seeked", onTime);
    };
  }, [path]);

  // 換來源時歸零。
  useEffect(() => {
    usePlayback.getState().setCurrent(0);
    usePlayback.getState().setPlaying(false);
  }, [path]);

  return <audio ref={ref} src={path ? convertFileSrc(path) : undefined} preload="auto" className="hidden" />;
}
