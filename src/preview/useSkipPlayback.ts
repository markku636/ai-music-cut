import { useEffect } from "react";
import { usePlayback } from "../store/playback";
import { getPlayer } from "./playerRef";
import { cutIndexAt, nextCutStart, type Range } from "./skip";

const EPS_MS = 8;
const LOOKAHEAD_MS = 40;

/**
 * 跳播：播放中若游標落入剪除區 → seek 到區尾 +8 ms；接近剪除區起點 40 ms 內先跳（藏住尾音）。
 * scrub 進剪除區也貼到區尾。skipEnabled=false（播放原始）或預聽指定 skip=false 時停用。
 */
export function useSkipPlayback(cuts: Range[]) {
  const skipEnabled = usePlayback((s) => s.skipEnabled);
  const preview = usePlayback((s) => s.preview);
  const enabled = preview ? preview.skip : skipEnabled;
  useEffect(() => {
    const el = getPlayer();
    if (!el || !enabled || !cuts.length) return;
    let raf = 0;
    const check = (preemptive: boolean) => {
      if (el.seeking) return;
      const ms = el.currentTime * 1000;
      const i = cutIndexAt(cuts, ms);
      if (i >= 0) {
        el.currentTime = (cuts[i].endMs + EPS_MS) / 1000;
        return;
      }
      if (preemptive) {
        const ns = nextCutStart(cuts, ms);
        if (ns - ms < LOOKAHEAD_MS) {
          const j = cutIndexAt(cuts, ns);
          if (j >= 0) el.currentTime = (cuts[j].endMs + EPS_MS) / 1000;
        }
      }
    };
    const tick = () => {
      if (!el.paused) check(true);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const onSeeked = () => check(false);
    const onTime = () => {
      if (!el.paused) check(true);
    };
    el.addEventListener("seeked", onSeeked);
    el.addEventListener("timeupdate", onTime);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("seeked", onSeeked);
      el.removeEventListener("timeupdate", onTime);
    };
  }, [cuts, enabled]);
}
