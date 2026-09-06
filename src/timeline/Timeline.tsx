import { useEffect, useLayoutEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, { type Region } from "wavesurfer.js/dist/plugins/regions.esm.js";
import TimelinePlugin from "wavesurfer.js/dist/plugins/timeline.esm.js";
import HoverPlugin from "wavesurfer.js/dist/plugins/hover.esm.js";
import { effectLabel, type AudioEffect } from "../analysis/effects";
import type { Edl } from "../analysis/edl/build";
import type { Overlay } from "../analysis/overlays";
import { wavesurferPeaks, type LocalAnalysis } from "../analysis/peaks";
import { isActiveState, type Candidate, type CandidateKind, type DecisionMap, type Marker } from "../analysis/types";
import { getPlayer } from "../preview/playerRef";
import { setSkimSource, skimTo, stopSkim } from "../preview/skimPlayer";
import { usePlayback } from "../store/playback";
import { useProject } from "../store/project";
import { useTimeline } from "../store/timeline";
import { useTheme } from "../theme";
import { formatMs } from "../time";
import BeatGridOverlay from "./BeatGridOverlay";
import PlayheadOverlay from "./PlayheadOverlay";
import MarkerOverlay from "./MarkerOverlay";
import OverlayLanes from "./OverlayLanes";
import TrimHandles from "./TrimHandles";
import type { SeamInfo } from "./trimActions";
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
  const alpha = selected ? 0.34 : isActiveState(st) ? 0.36 : st === "pending" ? 0.14 : 0.04;
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

/** 右鍵選單需要的位置資訊（由 MainArea 決定選單內容）。 */
export interface WaveMenuInfo {
  x: number;
  y: number;
  /** 游標所在的來源時間。 */
  ms: number;
  candidateId: string | null;
  effectId: string | null;
}

function styleEffect(r: Region, e: AudioEffect) {
  const el = r.element;
  if (!el) return;
  const accent = cssTriple("--c-accent").split(/\s+/).join(" ");
  el.style.backgroundImage = "";
  el.style.backgroundColor = "transparent";
  el.style.outline = "";
  el.style.borderTop = `2px solid ${cssRgb(e.kind === "gain" ? "--c-warning" : e.kind === "mute" ? "--c-fg" : "--c-accent", 0.8)}`;
  el.style.zIndex = "3";
  switch (e.kind) {
    case "mute":
      el.style.backgroundImage = `repeating-linear-gradient(135deg, ${cssRgb("--c-fg", 0.16)} 0 4px, transparent 4px 9px)`;
      break;
    case "gain":
      el.style.backgroundColor = cssRgb("--c-warning", (e.db ?? 0) >= 0 ? 0.16 : 0.1);
      break;
    case "fade_in":
      el.style.backgroundImage = `linear-gradient(90deg, rgb(${accent} / 0), rgb(${accent} / 0.35))`;
      break;
    case "fade_out":
      el.style.backgroundImage = `linear-gradient(90deg, rgb(${accent} / 0.35), rgb(${accent} / 0))`;
      break;
  }
  const c = r.content;
  if (c) {
    c.style.fontSize = "10px";
    c.style.lineHeight = "1";
    c.style.padding = "2px 4px";
    c.style.color = cssRgb("--c-fg", 0.85);
    c.style.background = cssRgb("--c-elevated", 0.85);
    c.style.borderRadius = "3px";
    c.style.margin = "3px";
    c.style.whiteSpace = "nowrap";
  }
  el.title = `${effectLabel(e)} · ${formatMs(e.startMs)} – ${formatMs(e.endMs)}\n拖曳移動、拖邊緣調整範圍、右鍵移除`;
}

export interface TimelineProps {
  mediaId: string | null;
  effects: AudioEffect[];
  onEffectChange: (id: string, startMs: number, endMs: number) => void;
  onContextMenu: (info: WaveMenuInfo) => void;
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
  /** 目前 EDL 的接縫（修剪把手 / 切點記號）。 */
  seams: SeamInfo[];
  /** 右鍵接縫。 */
  onSeamMenu: (seam: SeamInfo, x: number, y: number) => void;
  markers: Marker[];
  onMarkerMove: (id: string, ms: number) => void;
  onMarkerMenu: (marker: Marker, x: number, y: number) => void;
  edl: Edl | null;
  overlays: Overlay[];
  mediaNameOf: (mediaId: string) => string;
  onOverlayChange: (id: string, patch: Partial<Overlay>, label: string) => void;
  onOverlayMenu: (o: Overlay, x: number, y: number) => void;
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
  const effectMap = useRef(new Map<string, Region>());
  const disableDragRef = useRef<(() => void) | null>(null);
  // 交給拍線疊層用（state 而非 ref：實例換掉要重新訂閱事件）
  const [wsInstance, setWsInstance] = useState<WaveSurfer | null>(null);
  const cb = useRef(props);
  cb.current = props;
  const themeId = useTheme((s) => s.themeId);
  const followMode = usePlayback((s) => s.followMode);
  const tool = useTimeline((s) => s.tool);
  const skim = useTimeline((s) => s.skim);
  const playing = usePlayback((s) => s.playing);
  const selection = useTimeline((s) => s.selection);
  const waveH = Math.max(40, height - 16 - RULER_H);

  // 建立 wavesurfer（analysis / 時長 / 主題變更時重建；重建時沿用縮放與播放位置）
  // useLayoutEffect：卸載時要在 React 移除 DOM 之前 destroy，否則 wavesurfer 的 removeChild 會丟例外
  useLayoutEffect(() => {
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
      progressColor: cssRgb("--c-fg", 0.72),
      cursorColor: "transparent",
      // 內建 cursor 停用：它畫在 .wrapper 裡會被 region 色塊蓋住，而且位置取自 media.duration
      // （我們餵給 wavesurfer 的是 ffprobe 時長），兩者不一致時會出現兩條線。改由 PlayheadOverlay 畫。
      cursorWidth: 0,
      barWidth: 2,
      barGap: 1,
      barRadius: 1,
      minPxPerSec: tl.pxPerSec ?? fitOf(),
      fillParent: true,
      // page 模式的翻頁由 PlayheadOverlay 負責（wavesurfer 只有 autoCenter 一種跟隨）
      autoScroll: usePlayback.getState().followMode === "center",
      autoCenter: usePlayback.getState().followMode === "center",
      dragToSeek: tl.tool === "seek",
      hideScrollbar: false,
      normalize: false,
      plugins: [regions, ruler, hover],
    });
    wsRef.current = ws;
    setWsInstance(ws);
    regionsRef.current = regions;
    regionMap.current = new Map();
    effectMap.current = new Map();
    selRegionRef.current = null;

    regions.on("region-created", (r) => {
      if (regionMap.current.has(r.id) || r.id.startsWith("fx:") || r === selRegionRef.current) return;
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
      if (r.id.startsWith("fx:")) {
        cb.current.onEffectChange(r.id.slice(3), r.start * 1000, r.end * 1000);
        return;
      }
      if (r === selRegionRef.current) {
        useTimeline.getState().setSelection({ startMs: r.start * 1000, endMs: r.end * 1000 });
        return;
      }
      if (regionMap.current.get(r.id) === r) cb.current.onRangeChange(r.id, r.start * 1000, r.end * 1000);
    });
    regions.on("region-clicked", (r, e) => {
      e.stopPropagation();
      if (r === selRegionRef.current || r.id.startsWith("fx:")) {
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
    const safeZoom = (px: number) => {
      if (ws.getDecodedData()) ws.zoom(px);
    };
    const unsub = useTimeline.subscribe((s, prev) => {
      if (s.pxPerSec !== prev.pxPerSec || s.fitPxPerSec !== prev.fitPxPerSec) safeZoom(s.pxPerSec ?? s.fitPxPerSec);
      if (s.scrollReq && s.scrollReq !== prev.scrollReq) ws.setScrollTime(s.scrollReq.ms / 1000);
    });
    ws.once("ready", () => {
      const s = useTimeline.getState();
      safeZoom(s.pxPerSec ?? s.fitPxPerSec);
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
      try {
        ws.destroy();
      } catch {
        /* 容器已被移除時 wavesurfer 會丟 removeChild 例外，忽略 */
      }
      wsRef.current = null;
      setWsInstance(null);
      regionsRef.current = null;
      regionMap.current = new Map();
      effectMap.current = new Map();
      selRegionRef.current = null;
    };
    // height / candidates / tool / selection 由下面的 effect 動態調整
     
  }, [analysis, durationMs, themeId]);

  useEffect(() => {
    wsRef.current?.setOptions({ height: waveH });
  }, [waveH]);

  useEffect(() => {
    const center = followMode === "center";
    wsRef.current?.setOptions({ autoScroll: center, autoCenter: center });
  }, [followMode]);

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

  // 效果 → regions（可拖曳 / 拉邊界，帶標籤）
  useEffect(() => {
    const regions = regionsRef.current;
    if (!regions || !analysis) return;
    const map = effectMap.current;
    const seen = new Set<string>();
    for (const e of props.effects) {
      const rid = `fx:${e.id}`;
      seen.add(rid);
      let r = map.get(rid);
      if (r) {
        if (Math.abs(r.start * 1000 - e.startMs) > 1 || Math.abs(r.end * 1000 - e.endMs) > 1) r.setOptions({ start: e.startMs / 1000, end: e.endMs / 1000 });
        r.setOptions({ content: effectLabel(e) });
      } else {
        r = regions.addRegion({ id: rid, start: e.startMs / 1000, end: e.endMs / 1000, color: "transparent", drag: true, resize: true, content: effectLabel(e) });
        map.set(rid, r);
      }
      styleEffect(r, e);
    }
    for (const [id, r] of map) {
      if (!seen.has(id)) {
        r.remove();
        map.delete(id);
      }
    }
  }, [analysis, props.effects, themeId]);

  useEffect(() => {
    const m = useProject.getState().media.find((x) => x.id === props.mediaId);
    setSkimSource(skim && !playing && m ? m.path : null);
    return stopSkim;
  }, [skim, playing, props.mediaId]);

  // 游標的 x → 來源時間（skim 與右鍵選單共用同一條換算）
  const msAtClientX = (clientX: number): number | null => {
    const ws = wsRef.current;
    const box = boxRef.current;
    if (!ws || !box) return null;
    const s = useTimeline.getState();
    const px = s.pxPerSec ?? s.fitPxPerSec;
    const x = clientX - box.getBoundingClientRect().left;
    return Math.max(0, Math.min(durationMs, ((ws.getScroll() + x) / px) * 1000));
  };

  // 滑過就聽得到。正在播的時候不做 —— 那會變成兩個聲音疊在一起
  const onPointerMove = (ev: React.PointerEvent<HTMLDivElement>) => {
    if (!skim || ev.buttons !== 0) return;
    const ms = msAtClientX(ev.clientX);
    if (ms !== null) skimTo(ms, durationMs);
  };

  const onContextMenu = (ev: React.MouseEvent<HTMLDivElement>) => {
    const ws = wsRef.current;
    const box = boxRef.current;
    if (!ws || !box) return;
    ev.preventDefault();
    const s = useTimeline.getState();
    const px = s.pxPerSec ?? s.fitPxPerSec;
    const x = ev.clientX - box.getBoundingClientRect().left;
    const ms = Math.max(0, Math.min(durationMs, ((ws.getScroll() + x) / px) * 1000));
    let candidateId: string | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const c of candidates) {
      if (c.startMs <= ms && ms <= c.endMs && c.endMs - c.startMs < best) {
        best = c.endMs - c.startMs;
        candidateId = c.id;
      }
    }
    const fx = props.effects.find((e) => e.startMs <= ms && ms <= e.endMs);
    cb.current.onContextMenu({ x: ev.clientX, y: ev.clientY, ms, candidateId, effectId: fx?.id ?? null });
  };

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

  const hint = tool === "select" && !selection && candidates.length === 0;

  if (!analysis) {
    return <TimelinePlaceholder mediaId={props.mediaId} height={height} onRetry={props.onRetry} onOpenSettings={props.onOpenSettings} />;
  }
  return (
    <div className="relative h-full px-2 py-2 overflow-hidden" style={{ height }}>
      <div className="relative w-full h-full">
        <div ref={boxRef} className="w-full h-full" onContextMenu={onContextMenu} onPointerMove={onPointerMove} onPointerLeave={stopSkim} />
        <BeatGridOverlay ws={wsInstance} height={waveH + RULER_H} />
        <TrimHandles ws={wsInstance} height={waveH + RULER_H} seams={props.seams} onOpenMenu={props.onSeamMenu} />
        <MarkerOverlay ws={wsInstance} markers={props.markers} onMove={props.onMarkerMove} onMenu={props.onMarkerMenu} />
        <OverlayLanes
          ws={wsInstance}
          edl={props.edl}
          overlays={props.overlays}
          nameOf={props.mediaNameOf}
          onChange={props.onOverlayChange}
          onMenu={props.onOverlayMenu}
        />
        <PlayheadOverlay ws={wsInstance} height={waveH + RULER_H} />
      </div>
      {hint && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <span className="text-[11px] text-fg/45 bg-well/85 px-2 py-1 rounded">在波形上拖曳選一段 → 播放 / 剪掉 / 只保留（右鍵有更多）</span>
        </div>
      )}
    </div>
  );
}

/** 建立當下的可用高度（外層 py-2 = 16px 已扣在 box 上）。 */
function boxHeight(box: HTMLDivElement): number {
  return Math.max(56, box.clientHeight);
}
