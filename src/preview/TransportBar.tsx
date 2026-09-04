import { Crosshair, FastForward, Pause, Play, Rewind, Scissors } from "lucide-react";
import { IconButton } from "../ui/index";
import { useT } from "../i18n";
import { usePlayback } from "../store/playback";
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
  const removedMs = cuts.reduce((s, c) => s + (c.endMs - c.startMs), 0);
  const editedNow = editedTimeAt(cuts, currentMs);

  return (
    <div className="h-10 shrink-0 flex items-center gap-1 px-2 border-b border-fg/10 bg-panel">
      <IconButton icon={Rewind} label={t("倒退 5 秒")} onClick={() => seekBy(-5000)} />
      <IconButton icon={playing ? Pause : Play} label={playing ? t("暫停") : t("播放")} iconSize={18} box="w-8 h-8" onClick={togglePlay} />
      <IconButton icon={FastForward} label={t("前進 5 秒")} onClick={() => seekBy(5000)} />
      <button type="button" onClick={() => setRate(RATES[(RATES.indexOf(rate) + 1) % RATES.length] ?? 1)} title={t("播放速率")} className="h-7 px-2 rounded-sm text-xs mono text-fg/70 hover:bg-fg/5">
        {rate}×
      </button>
      <span className="mono text-xs text-fg/70 ml-2 tabular-nums" title={t("原始時間 / 總長")}>
        {formatMs(currentMs)} <span className="text-fg/30">/ {formatMs(durationMs)}</span>
      </span>
      {cuts.length > 0 && (
        <span className="mono text-xs text-accent/80 ml-3 tabular-nums" title={t("剪後時間 / 剪後總長")}>
          ✂ {formatMs(editedNow, { millis: false })} <span className="text-fg/30">/ {formatMs(durationMs - removedMs, { millis: false })}</span>
        </span>
      )}
      <div className="ml-auto flex items-center gap-1">
        <IconButton icon={Scissors} label={skipEnabled ? t("跳過剪除區段（開）") : t("播放原始（跳過關）")} active={skipEnabled} onClick={toggleSkip} />
        <IconButton icon={Crosshair} label={t("跟隨播放位置")} active={follow} onClick={toggleFollow} />
      </div>
    </div>
  );
}
