import { Pause, Play, Repeat, Scissors } from "lucide-react";
import { useT } from "../i18n";
import { usePlayback } from "../store/playback";
import { useTimeline } from "../store/timeline";
import { formatMs } from "../time";
import { IconButton } from "../ui/index";
import { togglePlaySelectionAware } from "./playerRef";
import { editedTimeAt, type Range } from "./skip";

/** 縮放滑桿的刻度：從整段適配到 MAX_PX_PER_SEC 之間取對數，拖起來兩端一樣靈敏。 */
const ZOOM_STEPS = 100;
const MAX_PX_PER_SEC = 500;

/**
 * 簡易模式的傳輸列：播放 / 暫停、時間、縮放滑桿、循環、聽剪掉後的結果。
 * 沒有 JKL、速率、吸附、角色、響度表、拍線、跟隨 —— 那些是專業的東西。
 */
export default function SimpleTransport({ durationMs, cuts }: { durationMs: number; cuts: Range[] }) {
  const t = useT();
  const playing = usePlayback((s) => s.playing);
  const currentMs = usePlayback((s) => s.currentMs);
  const skipEnabled = usePlayback((s) => s.skipEnabled);
  const toggleSkip = usePlayback((s) => s.toggleSkip);
  const pxPerSec = useTimeline((s) => s.pxPerSec);
  const fitPxPerSec = useTimeline((s) => s.fitPxPerSec);
  const setPxPerSec = useTimeline((s) => s.setPxPerSec);
  const fit = useTimeline((s) => s.fit);
  const loop = useTimeline((s) => s.loopSelection);
  const toggleLoop = useTimeline((s) => s.toggleLoop);
  const removedMs = cuts.reduce((s, c) => s + (c.endMs - c.startMs), 0);
  const editedNow = editedTimeAt(cuts, currentMs);

  const minPx = Math.max(0.01, fitPxPerSec);
  const ratio = Math.max(1, MAX_PX_PER_SEC / minPx);
  const zoomValue = pxPerSec === null ? 0 : Math.round((Math.log(pxPerSec / minPx) / Math.log(ratio)) * ZOOM_STEPS);
  const onZoom = (v: number) => {
    if (v <= 0) fit();
    else setPxPerSec(minPx * Math.pow(ratio, v / ZOOM_STEPS));
  };

  return (
    <div className="h-10 shrink-0 flex items-center gap-2 px-3 border-b border-fg/10 bg-panel min-w-0" data-testid="simple-transport">
      <IconButton icon={playing ? Pause : Play} label={playing ? t("暫停") : t("播放 / 暫停")} iconSize={18} box="w-8 h-8" onClick={togglePlaySelectionAware} data-cmd="playback.toggle" />
      <span className="mono text-xs text-fg/70 tabular-nums whitespace-nowrap">
        {formatMs(currentMs)} <span className="text-fg/30">/ {formatMs(durationMs)}</span>
      </span>
      {cuts.length > 0 && (
        <span className="mono text-[11px] text-accent/80 tabular-nums whitespace-nowrap" title={t("剪後時間 / 剪後總長")}>
          ✂ {formatMs(editedNow, { millis: false })} / {formatMs(durationMs - removedMs, { millis: false })}
        </span>
      )}
      <label className="ml-auto flex items-center gap-2 text-[11px] text-fg/50">
        {t("縮放")}
        <input type="range" min={0} max={ZOOM_STEPS} value={Math.max(0, Math.min(ZOOM_STEPS, zoomValue))} onChange={(e) => onZoom(Number(e.target.value))} className="w-28" aria-label={t("縮放")} />
      </label>
      <IconButton icon={Repeat} label={t("循環播放選取")} active={loop} onClick={toggleLoop} />
      {cuts.length > 0 && (
        <IconButton icon={Scissors} label={skipEnabled ? t("正在聽剪掉後的結果（點一下改聽原始）") : t("聽剪掉後的結果")} active={skipEnabled} onClick={toggleSkip} />
      )}
    </div>
  );
}
