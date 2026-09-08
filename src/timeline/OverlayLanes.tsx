// 配樂 / 音效軌：畫在波形下緣的兩條 lane，可拖曳移動、拖邊界修剪、右鍵設定。
//
// 一個座標軸的問題：波形是**來源時間**（你要看著它決定剪哪裡），但墊樂的位置是釘在
// **成品時間**上的（剪完之後的節目）。所以存的是 outStartMs，畫的時候用 mapOutToSrc
// 換回來源時間 —— 這樣音樂條會跟它實際蓋住的內容對齊，而不是漂在一個看不懂的位置。
// 拖曳時反過來，落點的來源時間用 mapSrcToOut 換成成品時間再存。
import { useEffect, useMemo, useRef, useState } from "react";
import type WaveSurfer from "wavesurfer.js";
import type { Edl } from "../analysis/edl/build";
import { mapOutToSrc } from "../analysis/edl/map";
import { envDbToY, envYToDb, LANE_LABEL, overlayLengthMs, resolveOverlays, type Overlay, type OverlayLane } from "../analysis/overlays";
import { useT } from "../i18n";
import { useTimeline } from "../store/timeline";
import { formatMs } from "../time";

const LANES: OverlayLane[] = ["music", "sfx"];
export const LANE_H = 34;

const LANE_STYLE: Record<OverlayLane, string> = {
  music: "bg-sky-500/25 border-sky-400/50 hover:bg-sky-500/35",
  sfx: "bg-emerald-500/25 border-emerald-400/50 hover:bg-emerald-500/35",
};

type DragKind = "move" | "in" | "out" | "point";

interface DragState {
  id: string;
  kind: DragKind;
  startX: number;
  startY: number;
  outStartMs: number;
  srcInMs: number;
  srcOutMs: number;
  deltaMs: number;
  /** kind = point 時：拖第幾個控制點，以及它現在的值。 */
  pointIndex?: number;
  pointMs?: number;
  pointDb?: number;
}

