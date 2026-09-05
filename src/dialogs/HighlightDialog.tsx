import { useMemo, useState } from "react";
import { Play, Scissors, SquareDashed, Zap } from "lucide-react";
import { effectId } from "../analysis/effects";
import { findHighlight, HIGHLIGHT_LENGTHS } from "../analysis/highlight";
import { Badge, Button, EmptyState, Modal, Segmented } from "../ui/index";
import { useT } from "../i18n";
import { playRange } from "../preview/playerRef";
import { useDecisions } from "../store/decisions";
import { usePlayback } from "../store/playback";
import { useTimeline } from "../store/timeline";
import { useTranscript } from "../store/transcript";
import { keepOnlySelection } from "../timeline/selectionActions";
import { formatMs } from "../time";

/**
 * 自動精華片段：AI 依能量與律動挑出「最像副歌」的一段，對齊小節線切成 15 / 30 / 60 / 90 秒。
 * 人機協作：機器只提議，使用者先聽、再決定要「只選起來自己調」還是「只保留這段」。
 */
export default function HighlightDialog({ mediaId, onClose }: { mediaId: string; onClose: () => void }) {
  const t = useT();
  const local = useTranscript((s) => s.local[mediaId] ?? null);
  const beatGrid = useTimeline((s) => s.beatGrid);
  const setSelection = useTimeline((s) => s.setSelection);
  const seek = usePlayback((s) => s.seek);
  const addEffect = useDecisions((s) => s.addEffect);
  const [len, setLen] = useState<string>("30");
  const [fade, setFade] = useState(true);

  const hl = useMemo(() => (local ? findHighlight(local, { targetMs: Number(len) * 1000, beats: beatGrid }) : null), [local, len, beatGrid]);

  const apply = (keepOnly: boolean) => {
    if (!hl) return;
    setSelection({ startMs: hl.startMs, endMs: hl.endMs });
    seek(hl.startMs);
    if (keepOnly) {
      keepOnlySelection();
      if (fade) {
        const inMs = Math.min(1200, (hl.endMs - hl.startMs) / 8);
        const outMs = Math.min(2000, (hl.endMs - hl.startMs) / 6);
        addEffect(mediaId, { id: effectId("fade_in", hl.startMs, hl.startMs + inMs), kind: "fade_in", startMs: hl.startMs, endMs: hl.startMs + inMs });
        addEffect(mediaId, { id: effectId("fade_out", hl.endMs - outMs, hl.endMs), kind: "fade_out", startMs: hl.endMs - outMs, endMs: hl.endMs });
      }
    }
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={t("自動精華片段")}
      icon={Zap}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("關閉")}
          </Button>
          <Button icon={SquareDashed} onClick={() => apply(false)} disabled={!hl}>
            {t("只選起來")}
          </Button>
          <Button variant="primary" icon={Scissors} onClick={() => apply(true)} disabled={!hl}>
            {t("只保留這段")}
          </Button>
        </>
      }
    >
      {!local ? (
        <EmptyState compact icon={Zap} title={t("波形還在計算")} hint={t("等波形算完就能挑精華片段。")} />
      ) : (
        <div className="space-y-4 text-sm">
          <Segmented<string>
            full
            value={len}
            onChange={setLen}
            ariaLabel={t("長度")}
            options={HIGHLIGHT_LENGTHS.map((n) => ({ value: String(n), label: `${n}s` }))}
          />
          {hl ? (
            <div className="rounded-md border border-fg/10 p-3 space-y-2">
              <div className="flex items-center gap-2">
                <span className="mono text-fg/85 tabular-nums">
                  {formatMs(hl.startMs, { millis: false })} – {formatMs(hl.endMs, { millis: false })}
                </span>
                <Badge tone={hl.score > 0.5 ? "success" : "info"}>{t("能量 {n}%", { n: Math.round(hl.score * 100) })}</Badge>
                {hl.barAligned && <Badge tone="accent">{t("貼齊小節")}</Badge>}
                <Button size="sm" variant="ghost" icon={Play} className="ml-auto" onClick={() => playRange(hl.startMs, hl.endMs, { skip: false })}>
                  {t("試聽")}
                </Button>
              </div>
              <div className="text-xs text-fg/55">{hl.reason}</div>
              <label className="flex items-center gap-2 text-xs text-fg/70">
                <input type="checkbox" checked={fade} onChange={(e) => setFade(e.target.checked)} />
                {t("保留時自動加淡入 / 淡出（收尾不會突然斷掉）")}
              </label>
            </div>
          ) : (
            <div className="text-xs text-fg/45">{t("音檔太短，挑不出這個長度的片段。")}</div>
          )}
          <p className="text-[11px] text-fg/35 leading-relaxed">
            {t("挑法：掃描全曲的能量平均，並加權「段內有起伏」（副歌通常有律動）；有拍網格時起訖會貼到小節線。挑完可以在波形上自己微調。")}
          </p>
        </div>
      )}
    </Modal>
  );
}
