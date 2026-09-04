import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { Badge, Button } from "../ui/index";
import Icon from "../ui/Icon";
import { useT } from "../i18n";
import { decisionCounts, useDecisions } from "../store/decisions";
import { useJobs } from "../store/jobs";
import { selectActiveMedia, useProject } from "../store/project";
import { useSettings } from "../store/settings";

export interface WorkflowStripProps {
  onOpen: () => void;
  onAnalyze: () => void;
  onJudge: () => void;
  onRender: () => void;
  onOpenSettings: (focus?: "key" | "ffmpeg") => void;
}

const EMPTY: never[] = [];

interface Caption {
  text: string;
  cta: ReactNode;
  badge?: ReactNode;
  /** 有此欄位 → 顯示進度條（null = 不確定進度）。 */
  progress?: number | null;
}

/**
 * 四步流程列：① 開啟音檔 → ② 分析 → ③ 檢視決策 → ④ 輸出。
 * 由 store 推導「目前在哪一步」，只有目前步顯示說明與唯一主按鈕，讓畫面任何時候都只有一個「下一步」。
 */
export default function WorkflowStrip(p: WorkflowStripProps) {
  const t = useT();
  const active = useProject(selectActiveMedia);
  const key = useSettings((s) => s.key);
  const claude = useSettings((s) => s.claude);
  const mediaId = active?.id ?? null;
  const candidates = useDecisions((s) => (mediaId ? s.candidates[mediaId] ?? EMPTY : EMPTY));
  const decisions = useDecisions((s) => (mediaId ? s.decisions[mediaId] : undefined));
  const analyzeJob = useJobs((s) => s.jobs.find((j) => j.kind === "analyze" && j.mediaId === mediaId && (j.status === "running" || j.status === "queued")));
  const rendered = useJobs((s) => s.jobs.some((j) => j.kind === "render" && j.mediaId === mediaId && j.status === "done"));
  const cancelJob = useJobs((s) => s.cancel);

  const counts = decisionCounts(candidates, decisions ?? {});
  const step = !active ? 1 : active.analysis !== "ready" ? 2 : rendered ? 4 : 3;
  const keyMissing = key !== null && !key.present;
  const labels = [t("開啟音檔"), t("分析"), t("檢視決策"), t("輸出")];

  let caption: Caption;
  if (step === 1) {
    caption = {
      text: t("先開一個 mp3 / wav / m4a"),
      cta: (
        <Button size="sm" variant="primary" onClick={p.onOpen}>
          {t("開啟音檔")}
        </Button>
      ),
    };
  } else if (step === 2) {
    if (analyzeJob) {
      caption = {
        text: `${analyzeJob.step}${analyzeJob.pct != null ? ` · ${analyzeJob.pct}%` : ""}${analyzeJob.message ? ` · ${analyzeJob.message}` : ""}`,
        progress: analyzeJob.pct,
        cta: (
          <Button size="sm" variant="ghost" onClick={() => cancelJob(analyzeJob.id)}>
            {t("取消")}
          </Button>
        ),
      };
    } else if (active?.analysis === "error") {
      caption = {
        text: active.error ?? t("分析失敗"),
        badge: <Badge tone="danger">{t("失敗")}</Badge>,
        cta: (
          <Button size="sm" variant="primary" onClick={p.onAnalyze}>
            {t("重試")}
          </Button>
        ),
      };
    } else if (keyMissing) {
      caption = {
        text: t("波形已可看、可手動剪；轉寫逐字稿與找贅字需要 ttls 金鑰"),
        badge: <Badge tone="warning">{t("需要 ttls 金鑰")}</Badge>,
        cta: (
          <Button size="sm" variant="primary" onClick={() => p.onOpenSettings("key")}>
            {t("貼上金鑰")}
          </Button>
        ),
      };
    } else {
      caption = {
        text: t("上傳 ttls 轉寫逐字稿，找出贅字 / 口吃 / 停頓"),
        cta: (
          <Button size="sm" variant="primary" onClick={p.onAnalyze}>
            {t("開始分析")}
          </Button>
        ),
      };
    }
  } else if (step === 3) {
    caption = {
      text:
        counts.total === 0
          ? t("沒有找到可剪的段落；可在波形上拖選手動剪，或調高激進度")
          : t("{p} 個待決 · 先聽再決定，或交給 AI 判讀", { p: counts.byState.pending }),
      cta: (
        <>
          <Button size="sm" variant="primary" onClick={p.onJudge} disabled={!claude?.installed} title={!claude?.installed ? t("需要安裝並登入 Claude Code CLI") : undefined}>
            {t("AI 判讀")}
          </Button>
          <Button size="sm" onClick={p.onRender}>
            {t("輸出")}
          </Button>
        </>
      ),
    };
  } else {
    caption = {
      text: t("已輸出"),
      cta: (
        <Button size="sm" variant="ghost" onClick={p.onRender}>
          {t("再次輸出")}
        </Button>
      ),
    };
  }

  return (
    <div className="h-9 shrink-0 flex items-center gap-2 px-3 bg-panel border-b border-fg/10 text-xs min-w-0">
      <ol className="flex items-center gap-1 shrink-0">
        {labels.map((label, i) => {
          const n = i + 1;
          const state = n < step ? "done" : n === step ? "current" : "future";
          return (
            <li key={label} className="flex items-center gap-1">
              {i > 0 && <span className="w-4 h-px bg-fg/15 mx-0.5" aria-hidden />}
              <span
                className={`grid place-items-center w-4 h-4 rounded-full text-[10px] font-semibold ${
                  state === "done" ? "bg-success/15 text-success" : state === "current" ? "bg-accent text-white" : "bg-fg/8 text-fg/40"
                }`}
              >
                {state === "done" ? <Icon icon={Check} size={10} /> : n}
              </span>
              <span className={state === "current" ? "text-fg/90 font-medium" : state === "done" ? "text-fg/55" : "text-fg/35"}>{label}</span>
            </li>
          );
        })}
      </ol>
      <span className="w-px h-4 bg-fg/10 mx-1 shrink-0" aria-hidden />
      {caption.badge}
      <span className="flex-1 min-w-0 truncate text-fg/60" title={caption.text}>
        {caption.text}
      </span>
      {"progress" in caption && (
        <span className="w-24 h-[3px] rounded bg-fg/10 overflow-hidden shrink-0">
          {caption.progress == null ? (
            <span className="progress-track block h-full">
              <span className="progress-thumb block" />
            </span>
          ) : (
            <span className="block h-full bg-accent" style={{ width: `${Math.max(2, Math.min(100, caption.progress))}%` }} />
          )}
        </span>
      )}
      <span className="flex items-center gap-1 shrink-0">{caption.cta}</span>
    </div>
  );
}
