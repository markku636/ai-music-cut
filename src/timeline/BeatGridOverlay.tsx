import { useEffect, useRef } from "react";
import type WaveSurfer from "wavesurfer.js";
import { isDownbeat } from "../analysis/beats";
import { useTimeline } from "../store/timeline";

function cssRgb(varName: string, alpha = 1): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || "248 248 242";
  return `rgb(${v} / ${alpha})`;
}

/**
 * 拍線 / 小節線疊層：畫在波形上方的 canvas，只畫可視範圍，跟著 wavesurfer 的捲動與縮放重畫。
 * 小節第一拍畫實線（較亮），其餘拍點畫短刻度；縮太小（每拍 < 6px）只畫小節線。
 */
export default function BeatGridOverlay({ ws, height }: { ws: WaveSurfer | null; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const grid = useTimeline((s) => s.beatGrid);
  const show = useTimeline((s) => s.showBeats);
  const pxPerSec = useTimeline((s) => s.pxPerSec);
  const fit = useTimeline((s) => s.fitPxPerSec);

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !ws || !grid || !show) return;
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
      const scroll = ws.getScroll();
      const startMs = (scroll / px) * 1000;
      const endMs = ((scroll + w) / px) * 1000;
      const beatPx = (grid.periodMs / 1000) * px;
      const barsOnly = beatPx < 6;
      if (beatPx < 1.5) return; // 太密就別畫

      const beatColor = cssRgb("--c-fg", 0.18);
      const barColor = cssRgb("--c-accent", 0.5);
      const first = Math.floor((startMs - grid.offsetMs) / grid.periodMs);
      const last = Math.ceil((endMs - grid.offsetMs) / grid.periodMs);
      for (let k = first; k <= last; k++) {
        const ms = grid.offsetMs + k * grid.periodMs;
        if (ms < 0) continue;
        const down = isDownbeat(grid, ms);
        if (barsOnly && !down) continue;
        const x = Math.round((ms / 1000) * px - scroll) + 0.5;
        if (x < 0 || x > w) continue;
        ctx.beginPath();
        ctx.strokeStyle = down ? barColor : beatColor;
        ctx.lineWidth = 1;
        if (down) {
          ctx.moveTo(x, 0);
          ctx.lineTo(x, h);
        } else {
          ctx.moveTo(x, 0);
          ctx.lineTo(x, 6);
          ctx.moveTo(x, h - 6);
          ctx.lineTo(x, h);
        }
        ctx.stroke();
      }
    };

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    schedule();
    const offs = [ws.on("scroll", schedule), ws.on("zoom", schedule), ws.on("redraw", schedule), ws.on("redrawcomplete", schedule)];
    const ro = new ResizeObserver(schedule);
    if (cv.parentElement) ro.observe(cv.parentElement);
    return () => {
      cancelAnimationFrame(raf);
      offs.forEach((f) => f());
      ro.disconnect();
    };
  }, [ws, grid, show, height, pxPerSec, fit]);

  if (!grid || !show) return null;
  return <canvas ref={ref} className="absolute inset-0 pointer-events-none z-[2]" aria-hidden />;
}
