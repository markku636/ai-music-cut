import { useEffect, useRef } from "react";
import type WaveSurfer from "wavesurfer.js";
import { getPlayer } from "../preview/playerRef";
import { subscribeTick, TICK_PRIORITY } from "../preview/ticker";
import { usePlayback } from "../store/playback";
import { useTimeline } from "../store/timeline";
import { isVisibleX, pageScroll, playheadX } from "./playhead";

function cssRgb(varName: string, alpha = 1): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || "248 248 242";
  return `rgb(${v} / ${alpha})`;
}

/**
 * 播放線疊層。為什麼不用 wavesurfer 內建 cursor：
 * ① 它畫在 `.wrapper`（z-index 2 的原子堆疊脈絡）裡面，被 region 的半透明色塊蓋掉；
 * ② 它的位置來自 `media.duration`，而我們用 ffprobe 的時長餵 wavesurfer，兩者不一致時會出現兩條線；
 * ③ 沒有辦法畫選取播放的起訖旗標。
 *
 * 這層是 z-[3] 的 canvas，畫在 region 之上，只畫可視範圍，並負責 followMode="page" 的翻頁跟隨。
 * 播放中走共用 ticker 的最後一個 priority（跳播已經把位置修好才輪到畫）；暫停時只在
 * 捲動 / 縮放 / seek 時重畫。
 */
export default function PlayheadOverlay({ ws, height }: { ws: WaveSurfer | null; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const scheduleRef = useRef<(() => void) | null>(null);
  const draggingRef = useRef(false);
  /** 上一次畫的位置：用來分辨「播放位置動了」與「使用者自己捲動」。 */
  const lastMsRef = useRef(-1);
  const playing = usePlayback((s) => s.playing);
  const currentMs = usePlayback((s) => s.currentMs);
  const preview = usePlayback((s) => s.preview);
  const followMode = usePlayback((s) => s.followMode);
  const pxPerSec = useTimeline((s) => s.pxPerSec);
  const fit = useTimeline((s) => s.fitPxPerSec);

  // 拖曳（拉選取 / 拖捲軸）期間不自動翻頁，否則手一按畫面就跑掉。
  useEffect(() => {
    const down = () => {
      draggingRef.current = true;
    };
    const up = () => {
      draggingRef.current = false;
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
  }, []);

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !ws) return;
    let raf = 0;

    const draw = () => {
      raf = 0;
      const parent = cv.parentElement;
      if (!parent) return;
      const w = parent.clientWidth;
      const h = height;
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
        cv.style.width = `${w}px`;
        cv.style.height = `${h}px`;
      }
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const px = pxPerSec ?? fit;
      const el = getPlayer();
      const ms = el ? el.currentTime * 1000 : usePlayback.getState().currentMs;
      let scroll = ws.getScroll();

      // page 模式的跟隨：wavesurfer 只有 autoCenter 一種，翻頁要自己來。
      // 位置沒動（重畫來自使用者捲動 / 縮放）就完全不插手，否則會把使用者捲走的畫面硬拉回來。
      const moved = Math.abs(ms - lastMsRef.current) > 0.5;
      lastMsRef.current = ms;
      if (followMode === "page" && !draggingRef.current && !document.hidden) {
        const maxScroll = Math.max(0, ws.getDuration() * px - w);
        const x0 = playheadX(ms, px, scroll);
        if (moved && !isVisibleX(x0, w, 0)) {
          // seek 到畫面外（點逐字稿 / 拉時間軸）→ 直接把線帶到左側 1/4，別一頁一頁爬過去
          const next = Math.max(0, Math.min(maxScroll, (ms / 1000) * px - w * 0.25));
          if (Math.abs(next - scroll) > 0.5) {
            ws.setScroll(next);
            scroll = next;
          }
        } else if (el && !el.paused) {
          const next = pageScroll(x0, w, scroll, maxScroll);
          if (next !== null) {
            ws.setScroll(next);
            scroll = next;
          }
        }
      }

      // 選取 / 預聽範圍：淡色底 + 起訖旗標，讓人知道這次只會播這一段
      const pv = usePlayback.getState().preview;
      if (pv) {
        const xs = playheadX(pv.startMs, px, scroll);
        const xe = playheadX(pv.endMs, px, scroll);
        const l = Math.max(0, xs);
        const r = Math.min(w, xe);
        if (r > l) {
          ctx.fillStyle = cssRgb("--c-accent", 0.08);
          ctx.fillRect(l, 0, r - l, h);
        }
        ctx.strokeStyle = cssRgb("--c-accent", 0.45);
        ctx.lineWidth = 1;
        for (const fx of [xs, xe]) {
          if (!isVisibleX(fx, w)) continue;
          const x = Math.round(fx) + 0.5;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, h);
          ctx.stroke();
        }
      }

      const hx = playheadX(ms, px, scroll);
      if (!isVisibleX(hx, w)) return;
      const x = Math.round(hx) + 0.5;
      // 拍線也是 accent 色，所以播放線要靠「深色暈圈 + 2px 亮線 + 上下把手」三件事才分得出來。
      ctx.strokeStyle = cssRgb("--c-app", 0.92);
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.strokeStyle = cssRgb("--c-accent", 1);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
      // 上下三角把手（一眼分辨播放線 / 拍線 / 滑鼠 hover 線）
      ctx.fillStyle = cssRgb("--c-accent", 1);
      for (const [tipY, baseY] of [
        [9, 0],
        [h - 9, h],
      ]) {
        ctx.beginPath();
        ctx.moveTo(x - 6, baseY);
        ctx.lineTo(x + 6, baseY);
        ctx.lineTo(x, tipY);
        ctx.closePath();
        ctx.fill();
      }
    };

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    scheduleRef.current = schedule;
    schedule();
    const offs = [ws.on("scroll", schedule), ws.on("zoom", schedule), ws.on("redraw", schedule), ws.on("redrawcomplete", schedule)];
    const ro = new ResizeObserver(schedule);
    if (cv.parentElement) ro.observe(cv.parentElement);
    // 播放中改走共用 ticker：draw 排在最後，跳播已經把位置修好才輪到畫。
    const unTick = playing ? subscribeTick(draw, TICK_PRIORITY.draw) : null;
    return () => {
      cancelAnimationFrame(raf);
      offs.forEach((f) => f());
      ro.disconnect();
      unTick?.();
      scheduleRef.current = null;
    };
  }, [ws, height, pxPerSec, fit, playing, followMode, preview]);

  // 暫停時（seek / scrub）也要跟著動。
  useEffect(() => {
    if (!playing) scheduleRef.current?.();
  }, [currentMs, playing]);

  if (!ws) return null;
  return <canvas ref={ref} className="absolute inset-0 pointer-events-none z-[3]" aria-hidden />;
}
