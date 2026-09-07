import { useEffect, useRef } from "react";
import type WaveSurfer from "wavesurfer.js";
import { speakerColor, type Speaker, type SpeakerTurn } from "../analysis/speakers";
import { useTimeline } from "../store/timeline";

/**
 * 講者色帶：波形下緣一條窄帶，誰在講就是誰的顏色。
 *
 * 逐字稿上已經看得到講者，但那要捲到那一句才知道。多人節目在**波形上**最想一眼看到的
 * 是「這一集的節奏長什麼樣」—— 誰講得久、哪裡是一來一往、哪裡是一個人講了八分鐘。
 * 那是一條色帶就能回答的問題，逐字稿回答不了。
 *
 * 兩個刻意的決定：
 * - **沒指派到的地方留白**，不要用前一個人的顏色補滿。留白就是「這裡沒人在講或分不出
 *   是誰」，那是真話；補滿會讓人以為那段是某個人講的。
 * - 太窄的段落至少畫 1px。40 分鐘縮到整頁時，一句「對」只有 0.3px，四捨五入就消失了 ——
 *   但那正是一來一往的節奏，全部不見的話色帶就只剩兩塊大色塊，看起來像沒在互動。
 */
export default function SpeakerRibbon({
  ws,
  turns,
  speakers,
  top,
  height = 4,
}: {
  ws: WaveSurfer | null;
  turns: SpeakerTurn[];
  speakers: Speaker[];
  /** 距離容器頂端多少 px（畫在波形下緣）。 */
  top: number;
  height?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const pxPerSec = useTimeline((s) => s.pxPerSec);
  const fit = useTimeline((s) => s.fitPxPerSec);

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !ws || !turns.length) return;
    let raf = 0;

    const colorOf = new Map(speakers.map((s) => [s.id, speakerColor(s.colorIndex)]));

    const draw = () => {
      raf = 0;
      const parent = cv.parentElement;
      if (!parent) return;
      const w = parent.clientWidth;
      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(height * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(height * dpr);
        cv.style.width = `${w}px`;
        cv.style.height = `${height}px`;
      }
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, height);

      const px = pxPerSec ?? fit;
      const scroll = ws.getScroll();
      const startMs = (scroll / px) * 1000;
      const endMs = ((scroll + w) / px) * 1000;

      for (const t of turns) {
        if (t.endMs <= startMs) continue;
        if (t.startMs >= endMs) break;
        const c = colorOf.get(t.speakerId);
        if (!c) continue;
        const x = (t.startMs / 1000) * px - scroll;
        // 一句「對」在整頁縮放下只有 0.3px —— 四捨五入會讓它消失，
        // 但那正是「一來一往」的節奏，不能全部不見
        const wpx = Math.max(1, ((t.endMs - t.startMs) / 1000) * px);
        ctx.fillStyle = c;
        ctx.fillRect(x, 0, wpx, height);
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
  }, [ws, turns, speakers, pxPerSec, fit, height]);

  if (!turns.length) return null;
  return <canvas ref={ref} className="pointer-events-none absolute left-0 z-10" style={{ top }} />;
}
