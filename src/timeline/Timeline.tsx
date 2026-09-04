import { useEffect, useRef } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, { type Region } from "wavesurfer.js/dist/plugins/regions.esm.js";
import TimelinePlugin from "wavesurfer.js/dist/plugins/timeline.esm.js";
import HoverPlugin from "wavesurfer.js/dist/plugins/hover.esm.js";
import { wavesurferPeaks, type LocalAnalysis } from "../analysis/peaks";
import { isActiveState, type Candidate, type CandidateKind, type DecisionMap } from "../analysis/types";
import { getPlayer } from "../preview/playerRef";
import { usePlayback } from "../store/playback";
import { useTimeline } from "../store/timeline";
import { useTheme } from "../theme";
import { formatMs } from "../time";
import TimelinePlaceholder from "./TimelinePlaceholder";

/** 時間尺高度（TimelinePlugin，插在波形上方）。 */
export const RULER_H = 18;
const SEL_ID = "__sel";

function cssTriple(varName: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || "248 248 242";
}
function cssRgb(varName: string, alpha = 1): string {
  return `rgb(${cssTriple(varName).split(/\s+/).join(" ")} / ${alpha})`;
}

const KIND_VAR: Record<CandidateKind, string> = {
  filler: "--c-kind-filler",
  stutter: "--c-kind-stutter",
  restart: "--c-kind-stutter",
  long_pause: "--c-kind-pause",
  noise: "--c-kind-noise",
  unclear: "--c-kind-unclear",
  rambling: "--c-kind-unclear",
  off_topic: "--c-kind-unclear",
  redo: "--c-kind-unclear",
  manual: "--c-kind-manual",
};

function regionColor(c: Candidate, decisions: DecisionMap, selected: boolean): string {
  const st = decisions[c.id]?.state ?? "pending";
  const alpha = selected ? 0.55 : isActiveState(st) ? 0.36 : st === "pending" ? 0.14 : 0.04;
  return cssRgb(KIND_VAR[c.kind], alpha);
}

/** 狀態樣式直接寫在 region 元素上（regions 在 shadow DOM，CSS 進不去）：active 邊線、pending 虛框、rejected 淡出、選取內陰影。 */
function styleRegion(r: Region, c: Candidate, decisions: DecisionMap, selected: boolean, interactive: boolean) {
  const el = r.element;
  if (!el) return;
  const st = decisions[c.id]?.state ?? "pending";
  const kind = cssRgb(KIND_VAR[c.kind], 0.9);
  el.style.borderLeft = "";
  el.style.borderRight = "";
  el.style.outline = "";
  el.style.outlineOffset = "";
  el.style.opacity = "";
  el.style.boxShadow = "";
  if (isActiveState(st)) {
    el.style.borderLeft = `1px solid ${kind}`;
    el.style.borderRight = `1px solid ${kind}`;
  } else if (st === "pending") {
    el.style.outline = `1px dashed ${kind}`;
    el.style.outlineOffset = "-1px";
  } else el.style.opacity = "0.3";
  if (selected) el.style.boxShadow = `inset 0 0 0 2px ${cssRgb("--c-accent", 0.9)}`;
  el.style.pointerEvents = interactive ? "all" : "none";
  el.title = `${c.reason}\n${formatMs(c.startMs)} – ${formatMs(c.endMs)}`;
}

function styleSelection(r: Region) {
  const el = r.element;
  if (!el) return;
  el.style.backgroundColor = cssRgb("--c-accent", 0.18);
  el.style.outline = `1px solid ${cssRgb("--c-accent", 0.85)}`;
  el.style.outlineOffset = "-1px";
  el.style.zIndex = "4";
}

export interface TimelineProps {
  mediaId: string | null;
  analysis: LocalAnalysis | null;
  durationMs: number;
  height: number;
  candidates: Candidate[];
  decisions: DecisionMap;
  selectedIds: string[];
  onSelect: (id: string) => void;
  /** 雙擊候選：剪 ↔ 不剪。 */
  onToggle: (id: string) => void;
  /** 拉候選邊界後。 */
  onRangeChange: (id: string, startMs: number, endMs: number) => void;
  onRetry: () => void;
  onOpenSettings: (focus?: "key" | "ffmpeg") => void;
}

/**
 * 波形時間軸：wavesurfer 7 + 預算好的 peaks（不在 WebView 解碼）+ 共用 <audio>。
 * 首繪整段適配；時間尺 / 游標時間；Ctrl+滾輪以游標為錨縮放、放大後滾輪水平捲動；
 * 候選以 Regions 上色（類型色 × 狀態）可拉邊界；「選取」工具拖出時間選取（store.selection）供剪掉 / 只保留 / 播放。
 */
