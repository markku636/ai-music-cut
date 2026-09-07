import { FolderOpen, Music, Trash, X } from "lucide-react";
import Icon from "../ui/Icon";
import { Badge, Button, IconButton, Spinner } from "../ui/index";
import { useT } from "../i18n";
import { cancelLocalAnalysis } from "../pipeline/waveform";
import { getPlayer, stopRange } from "../preview/playerRef";
import { useJobs, type Job, type JobKind } from "../store/jobs";
import { useProject, type MediaItem } from "../store/project";
import { useSettings } from "../store/settings";
import { useTranscript } from "../store/transcript";
import { formatDuration } from "../time";
import * as A from "../commands/appActions";

/**
 * 雙擊音檔：切過去並從頭播。換來源時 <audio> 的 src 才剛換掉，要等 canplay 才能 play()，
 * 否則會拿到 AbortError；同一個檔案且已載入就直接播。
 */
function playFromStart(id: string) {
  const proj = useProject.getState();
  const same = proj.activeMediaId === id;
  proj.setActive(id);
  stopRange();
  const el = getPlayer();
  if (!el) return;
  const start = () => {
    el.currentTime = 0;
    void el.play().catch(() => {});
  };
  if (same && el.readyState >= 2) {
    start();
    return;
  }
  const timer = window.setTimeout(() => el.removeEventListener("canplay", once), 8000);
  const once = () => {
    window.clearTimeout(timer);
    start();
  };
  el.addEventListener("canplay", once, { once: true });
}

function jobTone(j: Job): "neutral" | "info" | "success" | "danger" | "warning" {
  switch (j.status) {
    case "running":
      return "info";
    case "done":
      return "success";
    case "error":
      return "danger";
    case "canceled":
      return "warning";
    default:
      return "neutral";
  }
}

const KIND_LABEL: Record<JobKind, string> = {
  prepare: "前處理",
  waveform: "波形",
  analyze: "分析",
  judge: "AI 判讀",
  render: "輸出",
  separate: "去人聲",
  verify: "驗收",
  music: "AI 配樂",
  convert: "轉檔",
  merge: "合併",
};

