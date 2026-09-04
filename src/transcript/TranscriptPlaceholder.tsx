import { FileText } from "lucide-react";
import { Button, EmptyState, Spinner } from "../ui/index";
import { useT } from "../i18n";
import { useJobs, type JobPhase } from "../store/jobs";
import { useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { formatDuration } from "../time";

export interface TranscriptPlaceholderProps {
  mediaId: string | null;
  onAnalyze: () => void;
  onOpenSettings: (focus?: "key" | "ffmpeg") => void;
}

const PHASES: JobPhase[] = ["prepare", "transcribe", "normalize", "rules"];

/** 轉寫預估：約時長 / 6，取整到 30 秒，至少 30 秒。 */
export function estimateTranscribeMs(durationMs: number): number {
  return Math.max(30_000, Math.ceil(durationMs / 6 / 30_000) * 30_000);
}

/**
 * 逐字稿區在「還沒有逐字稿」時的內容：分析中顯示 4 步小清單與進度；未分析時給出唯一的下一步。
 */
export default function TranscriptPlaceholder({ mediaId, onAnalyze, onOpenSettings }: TranscriptPlaceholderProps) {
  const t = useT();
  const media = useProject((s) => s.media.find((m) => m.id === mediaId) ?? null);
  const key = useSettings((s) => s.key);
  const ttls = useSettings((s) => s.ttls);
  const job = useJobs((s) => s.jobs.find((j) => j.kind === "analyze" && j.mediaId === mediaId && (j.status === "running" || j.status === "queued")));
  const cancelJob = useJobs((s) => s.cancel);
  const phaseLabels: Record<JobPhase, string> = {
    prepare: t("轉檔"),
    transcribe: t("上傳 / 轉寫"),
    normalize: t("整理逐字稿"),
    rules: t("規則分析"),
  };

  if (!media) return null;

  if (media.analysis === "analyzing" || job) {
    const cur = job?.phase ? PHASES.indexOf(job.phase) : -1;
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center p-6">
        <div className="w-[320px] max-w-full rounded-md border border-fg/10 bg-panel p-4 space-y-3 text-xs">
          <div className="flex items-center gap-2 text-fg/80">
            <Spinner size={14} className="text-accent" />
            <span className="truncate flex-1">{job?.step ?? t("分析中…")}</span>
            {job?.pct != null && <span className="mono text-fg/50">{job.pct}%</span>}
          </div>
          <div className="h-1 rounded-full bg-fg/10 overflow-hidden">
            {job?.pct == null ? (
              <div className="progress-track h-full">
                <div className="progress-thumb" />
              </div>
            ) : (
              <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.max(2, Math.min(100, job.pct))}%` }} />
            )}
          </div>
          {job?.message && <div className="text-fg/45 truncate">{job.message}</div>}
          <ol className="space-y-1">
            {PHASES.map((ph, i) => (
              <li key={ph} className={`flex items-center gap-2 ${i === cur ? "text-fg/90" : i < cur ? "text-fg/45" : "text-fg/30"}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${i === cur ? "bg-accent" : i < cur ? "bg-success" : "bg-fg/20"}`} />
                {phaseLabels[ph]}
              </li>
            ))}
          </ol>
          <div className="text-fg/40">{t("波形已可先聽、先手動剪；逐字稿好了會自動填進來")}</div>
          {job && (
            <div className="flex justify-end">
              <Button size="sm" variant="ghost" onClick={() => cancelJob(job.id)}>
                {t("取消")}
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (media.analysis === "error") {
    return (
      <EmptyState
        compact
        icon={FileText}
        title={t("分析失敗")}
        hint={media.error}
        className="flex-1"
        action={
          <>
            <Button size="sm" variant="primary" onClick={onAnalyze}>
              {t("重試")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onOpenSettings()}>
              {t("設定")}
            </Button>
          </>
        }
      />
    );
  }

  const keyMissing = key !== null && !key.present;
  const dur = media.probe?.duration_ms ?? 0;
  const busy = !!ttls && (!!ttls.degraded || (ttls.queue_pending != null && ttls.max_pending != null && ttls.queue_pending >= ttls.max_pending));
  const est = dur > 0 && !busy ? t("（{dur} 音檔約需 {est}）", { dur: formatDuration(dur), est: formatDuration(estimateTranscribeMs(dur)) }) : "";
  return (
    <EmptyState
      compact
      icon={FileText}
      title={t("逐字稿會在分析後出現")}
      hint={
        keyMissing
          ? t("分析會把音檔上傳到 ttls 轉寫（需要金鑰），並用規則找出贅字 / 口吃 / 停頓。在那之前，波形已可播放、可拖選手動剪。")
          : t("上傳到 ttls 轉寫{est}；波形已可先聽、先手動剪。", { est })
      }
      className="flex-1"
      action={
        keyMissing ? (
          <Button size="sm" variant="primary" onClick={() => onOpenSettings("key")}>
            {t("貼上 ttls 金鑰")}
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={onAnalyze}>
            {t("開始分析")}
          </Button>
        )
      }
    />
  );
}
