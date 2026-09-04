import { useEffect, useRef } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, { type Region } from "wavesurfer.js/dist/plugins/regions.esm.js";
import { wavesurferPeaks, type LocalAnalysis } from "../analysis/peaks";
import { isActiveState, type Candidate, type CandidateKind, type DecisionMap } from "../analysis/types";
import { useT } from "../i18n";
import { getPlayer } from "../preview/playerRef";
import { usePlayback } from "../store/playback";
import { useTheme } from "../theme";

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
  const alpha = selected ? 0.6 : isActiveState(st) ? 0.38 : st === "pending" ? 0.16 : 0.05;
  return cssRgb(KIND_VAR[c.kind], alpha);
}

export interface TimelineProps {
  analysis: LocalAnalysis | null;
  durationMs: number;
  height: number;
  candidates: Candidate[];
  decisions: DecisionMap;
  selectedIds: string[];
  onSelect: (id: string) => void;
}

/**
 * 波形時間軸：wavesurfer 7 + 預算好的 peaks（不在 WebView 解碼）+ 共用 <audio>（點擊即 seek）。
 * 候選以 Regions 上色（類型色 × 狀態透明度）；Ctrl+滾輪縮放；跟隨播放位置由 autoScroll 控制。
 */
export default function Timeline({ analysis, durationMs, height, candidates, decisions, selectedIds, onSelect }: TimelineProps) {
  const t = useT();
  const boxRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsPlugin | null>(null);
  const regionMap = useRef(new Map<string, Region>());
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const themeId = useTheme((s) => s.themeId);
  const follow = usePlayback((s) => s.follow);

  useEffect(() => {
    const box = boxRef.current;
    const media = getPlayer();
    if (!box || !analysis || !media) return;
    const regions = RegionsPlugin.create();
    const ws = WaveSurfer.create({
      container: box,
      media,
      peaks: wavesurferPeaks(analysis),
      duration: Math.max(0.001, durationMs / 1000),
      height: Math.max(40, height - 16),
      waveColor: cssRgb("--c-fg", 0.45),
      progressColor: cssRgb("--c-accent", 0.85),
      cursorColor: cssRgb("--c-accent", 1),
      cursorWidth: 2,
      barWidth: 0,
      minPxPerSec: 60,
      autoScroll: true,
      autoCenter: true,
      dragToSeek: true,
      hideScrollbar: false,
      normalize: false,
      plugins: [regions],
    });
    wsRef.current = ws;
    regionsRef.current = regions;
    regionMap.current = new Map();
    regions.on("region-clicked", (region, e) => {
      e.stopPropagation();
      onSelectRef.current(region.id);
      ws.setTime(region.start);
    });
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const cur = ws.options.minPxPerSec ?? 60;
      const next = Math.max(5, Math.min(1000, cur * (e.deltaY < 0 ? 1.25 : 0.8)));
      ws.zoom(next);
    };
    box.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      box.removeEventListener("wheel", onWheel);
      ws.destroy();
      wsRef.current = null;
      regionsRef.current = null;
      regionMap.current = new Map();
    };
    // height / candidates 由下面的 effect 動態調整
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis, durationMs]);

  useEffect(() => {
    wsRef.current?.setOptions({ height: Math.max(40, height - 16) });
  }, [height]);

  useEffect(() => {
    wsRef.current?.setOptions({
      waveColor: cssRgb("--c-fg", 0.45),
      progressColor: cssRgb("--c-accent", 0.85),
      cursorColor: cssRgb("--c-accent", 1),
    });
    for (const c of candidates) regionMap.current.get(c.id)?.setOptions({ color: regionColor(c, decisions, selectedIds.includes(c.id)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeId]);

  useEffect(() => {
    wsRef.current?.setOptions({ autoScroll: follow, autoCenter: follow });
  }, [follow]);

  // 候選 → regions（依 id 差分：新增 / 更新顏色 / 移除）
  useEffect(() => {
    const regions = regionsRef.current;
    if (!regions || !analysis) return;
    const map = regionMap.current;
    const seen = new Set<string>();
    for (const c of candidates) {
      seen.add(c.id);
      const color = regionColor(c, decisions, selectedIds.includes(c.id));
      const ex = map.get(c.id);
      if (ex) {
        ex.setOptions({ color });
        continue;
      }
      const r = regions.addRegion({ id: c.id, start: c.startMs / 1000, end: c.endMs / 1000, color, drag: false, resize: false });
      map.set(c.id, r);
    }
    for (const [id, r] of map) {
      if (!seen.has(id)) {
        r.remove();
        map.delete(id);
      }
    }
  }, [analysis, candidates, decisions, selectedIds]);

  if (!analysis) {
    return (
      <div className="h-full flex items-center justify-center text-xs text-fg/30" style={{ height }}>
        {t("時間軸（分析後顯示波形與候選區段）")}
      </div>
    );
  }
  return <div ref={boxRef} className="h-full px-2 py-2 overflow-hidden" style={{ height }} />;
}
