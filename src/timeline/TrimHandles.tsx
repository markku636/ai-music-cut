// 修剪把手：在波形上抓接縫做漣漪 / 捲動修剪，以及顯示刀片切點。
//
// 用 DOM 疊層而不是 canvas —— 把手要吃滑鼠事件、要有游標形狀、要有 title。
// 切點的線在任何工具下都看得到（像 FCP 的編輯點），把手只有修剪工具作用中才出現。
import { useEffect, useRef, useState } from "react";
import type WaveSurfer from "wavesurfer.js";
import { useT } from "../i18n";
import { useTimeline } from "../store/timeline";
import { formatMs } from "../time";
import { trimSeam, type SeamInfo } from "./trimActions";

type DragKind = "roll" | "left" | "right";

interface DragState {
  seam: SeamInfo;
  kind: DragKind;
  startX: number;
  deltaMs: number;
}

/** 把手寬度（px）。太窄抓不到，太寬會蓋住波形。 */
const SIDE_W = 7;
const ROLL_W = 9;

export default function TrimHandles({ ws, height, seams, onOpenMenu }: { ws: WaveSurfer | null; height: number; seams: SeamInfo[]; onOpenMenu?: (seam: SeamInfo, x: number, y: number) => void }) {
  const t = useT();
  const tool = useTimeline((s) => s.tool);
  const pxPerSec = useTimeline((s) => s.pxPerSec);
  const fitPx = useTimeline((s) => s.fitPxPerSec);
  const [scroll, setScroll] = useState(0);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;

  const px = pxPerSec ?? fitPx;

  // wavesurfer 捲動 / 縮放時把手要跟著走
  useEffect(() => {
    if (!ws) return;
    const sync = () => setScroll(ws.getScroll());
    sync();
    const offs = [ws.on("scroll", sync), ws.on("zoom", sync), ws.on("redraw", sync), ws.on("redrawcomplete", sync)];
    return () => offs.forEach((f) => f());
  }, [ws]);

  // 拖曳：過程中只更新 ghost，放開才真的改一次 —— 每個 mousemove 都改的話
  // undo 歷史會被塞進幾百筆，按一次 Ctrl+Z 只退回一個像素。
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setDrag({ ...d, deltaMs: ((e.clientX - d.startX) / px) * 1000 });
    };
    const onUp = () => {
      const d = dragRef.current;
      setDrag(null);
      if (!d || Math.abs(d.deltaMs) < 1) return;
      trimSeam(d.seam.afterKeepId, Math.round(d.deltaMs), d.kind === "roll" ? "roll" : "ripple", d.kind === "right" ? "right" : "left");
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, px]);

  if (!ws || !seams.length) return null;
  const trimming = tool === "trim";
  const width = ws.getWrapper()?.clientWidth ?? 0;
  const xOf = (ms: number) => (ms / 1000) * px - scroll;

  return (
    <div className="absolute inset-0 z-[3]" style={{ pointerEvents: "none" }} aria-hidden={!trimming}>
      {seams.map((s) => {
        const x = xOf(s.srcBeforeMs);
        if (x < -20 || x > width + 20) return null;
        const isSplit = !!s.splitId;
        const dragging = drag?.seam.afterKeepId === s.afterKeepId;
        const label = isSplit
          ? s.gapMs > 0
            ? t("切點 · 留白 {ms} ms", { ms: Math.round(s.gapMs) })
            : t("切點 {at}", { at: formatMs(s.srcBeforeMs, { millis: true }) })
          : s.rearranged
            // 編排接縫兩邊來自來源的兩個地方，中間沒有剪掉東西 ——
            // 相減出來是負數，以前這裡就寫著「剪掉 -13000 ms」。
            ? t("編排接縫（貼上 / 搬移）· 這裡不能修剪，改用成品順序帶", { at: formatMs(s.srcBeforeMs, { millis: false }) })
            : t("接縫 {at} · 剪掉 {ms} ms", { at: formatMs(s.srcBeforeMs, { millis: false }), ms: Math.round(s.srcAfterMs - s.srcBeforeMs) });

        return (
          <div key={s.afterKeepId} className="absolute top-0" style={{ left: x, height }}>
            {/* 切點的線常駐；一般接縫只有修剪工具作用中才畫，不然會跟候選色塊的邊界打架 */}
            {(isSplit || s.rearranged || trimming) && (
              <div
                title={s.rearranged ? label : undefined}
                className={`absolute top-0 bottom-0 w-px ${isSplit ? (s.gapMs > 0 ? "bg-amber-400/70" : "bg-accent/60") : s.rearranged ? "bg-accent/70" : "bg-fg/25"}`}
                style={{ left: -0.5 }}
              />
            )}
            {isSplit && (
              <div
                className={`absolute -top-px h-1.5 w-1.5 rotate-45 ${s.gapMs > 0 ? "bg-amber-400/80" : "bg-accent/70"}`}
                style={{ left: -3 }}
              />
            )}
            {trimming && !s.rearranged && (
              <>
                <button
                  type="button"
                  title={t("{label} — 拖曳＝漣漪修剪（後面整串跟著位移）", { label })}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDrag({ seam: s, kind: "left", startX: e.clientX, deltaMs: 0 });
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onOpenMenu?.(s, e.clientX, e.clientY);
                  }}
                  className="absolute top-0 bottom-0 bg-fg/10 hover:bg-accent/35 cursor-w-resize"
                  style={{ left: -SIDE_W - ROLL_W / 2, width: SIDE_W, pointerEvents: "auto" }}
                />
                <button
                  type="button"
                  title={t("{label} — 拖曳＝捲動修剪（接縫左右一起動，成品總長不變）", { label })}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDrag({ seam: s, kind: "roll", startX: e.clientX, deltaMs: 0 });
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onOpenMenu?.(s, e.clientX, e.clientY);
                  }}
                  className="absolute top-0 bottom-0 bg-accent/25 hover:bg-accent/50 cursor-ew-resize"
                  style={{ left: -ROLL_W / 2, width: ROLL_W, pointerEvents: "auto" }}
                />
                <button
                  type="button"
                  title={t("{label} — 拖曳＝漣漪修剪（後面整串跟著位移）", { label })}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setDrag({ seam: s, kind: "right", startX: e.clientX, deltaMs: 0 });
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onOpenMenu?.(s, e.clientX, e.clientY);
                  }}
                  className="absolute top-0 bottom-0 bg-fg/10 hover:bg-accent/35 cursor-e-resize"
                  style={{ left: ROLL_W / 2, width: SIDE_W, pointerEvents: "auto" }}
                />
              </>
            )}
            {dragging && drag && (
              <>
                <div className="absolute top-0 bottom-0 w-px bg-accent" style={{ left: (drag.deltaMs / 1000) * px }} />
                <div
                  className="absolute -top-5 whitespace-nowrap rounded-sm bg-accent px-1 text-[10px] mono text-on-accent tabular-nums"
                  style={{ left: (drag.deltaMs / 1000) * px - 18 }}
                >
                  {drag.deltaMs >= 0 ? "+" : ""}
                  {Math.round(drag.deltaMs)} ms
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
