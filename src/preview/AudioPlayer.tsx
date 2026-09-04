import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { usePlayback } from "../store/playback";
import { setPlayer } from "./playerRef";

/**
 * 隱藏的 <audio>：來源走 Tauri asset protocol（支援 Range → seek）。
 * 播放位置以 rAF 迴圈回寫 playback store（timeupdate 只有 4Hz，游標會頓）。
 */
export default function AudioPlayer({ path }: { path: string | null }) {
  const ref = useRef<HTMLAudioElement>(null);
  const seekReq = usePlayback((s) => s.seekReq);
  const rate = usePlayback((s) => s.rate);

  useEffect(() => {
    setPlayer(ref.current);
    return () => setPlayer(null);
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
    let raf = 0;
    const tick = () => {
      pb.setCurrent(el.currentTime * 1000);
      if (!el.paused) raf = requestAnimationFrame(tick);
    };
    const onPlay = () => {
      pb.setPlaying(true);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    };
    const onPause = () => {
      pb.setPlaying(false);
      cancelAnimationFrame(raf);
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
      cancelAnimationFrame(raf);
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