export default function Sidebar({ width }: { width: number }) {
  const t = useT();
  const onOpen = () => void A.openMedia();
  const onAnalyze = (mediaId: string) => A.analyzeWithPreflight(mediaId);
  const onOpenSettings = (focus?: "key" | "ffmpeg") => A.openSettings(focus ?? null);
  const media = useProject((s) => s.media);
  const activeId = useProject((s) => s.activeMediaId);
  const setActive = useProject((s) => s.setActive);
  const removeMedia = useProject((s) => s.removeMedia);
  const local = useTranscript((s) => s.local);
  const key = useSettings((s) => s.key);
  const jobs = useJobs((s) => s.jobs);
  const cancelJob = useJobs((s) => s.cancel);
  const removeJob = useJobs((s) => s.remove);
  const clearFinished = useJobs((s) => s.clearFinished);

  /** 每列右側的狀態：依分析狀態 / 波形 / 金鑰給出下一步。 */
  const rowStatus = (m: MediaItem, active: boolean) => {
    if (m.analysis === "analyzing") return <Badge tone="info">{t("分析中")}</Badge>;
    if (m.analysis === "ready") return <Badge tone="success">{t("已分析")}</Badge>;
    if (m.analysis === "error") return <Badge tone="danger">{t("失敗")}</Badge>;
    const wave = jobs.find((j) => j.kind === "waveform" && j.mediaId === m.id && j.status === "running");
    if (wave) return <Spinner size={12} className="text-info" />;
    if (key !== null && !key.present) {
      return (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpenSettings("key");
          }}
          title={t("分析需要 ttls 金鑰；點擊設定")}
        >
          <Badge tone="warning">{t("需金鑰")}</Badge>
        </button>
      );
    }
    if (active) {
      return (
        <Button
          size="sm"
          variant="primary"
          className="h-6 px-2 text-[11px]"
          onClick={(e) => {
            e.stopPropagation();
            onAnalyze(m.id);
          }}
        >
          {t("分析")}
        </Button>
      );
    }
    if (local[m.id]) {
      return (
        <span title={t("已可看波形與手動剪輯；按「分析」取得逐字稿與候選")}>
          <Badge tone="info">{t("波形就緒")}</Badge>
        </span>
      );
    }
    return <Badge tone="neutral">{t("未分析")}</Badge>;
  };

  return (
    <div className="shrink-0 bg-panel border-r border-fg/10 flex flex-col text-sm min-h-0" style={{ width }}>
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-fg/10">
        <span className="text-xs text-fg/45 uppercase tracking-wide">{t("媒體")}</span>
        <Button size="sm" variant="primary" icon={FolderOpen} className="ml-auto" onClick={onOpen}>
          {t("開啟音檔")}
        </Button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {media.length === 0 ? (
          <div className="p-4 text-xs text-fg/35 leading-relaxed">{t("把 mp3 / wav / m4a 拖進來，或按上方「開啟音檔」。")}</div>
        ) : (
          media.map((m) => {
            const active = m.id === activeId;
            return (
              <div
                key={m.id}
                role="button"
                tabIndex={0}
                onClick={() => setActive(m.id)}
                onDoubleClick={() => playFromStart(m.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") setActive(m.id);
                }}
                title={`${m.path}\n${t("雙擊：切換並從頭播放")}`}
                className={`group flex items-center gap-2 px-3 py-2 border-b border-fg/5 cursor-pointer ${active ? "bg-accent/12" : "hover:bg-fg/5"}`}
              >
                <span className={`shrink-0 ${active ? "text-accent" : "text-fg/50"}`}>
                  <Icon icon={Music} size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-fg/90">{m.name}</div>
                  <div className="text-[11px] text-fg/40 mono truncate">
                    {m.probe ? formatDuration(m.probe.duration_ms) : "—"}
                    {m.probe?.audio && ` · ${m.probe.audio.codec} · ${Math.round(m.probe.audio.sample_rate / 1000)}k · ${m.probe.audio.channels}ch`}
                  </div>
                </div>
                {rowStatus(m, active)}
                <IconButton
                  icon={Trash}
                  label={t("移除")}
                  iconSize={14}
                  box="w-6 h-6"
                  className="opacity-0 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    cancelLocalAnalysis(m.id);
                    removeMedia(m.id);
                  }}
                />
              </div>
            );
          })
        )}
      </div>
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-t border-b border-fg/10">
        <span className="text-xs text-fg/45 uppercase tracking-wide">{t("工作")}</span>
        {jobs.some((j) => j.status !== "running" && j.status !== "queued") && (
          <button type="button" onClick={clearFinished} className="ml-auto text-[11px] text-fg/40 hover:text-fg/70">
            {t("清除已完成")}
          </button>
        )}
      </div>
      <div className="max-h-[38%] min-h-0 overflow-auto">
        {jobs.length === 0 ? (
          <div className="p-3 text-xs text-fg/30">{t("沒有進行中的工作")}</div>
        ) : (
          jobs
            .slice()
            .reverse()
            .map((j) => (
              <div key={j.id} className="px-3 py-2 border-b border-fg/5 text-xs">
                <div className="flex items-center gap-2">
                  <Badge tone={jobTone(j)}>{t(KIND_LABEL[j.kind])}</Badge>
                  <span className="truncate text-fg/75 flex-1">{j.step || j.message}</span>
                  {j.status === "running" || j.status === "queued" ? (
                    <IconButton icon={X} label={t("取消")} iconSize={13} box="w-5 h-5" onClick={() => cancelJob(j.id)} />
                  ) : (
                    <IconButton icon={X} label={t("移除")} iconSize={13} box="w-5 h-5" onClick={() => removeJob(j.id)} />
                  )}
                </div>
                {(j.status === "running" || j.status === "queued") && (
                  <div className="mt-1.5 h-1 rounded-full bg-fg/10 overflow-hidden">
                    {j.pct == null ? (
                      <div className="progress-track h-full">
                        <div className="progress-thumb" />
                      </div>
                    ) : (
                      <div className="h-full bg-accent transition-[width]" style={{ width: `${Math.max(2, Math.min(100, j.pct))}%` }} />
                    )}
                  </div>
                )}
                {j.message && j.step && <div className="mt-1 text-[11px] text-fg/40 truncate">{j.message}</div>}
                {j.error && <div className="mt-1 text-[11px] text-danger break-all">{j.error}</div>}
              </div>
            ))
        )}
      </div>
    </div>
  );
}
