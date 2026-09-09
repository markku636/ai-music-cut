import { AudioLines } from "lucide-react";
import { Button, EmptyState } from "../ui/index";
import { useT } from "../i18n";
import { selectWaveformJob } from "../pipeline/waveform";
import { useJobs } from "../store/jobs";
import { useSettings } from "../store/settings";

export interface TimelinePlaceholderProps {
  mediaId: string | null;
  height: number;
  onRetry: () => void;
  onOpenSettings: (focus?: "asr" | "ffmpeg") => void;
}

/** 假波形骨架的高度（確定性偽隨機，避免每次 render 跳動）。 */
const BARS = Array.from({ length: 72 }, (_, i) => 18 + ((i * 37 + 11) % 53) + (i % 7 === 0 ? 18 : 0));

/**
 * 波形尚未就緒時的時間軸區：計算中 → 骨架 + 進度；失敗 → 說明 + 修復入口。
 * 進度來源與側欄「工作」列相同（useJobs kind=waveform），不另立狀態。
 */
export default function TimelinePlaceholder({ mediaId, height, onRetry, onOpenSettings }: TimelinePlaceholderProps) {
  const t = useT();
  const job = useJobs((s) => selectWaveformJob(s.jobs, mediaId));
  const ffmpeg = useSettings((s) => s.ffmpeg);

  if (job?.status === "error" || job?.status === "canceled") {
    const noFfmpeg = !!ffmpeg && !ffmpeg.found;
    return (
      <div className="h-full flex items-center justify-center" style={{ height }}>
        <EmptyState
          compact
          icon={AudioLines}
          title={job.status === "canceled" ? t("波形計算已取消") : t("無法計算波形")}
          hint={noFfmpeg ? t("找不到 ffmpeg：無法讀取音檔、計算波形或輸出。") : job.error}
          action={
            noFfmpeg ? (
              <Button size="sm" variant="primary" onClick={() => onOpenSettings("ffmpeg")}>
                {t("檢查 ffmpeg 設定")}
              </Button>
            ) : (
              <Button size="sm" variant="primary" onClick={onRetry}>
                {t("重試")}
              </Button>
            )
          }
        />
      </div>
    );
  }

  const pct = job?.pct ?? null;
  return (
    <div className="relative h-full px-2 py-2 overflow-hidden select-none" style={{ height }} aria-busy="true">
      <div className="absolute inset-x-2 top-2 bottom-2 flex items-center gap-[3px] opacity-60">
        {BARS.map((h, i) => (
          <span key={i} className="flex-1 min-w-0 rounded-xs bg-fg/10 animate-pulse" style={{ height: `${h}%`, animationDelay: `${(i % 12) * 80}ms` }} />
        ))}
      </div>
      <div className="absolute left-2 right-2 bottom-2 h-[2px] rounded bg-fg/10 overflow-hidden">
        {pct == null ? (
          <div className="progress-track h-full">
            <div className="progress-thumb" />
          </div>
        ) : (
          <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.max(2, Math.min(100, pct))}%` }} />
        )}
      </div>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="mono text-xs text-fg/55 bg-well/80 px-2 py-1 rounded">
          {pct == null ? t("正在計算波形…") : t("正在計算波形… {pct}%", { pct })}
        </span>
      </div>
    </div>
  );
}
