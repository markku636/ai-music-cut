import { FolderOpen, Music, Trash, X } from "lucide-react";
import Icon from "../ui/Icon";
import { Badge, Button, IconButton } from "../ui/index";
import { useT } from "../i18n";
import { useJobs, type Job } from "../store/jobs";
import { useProject, type AnalysisState } from "../store/project";
import { formatDuration } from "../time";

function stateTone(s: AnalysisState): { tone: "neutral" | "info" | "success" | "danger"; label: string } {
  switch (s) {
    case "analyzing":
      return { tone: "info", label: "分析中" };
    case "ready":
      return { tone: "success", label: "已分析" };
    case "error":
      return { tone: "danger", label: "失敗" };
    default:
      return { tone: "neutral", label: "未分析" };
  }
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

export default function Sidebar({ width, onOpen }: { width: number; onOpen: () => void }) {
  const t = useT();
  const media = useProject((s) => s.media);
  const activeId = useProject((s) => s.activeMediaId);
  const setActive = useProject((s) => s.setActive);
  const removeMedia = useProject((s) => s.removeMedia);
  const jobs = useJobs((s) => s.jobs);
  const cancelJob = useJobs((s) => s.cancel);
  const removeJob = useJobs((s) => s.remove);
  const clearFinished = useJobs((s) => s.clearFinished);

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
            const st = stateTone(m.analysis);
            const active = m.id === activeId;
            return (
              <div
                key={m.id}
                role="button"
                tabIndex={0}
                onClick={() => setActive(m.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") setActive(m.id);
                }}
                title={m.path}
                className={`group flex items-center gap-2 px-3 py-2 border-b border-fg/5 cursor-pointer ${
                  active ? "bg-accent/12" : "hover:bg-fg/5"
                }`}
              >
                <span className={`shrink-0 ${active ? "text-accent" : "text-fg/50"}`}>
                  <Icon icon={Music} size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-fg/90">{m.name}</div>
                  <div className="text-[11px] text-fg/40 mono flex items-center gap-2">
                    <span>{m.probe ? formatDuration(m.probe.duration_ms) : "—"}</span>
                    {m.probe?.audio && (
                      <span>
                        {m.probe.audio.codec} · {Math.round(m.probe.audio.sample_rate / 1000)}k · {m.probe.audio.channels}ch
                      </span>
                    )}
                  </div>
                </div>
                <Badge tone={st.tone}>{t(st.label)}</Badge>
                <IconButton
                  icon={Trash}
                  label={t("移除")}
                  iconSize={14}
                  box="w-6 h-6"
                  className="opacity-0 group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
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
                  <Badge tone={jobTone(j)}>{t(j.kind === "analyze" ? "分析" : j.kind === "judge" ? "AI 判讀" : j.kind === "render" ? "輸出" : "前處理")}</Badge>
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