export default function Timeline(props: TimelineProps) {
  const { analysis, durationMs, height, candidates, decisions, selectedIds } = props;
  const boxRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsPlugin | null>(null);
  const regionMap = useRef(new Map<string, Region>());
  const selRegionRef = useRef<Region | null>(null);
  const disableDragRef = useRef<(() => void) | null>(null);
  const cb = useRef(props);
  cb.current = props;
  const themeId = useTheme((s) => s.themeId);
  const follow = usePlayback((s) => s.follow);
  const tool = useTimeline((s) => s.tool);
  const selection = useTimeline((s) => s.selection);
  const waveH = Math.max(40, height - 16 - RULER_H);

  // 建立 wavesurfer（analysis / 時長 / 主題變更時重建；重建時沿用縮放與播放位置）
  useEffect(() => {
    const box = boxRef.current;
    const media = getPlayer();
    if (!box || !analysis || !media) return;
    const durSec = Math.max(0.001, durationMs / 1000);
    const fitOf = () => Math.max(0.05, box.clientWidth / durSec);
    const tl = useTimeline.getState();
    tl.setFit(fitOf(), box.clientWidth);

    const regions = RegionsPlugin.create();
    const ruler = TimelinePlugin.create({
      height: RULER_H,
      insertPosition: "beforebegin",
      formatTimeCallback: (s) => formatMs(s * 1000, { millis: false }),
      secondaryLabelOpacity: 0.35,
      style: { color: cssRgb("--c-fg", 0.5), fontSize: "10px", fontFamily: "'JetBrains Mono Variable', ui-monospace, monospace" },
    });
    const hover = HoverPlugin.create({
      lineColor: cssRgb("--c-accent", 0.7),
      lineWidth: 1,
      labelColor: cssRgb("--c-fg", 0.95),
      labelBackground: cssRgb("--c-elevated", 0.95),
      labelSize: 11,
      formatTimeCallback: (s) => formatMs(s * 1000),
    });
    const ws = WaveSurfer.create({
      container: box,
      media,
      peaks: wavesurferPeaks(analysis),
      duration: durSec,
      height: Math.max(40, boxHeight(box) - RULER_H),
      waveColor: cssRgb("--c-fg", 0.55),
      progressColor: cssRgb("--c-accent", 0.8),
      cursorColor: cssRgb("--c-accent", 1),
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      minPxPerSec: tl.pxPerSec ?? fitOf(),
      fillParent: true,
      autoScroll: usePlayback.getState().follow,
      autoCenter: usePlayback.getState().follow,
      dragToSeek: tl.tool === "seek",
      hideScrollbar: false,
      normalize: false,
      plugins: [regions, ruler, hover],
    });
    wsRef.current = ws;
    regionsRef.current = regions;
    regionMap.current = new Map();
    selRegionRef.current = null;

    regions.on("region-created", (r) => {
      if (regionMap.current.has(r.id) || r === selRegionRef.current) return;
      // 拖曳選取（enableDragSelection）或本元件 addRegion 產生的選取 region
      const prev = selRegionRef.current;
      if (prev && prev !== r) prev.remove();
      selRegionRef.current = r;
      styleSelection(r);
      useTimeline.getState().setSelection({ startMs: r.start * 1000, endMs: r.end * 1000 });
      if (!useTimeline.getState().selection) {
        selRegionRef.current = null;
        r.remove();
      }
    });
    regions.on("region-updated", (r) => {
      if (r === selRegionRef.current) {
        useTimeline.getState().setSelection({ startMs: r.start * 1000, endMs: r.end * 1000 });
        return;
      }
      if (regionMap.current.get(r.id) === r) cb.current.onRangeChange(r.id, r.start * 1000, r.end * 1000);
    });
    regions.on("region-clicked", (r, e) => {
      e.stopPropagation();
      if (r === selRegionRef.current) {
        ws.setTime(r.start);
        return;
      }
      if (regionMap.current.has(r.id)) {
        cb.current.onSelect(r.id);
        ws.setTime(r.start);
      }
    });
    regions.on("region-double-clicked", (r, e) => {
      e.stopPropagation();
      if (regionMap.current.has(r.id)) cb.current.onToggle(r.id);
    });

    // store → wavesurfer：縮放（同步套用，wheel 錨定才算得準）與捲動請求
    const unsub = useTimeline.subscribe((s, prev) => {
      if (s.pxPerSec !== prev.pxPerSec || s.fitPxPerSec !== prev.fitPxPerSec) ws.zoom(s.pxPerSec ?? s.fitPxPerSec);
      if (s.scrollReq && s.scrollReq !== prev.scrollReq) ws.setScrollTime(s.scrollReq.ms / 1000);
    });
    ws.once("ready", () => {
      const s = useTimeline.getState();
      ws.zoom(s.pxPerSec ?? s.fitPxPerSec);
      if (s.pxPerSec !== null) ws.setScrollTime(usePlayback.getState().currentMs / 1000);
    });

    const onWheel = (e: WheelEvent) => {
      const s = useTimeline.getState();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const x = e.clientX - box.getBoundingClientRect().left;
        const cur = s.pxPerSec ?? s.fitPxPerSec;
        const tAt = (ws.getScroll() + x) / cur;
        s.zoomBy(e.deltaY < 0 ? 1.25 : 0.8);
        const n = useTimeline.getState();
        if (n.pxPerSec !== null) ws.setScroll(tAt * n.pxPerSec - x);
        return;
      }
      if (s.pxPerSec !== null) {
        e.preventDefault();
        ws.setScroll(ws.getScroll() + (e.deltaX || e.deltaY));
      }
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    const ro = new ResizeObserver(() => useTimeline.getState().setFit(fitOf(), box.clientWidth));
    ro.observe(box);

    return () => {
      ro.disconnect();
      unsub();
      box.removeEventListener("wheel", onWheel);
      disableDragRef.current?.();
      disableDragRef.current = null;
      ws.destroy();
      wsRef.current = null;
      regionsRef.current = null;
      regionMap.current = new Map();
      selRegionRef.current = null;
    };
    // height / candidates / tool / selection 由下面的 effect 動態調整
     
  }, [analysis, durationMs, themeId]);

  useEffect(() => {
    wsRef.current?.setOptions({ height: waveH });
  }, [waveH]);

  useEffect(() => {
    wsRef.current?.setOptions({ autoScroll: follow, autoCenter: follow });
  }, [follow]);

  // 工具：定位（拖曳 seek）↔ 選取（拖曳選一段；候選 region 暫時不吃滑鼠，才能從任何地方開始拖）
  useEffect(() => {
    const ws = wsRef.current;
    const regions = regionsRef.current;
    const box = boxRef.current;
    if (!ws || !regions || !box) return;
    ws.setOptions({ dragToSeek: tool === "seek" });
    disableDragRef.current?.();
    disableDragRef.current = null;
    if (tool === "select") {
      disableDragRef.current = regions.enableDragSelection({ color: cssRgb("--c-accent", 0.18), drag: true, resize: true }, 3);
    }
    box.style.cursor = tool === "select" ? "text" : "";
    for (const [id, r] of regionMap.current) {
      const c = candidates.find((x) => x.id === id);
      if (c) styleRegion(r, c, decisions, selectedIds.includes(id), tool === "seek");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, analysis, themeId]);

  // 候選 → regions（依 id 差分：新增 / 更新顏色與樣式 / 移除）
  useEffect(() => {
    const regions = regionsRef.current;
    if (!regions || !analysis) return;
    const map = regionMap.current;
    const seen = new Set<string>();
    for (const c of candidates) {
      seen.add(c.id);
      const selected = selectedIds.includes(c.id);
      const color = regionColor(c, decisions, selected);
      let r = map.get(c.id);
      if (r) {
        r.setOptions({ color });
        if (Math.abs(r.start * 1000 - c.startMs) > 1 || Math.abs(r.end * 1000 - c.endMs) > 1) r.setOptions({ start: c.startMs / 1000, end: c.endMs / 1000 });
      } else {
        r = regions.addRegion({ id: c.id, start: c.startMs / 1000, end: c.endMs / 1000, color, drag: false, resize: true });
        map.set(c.id, r);
      }
      styleRegion(r, c, decisions, selected, useTimeline.getState().tool === "seek");
    }
    for (const [id, r] of map) {
      if (!seen.has(id)) {
        r.remove();
        map.delete(id);
      }
    }
  }, [analysis, candidates, decisions, selectedIds, themeId]);

  // 時間選取（store）→ 選取 region
  useEffect(() => {
    const regions = regionsRef.current;
    if (!regions || !analysis) return;
    const cur = selRegionRef.current;
    if (!selection) {
      if (cur) {
        selRegionRef.current = null;
        cur.remove();
      }
      return;
    }
    const s = selection.startMs / 1000;
    const e = selection.endMs / 1000;
    if (cur) {
      if (Math.abs(cur.start - s) > 0.0005 || Math.abs(cur.end - e) > 0.0005) cur.setOptions({ start: s, end: e });
      return;
    }
    const r = regions.addRegion({ id: SEL_ID, start: s, end: e, color: cssRgb("--c-accent", 0.18), drag: true, resize: true });
    selRegionRef.current = r;
    styleSelection(r);
  }, [selection, analysis]);

  if (!analysis) {
    return <TimelinePlaceholder mediaId={props.mediaId} height={height} onRetry={props.onRetry} onOpenSettings={props.onOpenSettings} />;
  }
  return (
    <div className="h-full px-2 py-2 overflow-hidden" style={{ height }}>
      <div ref={boxRef} className="w-full h-full" />
    </div>
  );
}

/** 建立當下的可用高度（外層 py-2 = 16px 已扣在 box 上）。 */
function boxHeight(box: HTMLDivElement): number {
  return Math.max(56, box.clientHeight);
}
