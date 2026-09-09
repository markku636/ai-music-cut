import { Crop, Play, Repeat, Scissors, Share2, Square, Star, TrendingDown, TrendingUp, VolumeX, X, ZoomIn } from "lucide-react";
import { useT } from "../i18n";
import { playRange, stopRange } from "../preview/playerRef";
import { useHighlights } from "../store/highlights";
import { openDialog } from "../store/dialogs";
import { usePlayback } from "../store/playback";
import { useProject } from "../store/project";
import { useTimeline } from "../store/timeline";
import type { UiMode } from "../store/ui";
import { formatMs } from "../time";
import { IconButton } from "../ui/index";
import { toast } from "../ui";
import { addEffectOnSelection, clearSelection, cutSelection, keepOnlySelection } from "./selectionActions";

/**
 * 浮在時間軸右下的選取動作列：範圍 / 長度、播放（可循環）、剪掉、只保留、靜音、淡入 / 淡出、縮放到選取、清除。
 * 沒有選取時不渲染。所有動作也在右鍵選單與快捷鍵（Space / Delete / Z / Esc）。
 * 簡易模式只留：範圍 · 播放 · 循環 | 剪掉 · 只留 | 清除。
 */
export default function SelectionBar({ variant = "pro" }: { variant?: UiMode }) {
  const t = useT();
  const simple = variant === "simple";
  const onExportRange = (startMs: number, endMs: number) => openDialog("render", { range: { startMs, endMs }, reel: null, reelBed: null });
  const selection = useTimeline((s) => s.selection);
  const loop = useTimeline((s) => s.loopSelection);
  const toggleLoop = useTimeline((s) => s.toggleLoop);
  const zoomToSelection = useTimeline((s) => s.zoomToSelection);
  const preview = usePlayback((s) => s.preview);
  const playing = usePlayback((s) => s.playing);
  if (!selection) return null;
  const isPlayingSel = playing && !!preview && preview.startMs === selection.startMs && preview.endMs === selection.endMs;
  const len = selection.endMs - selection.startMs;

  return (
    <div className="absolute bottom-2 right-3 z-20 flex items-center gap-0.5 pl-2 pr-1 h-8 rounded-md bg-elevated/95 border border-fg/10 shadow-e2 text-xs whitespace-nowrap" data-testid="selection-bar">
      <span className="mono text-fg/70 tabular-nums mr-1" title={t("選取範圍 · 長度")}>
        {formatMs(selection.startMs, { millis: false })}–{formatMs(selection.endMs, { millis: false })}
        <span className="text-accent ml-1.5">{(len / 1000).toFixed(2)}s</span>
      </span>
      <IconButton
        icon={isPlayingSel ? Square : Play}
        label={isPlayingSel ? t("停止") : t("播放選取（Space）")}
        active={isPlayingSel}
        onClick={() => (isPlayingSel ? stopRange() : playRange(selection.startMs, selection.endMs, { skip: false, loop: useTimeline.getState().loopSelection }))}
      />
      <IconButton icon={Repeat} label={t("循環播放選取")} active={loop} onClick={toggleLoop} />
      <span className="w-px h-4 bg-fg/10 mx-0.5" aria-hidden />
      <IconButton icon={Scissors} label={t("剪掉這段（Delete）")} className="text-danger" onClick={() => void cutSelection()} data-cmd="edit.cut" />
      {!simple && (
        <IconButton
          icon={Star}
          label={t("加進精華片段（之後可以串成一支預告）")}
          onClick={() => {
            const id = useProject.getState().activeMediaId;
            if (!id) return;
            useHighlights.getState().add(id, selection.startMs, selection.endMs);
            toast.success(t("已加進精華片段（共 {n} 段）").replace("{n}", String(useHighlights.getState().list(id).length)));
          }}
        />
      )}
      {!simple && <IconButton icon={Share2} label={t("只輸出這一段（社群短片；剪輯與配樂照舊，專案不動）")} onClick={() => onExportRange(selection.startMs, selection.endMs)} />}
      <IconButton icon={Crop} label={t("只保留這段（頭尾剪掉）")} onClick={() => void keepOnlySelection()} data-cmd="edit.keepOnly" />
      {!simple && (
        <>
          <span className="w-px h-4 bg-fg/10 mx-0.5" aria-hidden />
          <IconButton icon={VolumeX} label={t("靜音這段")} onClick={() => addEffectOnSelection("mute")} />
          <IconButton icon={TrendingUp} label={t("淡入")} onClick={() => addEffectOnSelection("fade_in")} />
          <IconButton icon={TrendingDown} label={t("淡出")} onClick={() => addEffectOnSelection("fade_out")} />
          <span className="w-px h-4 bg-fg/10 mx-0.5" aria-hidden />
          <IconButton icon={ZoomIn} label={t("縮放到選取（Z）")} onClick={zoomToSelection} />
        </>
      )}
      {simple && <span className="w-px h-4 bg-fg/10 mx-0.5" aria-hidden />}
      <IconButton icon={X} label={t("清除選取（Esc）")} onClick={clearSelection} />
    </div>
  );
}
