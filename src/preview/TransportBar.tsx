import { useEffect, useRef, useState } from "react";
import { Crosshair, FastForward, Maximize2, MousePointer2, Pause, Play, Rewind, Scissors, SquareDashed, ZoomIn, ZoomOut } from "lucide-react";
import { IconButton, Segmented } from "../ui/index";
import { useT } from "../i18n";
import { usePlayback } from "../store/playback";
import { useTimeline, type TimelineTool } from "../store/timeline";
import { formatMs } from "../time";
import { seekBy, togglePlay } from "./playerRef";
import { editedTimeAt, type Range } from "./skip";

const RATES = [1, 1.25, 1.5, 2];

export default function TransportBar({ durationMs, cuts }: { durationMs: number; cuts: Range[] }) {
  const t = useT();
  const playing = usePlayback((s) => s.playing);
  const currentMs = usePlayback((s) => s.currentMs);
  const rate = usePlayback((s) => s.rate);
  const setRate = usePlayback((s) => s.setRate);
  const skipEnabled = usePlayback((s) => s.skipEnabled);
  const toggleSkip = usePlayback((s) => s.toggleSkip);
  const follow = usePlayback((s) => s.follow);
  const toggleFollow = usePlayback((s) => s.toggleFollow);
  const pxPerSec = useTimeline((s) => s.pxPerSec);
  const zoomBy = useTimeline((s) => s.zoomBy);
  const fit = useTimeline((s) => s.fit);
  const tool = useTimeline((s) => s.tool);
  const setTool = useTimeline((s) => s.setTool);
  const removedMs = cuts.reduce((s, c) => s + (c.endMs - c.startMs), 0);
  const editedNow = editedTimeAt(cuts, currentMs);
  // 窄版（主區 < 620px）：工具切換只留圖示、縮放讀數收起，避免換行擠成兩三列
  const barRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 620));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={barRef} className="min-h-10 shrink-0 flex flex-wrap items-center gap-x-1 gap-y-0.5 px-2 py-1 border-b border-fg/10 bg-panel min-w-0">
      <IconButton icon={Rewind} label={t("倒退 5 秒")} onClick={() => seekBy(-5000)} />
      <IconButton icon={playing ? Pause : Play} label={playing ? t("暫停") : t("播放")} iconSize={18} box="w-8 h-8" onClick={togglePlay} />
      <IconButton icon={FastForward} label={t("前進 5 秒")} onClick={() => seekBy(5000)} />
      <button type="button" onClick={() => setRate(RATES[(RATES.indexOf(rate) + 1) % RATES.length] ?? 1)} title={t("播放速率")} className="h-7 px-2 rounded-sm text-xs mono text-fg/70 hover:bg-fg/5">
        {rate}×
      </button>
      <span className="mono text-xs text-fg/70 ml-2 tabular-nums whitespace-nowrap" title={t("原始時間 / 總長")}>
        {formatMs(currentMs)} <span className="text-fg/30">/ {formatMs(durationMs)}</span>
      </span>
      {cuts.length > 0 ? (
        <span className="mono text-xs text-accent/80 ml-3 tabular-nums whitespace-nowrap" title={t("剪後時間 / 剪後總長")}>
          ✂ {formatMs(editedNow, { millis: false })} <span className="text-fg/30">/ {formatMs(durationMs - removedMs, { millis: false })}</span>
        </span>
      ) : (
        durationMs > 0 && <span className="text-[11px] text-fg/35 ml-3 whitespace-nowrap">{t("原始（尚未剪）")}</span>
      )}
      <Segmented<TimelineTool>
        size="sm"
        className="ml-auto"
        value={tool}
        onChange={setTool}
        ariaLabel={t("時間軸工具")}
        options={[
          { value: "seek", label: narrow ? "" : t("定位"), icon: MousePointer2, title: t("定位：拖曳也是移動播放位置（V）") },
          { value: "select", label: narrow ? "" : t("選取"), icon: SquareDashed, title: t("選取（預設）：點一下定位、拖曳選一段，再播放 / 剪掉 / 只保留（S）") },
        ]}
      />
      <span className="flex items-center gap-0.5">
        <IconButton icon={ZoomOut} label={t("縮小（Ctrl+-）")} onClick={() => zoomBy(0.8)} disabled={pxPerSec === null} />
        {!narrow && (
          <button type="button" onClick={fit} title={t("目前縮放；點擊回到全長")} className="h-7 min-w-14 px-1.5 rounded-sm text-[11px] mono text-fg/60 hover:bg-fg/5 tabular-nums whitespace-nowrap">
            {pxPerSec === null ? t("全長") : `${Math.round(pxPerSec)} px/s`}
          </button>
        )}
        <IconButton icon={ZoomIn} label={t("放大（Ctrl+=）")} onClick={() => zoomBy(1.25)} />
        <IconButton icon={Maximize2} label={t("整段適配（Ctrl+0）")} active={pxPerSec === null} onClick={fit} />
      </span>
      <span className="flex items-center gap-0.5">
        <IconButton
          icon={Scissors}
          label={cuts.length ? (skipEnabled ? t("跳過剪除區段（開）") : t("播放原始（跳過關）")) : t("有剪除區段後可切換跳播")}
          active={skipEnabled && cuts.length > 0}
          disabled={!cuts.length}
          onClick={toggleSkip}
        />
        <IconButton icon={Crosshair} label={t("跟隨播放位置")} active={follow} onClick={toggleFollow} />
      </span>
    </div>
  );
}
