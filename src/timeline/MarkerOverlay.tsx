// 標記圖釘：畫在時間尺上，點一下跳過去、拖曳可以移動、右鍵有選單。
//
// 與拍線 / 播放線不同，這一層要吃滑鼠事件，所以用 DOM 而不是 canvas。
// 只畫可視範圍內的（40 分鐘的節目可以有上百個標記，全部掛 DOM 會拖慢捲動）。
import { useEffect, useRef, useState } from "react";
import type WaveSurfer from "wavesurfer.js";
import type { Marker } from "../analysis/types";
import { MARKER_KIND_LABEL } from "../analysis/types";
import { useT } from "../i18n";
import { usePlayback } from "../store/playback";
import { useTimeline } from "../store/timeline";
import { formatMs } from "../time";

const COLORS: Record<Marker["kind"], string> = {
  standard: "bg-fg/60",
  chapter: "bg-accent",
  todo: "bg-amber-400",
};

export default function MarkerOverlay({
  ws,
  markers,
  onMove,
  onMenu,
}: {
  ws: WaveSurfer | null;
  markers: Marker[];
  onMove: (id: string, ms: number) => void;
  onMenu: (marker: Marker, x: number, y: number) => void;
}) {
  const t = useT();
  const pxPerSec = useTimeline((s) => s.pxPerSec);
  const fitPx = useTimeline((s) => s.fitPxPerSec);
  const snapMs = useTimeline((s) => s.snapMs);
  const seek = usePlayback((s) => s.seek);
  const [scroll, setScroll] = useState(0);
  const [drag, setDrag] = useState<{ id: string; startX: number; startMs: number; ms: number } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const px = pxPerSec ?? fitPx;

  useEffect(() => {
    if (!ws) return;
    const sync = () => setScroll(ws.getScroll());
    sync();
    const offs = [ws.on("scroll", sync), ws.on("zoom", sync), ws.on("redraw", sync), ws.on("redrawcomplete", sync)];
    return () => offs.forEach((f) => f());
  }, [ws]);

  useEffect(() => {
    if (!drag) return;
    const onMoveEv = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setDrag({ ...d, ms: Math.max(0, d.startMs + ((e.clientX - d.startX) / px) * 1000) });
    };
    const onUp = () => {
      const d = dragRef.current;
      setDrag(null);
      if (!d || Math.abs(d.ms - d.startMs) < 1) return;
      onMove(d.id, snapMs(d.ms));
    };
    window.addEventListener("mousemove", onMoveEv);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMoveEv);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, px, onMove, snapMs]);

  if (!ws || !markers.length) return null;
  const width = ws.getWrapper()?.clientWidth ?? 0;

  return (
    <div className="absolute inset-x-0 top-0 h-4 z-[4]" style={{ pointerEvents: "none" }}>
      {markers.map((m) => {
        const ms = drag?.id === m.id ? drag.ms : m.ms;
        const x = (ms / 1000) * px - scroll;
        if (x < -12 || x > width + 12) return null;
        const label = `${MARKER_KIND_LABEL[m.kind]}　${formatMs(ms, { millis: false })}${m.title ? "　" + m.title : ""}`;
        return (
          <button
            key={m.id}
            type="button"
            title={t("{label}（拖曳移動 · 右鍵更多）", { label })}
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              e.stopPropagation();
              setDrag({ id: m.id, startX: e.clientX, startMs: m.ms, ms: m.ms });
            }}
            onClick={(e) => {
              e.stopPropagation();
              seek(m.ms);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onMenu(m, e.clientX, e.clientY);
            }}
            className="absolute top-0 -translate-x-1/2 flex flex-col items-center cursor-grab active:cursor-grabbing"
            style={{ left: x, pointerEvents: "auto" }}
          >
            <span className={`block w-2 h-2 rotate-45 ${COLORS[m.kind]} ${m.kind === "todo" && m.done ? "opacity-40" : ""}`} />
            <span className={`block w-px h-2.5 ${COLORS[m.kind]} opacity-60`} />
          </button>
        );
      })}
    </div>
  );
}
