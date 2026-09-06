import { useEffect, useRef, useState } from "react";
import { Crosshair, FastForward, Hand, Maximize2, MousePointer2, MoveHorizontal, Music2, Pause, Play, Rewind, Scissors, SquareDashed, Target, Unlink, ZoomIn, ZoomOut } from "lucide-react";
import { IconButton, Segmented } from "../ui/index";
import { useT } from "../i18n";
import { usePlayback } from "../store/playback";
import { useTimeline, type TimelineTool } from "../store/timeline";
import { formatMs } from "../time";
import SnapMenu from "./SnapMenu";
import { nextShuttle, shuttleLabel, SHUTTLE_STOPPED } from "./shuttle";
import { togglePlaySelectionAware } from "./playerRef";
import { editedTimeAt, type Range } from "./skip";

const RATES = [1, 1.25, 1.5, 2];

export default function TransportBar({ durationMs, cuts }: { durationMs: number; cuts: Range[] }) {
  const t = useT();
  const playing = usePlayback((s) => s.playing);
  const currentMs = usePlayback((s) => s.currentMs);
  const rate = usePlayback((s) => s.rate);
  const setRate = usePlayback((s) => s.setRate);
  const shuttle = usePlayback((s) => s.shuttle);
  const setShuttle = usePlayback((s) => s.setShuttle);
  const skipEnabled = usePlayback((s) => s.skipEnabled);
  const toggleSkip = usePlayback((s) => s.toggleSkip);
  const followMode = usePlayback((s) => s.followMode);
  const cycleFollow = usePlayback((s) => s.cycleFollow);
  const pxPerSec = useTimeline((s) => s.pxPerSec);
  const zoomBy = useTimeline((s) => s.zoomBy);
  const fit = useTimeline((s) => s.fit);
  const tool = useTimeline((s) => s.tool);
  const beatGrid = useTimeline((s) => s.beatGrid);
  const showBeats = useTimeline((s) => s.showBeats);
  const toggleBeats = useTimeline((s) => s.toggleBeats);
  const scaleGrid = useTimeline((s) => s.scaleGrid);
  const setDownbeatAt = useTimeline((s) => s.setDownbeatAt);
  const tap = useTimeline((s) => s.tap);
  const setTool = useTimeline((s) => s.setTool);
  const removedMs = cuts.reduce((s, c) => s + (c.endMs - c.startMs), 0);
  const editedNow = editedTimeAt(cuts, currentMs);
  // 窄版（主區 < 620px）：工具切換只留圖示、縮放讀數收起，避免換行擠成兩三列
  const barRef = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 820));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={barRef} className="min-h-10 shrink-0 flex flex-wrap items-center gap-x-1 gap-y-0.5 px-2 py-1 border-b border-fg/10 bg-panel min-w-0">
      <IconButton
        icon={Rewind}
        label={t("倒退轉盤（J）—— 再點加速；倒退只移動播放線，沒有聲音")}
        active={shuttle.dir < 0}
        onClick={() => setShuttle(nextShuttle(shuttle, "J"))}
      />
      <IconButton
        icon={playing || shuttle.dir ? Pause : Play}
        label={playing || shuttle.dir ? t("暫停（K）") : t("播放")}
        iconSize={18}
        box="w-8 h-8"
        onClick={() => {
          if (shuttle.dir) setShuttle(SHUTTLE_STOPPED);
          else togglePlaySelectionAware();
        }}
      />
      <IconButton icon={FastForward} label={t("前進轉盤（L）—— 再點加速 1x / 2x / 4x")} active={shuttle.dir > 0} onClick={() => setShuttle(nextShuttle(shuttle, "L"))} />
      {shuttle.dir !== 0 && (
        <span
          className={`h-7 px-1.5 rounded-sm text-[11px] mono tabular-nums inline-flex items-center whitespace-nowrap ${shuttle.dir < 0 ? "bg-amber-400/15 text-amber-400" : "bg-accent/15 text-accent"}`}
          title={shuttle.dir < 0 ? t("倒退轉盤：只移動播放線，沒有聲音") : t("前進轉盤")}
        >
          {shuttleLabel(shuttle)}
        </span>
      )}
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
          { value: "trim", label: narrow ? "" : t("修剪"), icon: MoveHorizontal, title: t("修剪（T）：抓接縫左右推 —— 中間＝捲動（總長不變），兩側＝漣漪（後面跟著位移）") },
        ]}
      />
      <SnapMenu hasGrid={!!beatGrid} />
      {beatGrid && (
        <span className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={toggleBeats}
            title={t("顯示 / 隱藏拍線與小節線（偵測到 {bpm} BPM，信心 {c}%）", { bpm: beatGrid.bpm, c: Math.round(beatGrid.confidence * 100) })}
            className={`h-7 px-2 rounded-sm text-[11px] mono tabular-nums inline-flex items-center gap-1 whitespace-nowrap ${showBeats ? "bg-accent/15 text-accent" : "text-fg/55 hover:bg-fg/5"}`}
          >
            <Music2 size={13} />
            {narrow ? beatGrid.bpm : `${beatGrid.bpm} BPM`}
          </button>
          <button type="button" onClick={() => scaleGrid(0.5)} title={t("拍子太密 → 減半（÷2）")} className="h-7 px-1.5 rounded-sm text-[11px] mono text-fg/55 hover:bg-fg/5">
            ÷2
          </button>
          <button type="button" onClick={() => scaleGrid(2)} title={t("拍子太疏 → 加倍（×2）")} className="h-7 px-1.5 rounded-sm text-[11px] mono text-fg/55 hover:bg-fg/5">
            ×2
          </button>
          <IconButton icon={Target} label={t("把播放位置設為小節首拍")} onClick={() => setDownbeatAt(currentMs)} />
          <IconButton icon={Hand} label={t("跟著音樂點這顆抓速度（敲 3 下以上）")} onClick={() => tap(performance.now())} />
        </span>
      )}
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
        <IconButton
          icon={followMode === "off" ? Unlink : followMode === "center" ? Crosshair : Target}
          label={
            followMode === "page"
              ? t("跟隨：翻頁（線往右走，到邊緣才翻頁）")
              : followMode === "center"
                ? t("跟隨：置中（線固定在畫面中央，移動的是波形）")
                : t("跟隨：關閉（畫面不自動捲動）")
          }
          active={followMode !== "off"}
          onClick={cycleFollow}
        />
      </span>
    </div>
  );
}