export default function OverlayLanes({
  ws,
  edl,
  overlays: rawOverlays,
  nameOf,
  onChange,
  onMenu,
}: {
  ws: WaveSurfer | null;
  edl: Edl | null;
  overlays: Overlay[];
  nameOf: (mediaId: string) => string;
  onChange: (id: string, patch: Partial<Overlay>, label: string) => void;
  onMenu: (o: Overlay, x: number, y: number) => void;
}) {
  const t = useT();
  // 錨在來源時間的 overlay（重錄這句 / 放進選取）：畫的位置每次都從 EDL 重算，剪掉前面的字它會跟著移
  const overlays = useMemo(() => resolveOverlays(rawOverlays, edl?.keeps ?? []), [rawOverlays, edl]);
  const pxPerSec = useTimeline((s) => s.pxPerSec);
  const fitPx = useTimeline((s) => s.fitPxPerSec);
  const [scroll, setScroll] = useState(0);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const overlaysRef = useRef(overlays);
  overlaysRef.current = overlays;
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
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const deltaMs = ((e.clientX - d.startX) / px) * 1000;
      if (d.kind !== "point" || d.pointIndex == null) {
        setDrag({ ...d, deltaMs });
        return;
      }
      const cur = overlaysRef.current.find((x) => x.id === d.id);
      const pts = cur?.points ?? [];
      const len = Math.max(1, (cur?.srcOutMs ?? 0) - (cur?.srcInMs ?? 0));
      const base = pts[d.pointIndex];
      if (!base) return;
      // 左右不能越過鄰居，否則排序之後控制點會互相穿過去
      const lo = d.pointIndex > 0 ? pts[d.pointIndex - 1].ms + 1 : 0;
      const hi = d.pointIndex < pts.length - 1 ? pts[d.pointIndex + 1].ms - 1 : len;
      const ms = Math.round(Math.min(hi, Math.max(lo, base.ms + deltaMs)));
      const db = envYToDb(envDbToY(base.db, LANE_H) + (e.clientY - d.startY), LANE_H);
      setDrag({ ...d, deltaMs, pointMs: ms, pointDb: db });
    };
    const onUp = () => {
      const d = dragRef.current;
      setDrag(null);
      if (!d) return;
      // 控制點常常是「只上下拖」（只改音量、時間不動），所以不能用水平位移當門檻 ——
      // 那會讓純垂直的拖曳整個被吃掉，看起來像拖不動。
      if (d.kind !== "point" && Math.abs(d.deltaMs) < 1) return;
      const delta = Math.round(d.deltaMs);
      if (d.kind === "point") {
        if (d.pointIndex == null) return;
        const cur = overlaysRef.current.find((x) => x.id === d.id);
        if (!cur?.points) return;
        const base = cur.points[d.pointIndex];
        const ms = d.pointMs ?? base.ms;
        const db = d.pointDb ?? base.db;
        if (base.ms === ms && base.db === db) return; // 沒動到就不要留一筆空的 undo
        const pts = cur.points.map((p, i) => (i === d.pointIndex ? { ms, db } : p)).sort((x, y) => x.ms - y.ms);
        onChange(d.id, { points: pts }, "調整音量控制點");
        return;
      }
      if (d.kind === "move") onChange(d.id, { outStartMs: Math.max(0, d.outStartMs + delta) }, "移動配樂");
      else if (d.kind === "in") onChange(d.id, { srcInMs: Math.max(0, Math.min(d.srcOutMs - 200, d.srcInMs + delta)) }, "修剪配樂");
      else onChange(d.id, { srcOutMs: Math.max(d.srcInMs + 200, d.srcOutMs + delta) }, "修剪配樂");
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, px, onChange]);

  if (!ws) return null;
  const width = ws.getWrapper()?.clientWidth ?? 0;
  const keeps = edl?.keeps ?? [];
  // 沒有 EDL（還沒探測）時就當作沒剪過：成品時間＝來源時間
  const outToSrc = (ms: number) => (keeps.length ? mapOutToSrc(keeps, ms) : ms);
  const xOf = (srcMs: number) => (srcMs / 1000) * px - scroll;

  return (
    <div className="absolute inset-x-0 bottom-0 z-[5]" style={{ height: LANE_H * LANES.length, pointerEvents: "none" }}>
      {LANES.map((lane, li) => {
        const items = overlays.filter((o) => o.lane === lane);
        return (
          <div key={lane} className="absolute inset-x-0" style={{ top: li * LANE_H, height: LANE_H }}>
            <div className="absolute inset-0 border-t border-fg/5 bg-app/35" />
            {items.length === 0 && (
              <span className="absolute left-1 top-0.5 text-[9px] text-fg/25 select-none">{t(LANE_LABEL[lane])}</span>
            )}
            {items.map((o) => {
              const d = drag?.id === o.id ? drag : null;
              const outStart = (d?.kind === "move" ? o.outStartMs + d.deltaMs : o.outStartMs) as number;
              const inMs = d?.kind === "in" ? o.srcInMs + d.deltaMs : o.srcInMs;
              const outMs = d?.kind === "out" ? o.srcOutMs + d.deltaMs : o.srcOutMs;
              const lenMs = Math.max(0, outMs - inMs);
              const x0 = xOf(outToSrc(outStart));
              const x1 = xOf(outToSrc(outStart + lenMs));
              const w = Math.max(3, x1 - x0);
              if (x1 < -20 || x0 > width + 20) return null;
              const label = `${nameOf(o.mediaId)}　${o.gainDb > 0 ? "+" : ""}${o.gainDb} dB${o.points?.length ? t("　閃避 {n} 點", { n: o.points.length }) : ""}`;
              return (
                <div
                  key={o.id}
                  className={`absolute top-0.5 bottom-0.5 rounded-sm border ${LANE_STYLE[lane]} overflow-hidden`}
                  style={{ left: x0, width: w, pointerEvents: "auto" }}
                  title={t("{label}　成品 {at} 起、長 {len}（拖曳移動 · 拖邊界修剪 · 右鍵更多）", {
                    label,
                    at: formatMs(o.outStartMs, { millis: false }),
                    len: formatMs(overlayLengthMs(o), { millis: false }),
                  })}
                  onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    // Alt+點：在這個位置補一個控制點（沒有曲線的話就從這裡開始畫）
                    if (e.altKey) {
                      const ms = Math.round(((e.clientX - rect.left) / Math.max(1, rect.width)) * lenMs);
                      const db = envYToDb(e.clientY - rect.top, LANE_H);
                      const next = [...(o.points ?? []), { ms, db }].sort((x, y) => x.ms - y.ms);
                      onChange(o.id, { points: next }, "新增音量控制點");
                      return;
                    }
                    const edge = 6;
                    const kind: DragKind = e.clientX - rect.left < edge ? "in" : rect.right - e.clientX < edge ? "out" : "move";
                    setDrag({ id: o.id, kind, startX: e.clientX, startY: e.clientY, outStartMs: o.outStartMs, srcInMs: o.srcInMs, srcOutMs: o.srcOutMs, deltaMs: 0 });
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onMenu(o, e.clientX, e.clientY);
                  }}
                >
                  <span className="absolute inset-y-0 left-0 w-1.5 cursor-w-resize bg-fg/10" />
                  <span className="absolute inset-y-0 right-0 w-1.5 cursor-e-resize bg-fg/10" />
                  <span className="block px-2 text-[9px] leading-[17px] whitespace-nowrap text-fg/75 select-none cursor-grab">{label}</span>
                  {/* 閃避曲線 + 可拖曳的控制點（Final Cut 的橡皮筋） */}
                  {o.points && o.points.length > 0 && w > 16 && (
                    <>
                      <svg className="absolute inset-0 pointer-events-none overflow-visible" width={w} height={LANE_H}>
                        <polyline
                          points={o.points.map((p) => `${((drag?.id === o.id && drag.kind === "point" && drag.pointIndex === o.points!.indexOf(p) ? drag.pointMs ?? p.ms : p.ms) / Math.max(1, lenMs)) * w},${envDbToY(drag?.id === o.id && drag.kind === "point" && drag.pointIndex === o.points!.indexOf(p) ? drag.pointDb ?? p.db : p.db, LANE_H)}`).join(" ")}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          className="text-amber-300/90"
                        />
                      </svg>
                      {o.points.map((p, pi) => {
                        const dragging = drag?.id === o.id && drag.kind === "point" && drag.pointIndex === pi;
                        const pms = dragging ? drag.pointMs ?? p.ms : p.ms;
                        const pdb = dragging ? drag.pointDb ?? p.db : p.db;
                        const cx = (pms / Math.max(1, lenMs)) * w;
                        if (cx < -6 || cx > w + 6) return null;
                        return (
                          <span
                            key={pi}
                            role="button"
                            tabIndex={-1}
                            title={t("控制點 {db} dB（上下拖曳改音量、左右拖曳改時間、右鍵移除）", { db: pdb })}
                            onMouseDown={(e) => {
                              if (e.button !== 0) return;
                              e.preventDefault();
                              e.stopPropagation();
                              setDrag({
                                id: o.id,
                                kind: "point",
                                startX: e.clientX,
                                startY: e.clientY,
                                outStartMs: o.outStartMs,
                                srcInMs: o.srcInMs,
                                srcOutMs: o.srcOutMs,
                                deltaMs: 0,
                                pointIndex: pi,
                                pointMs: p.ms,
                                pointDb: p.db,
                              });
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              onChange(o.id, { points: o.points!.filter((_, i) => i !== pi) }, "移除音量控制點");
                            }}
                            className={`absolute w-2 h-2 -ml-1 -mt-1 rounded-full border cursor-ns-resize ${dragging ? "bg-amber-300 border-amber-200" : "bg-amber-300/80 border-amber-200/70 hover:bg-amber-200"}`}
                            style={{ left: cx, top: envDbToY(pdb, LANE_H) }}
                          />
                        );
                      })}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      {drag && (
        <div className="absolute -top-5 left-1/2 -translate-x-1/2 rounded-sm bg-accent px-1 text-[10px] mono text-on-accent tabular-nums" style={{ pointerEvents: "none" }}>
          {drag.deltaMs >= 0 ? "+" : ""}
          {Math.round(drag.deltaMs)} ms
        </div>
      )}
    </div>
  );
}
