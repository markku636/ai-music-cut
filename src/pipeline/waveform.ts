// 本機波形 / 響度（Rust media_analyze_local → analysis.bin）：開檔即跑、與 ttls 無關。
// 這裡是唯一呼叫 media_analyze_local 的地方；同一媒體同時只跑一次，進度統一走 useJobs（kind: waveform）。
import { listen } from "@tauri-apps/api/event";
import { api, errKind, errMessage, type MediaProgress } from "../api";
import { parseAnalysis, type LocalAnalysis } from "../analysis/peaks";
import { t } from "../i18n";
import { newJobId, useJobs, type Job } from "../store/jobs";
import { useProject } from "../store/project";
import { useTranscript } from "../store/transcript";

const inflight = new Map<string, { promise: Promise<LocalAnalysis>; jobId: string }>();

/** 取得（或啟動計算）某媒體的本機分析；已有 → 直接回；進行中 → 共用同一個 promise。 */
export function ensureLocalAnalysis(mediaId: string): Promise<LocalAnalysis> {
  const have = useTranscript.getState().local[mediaId];
  if (have) return Promise.resolve(have);
  const cur = inflight.get(mediaId);
  if (cur) return cur.promise;

  const media = useProject.getState().media.find((m) => m.id === mediaId);
  if (!media?.probe) return Promise.reject(new Error(t("媒體尚未探測")));
  const { path, fingerprint } = media;
  const durationMs = media.probe.duration_ms;

  const jobId = newJobId();
  useJobs.getState().upsert({
    id: jobId,
    kind: "waveform",
    mediaId,
    step: t("計算波形 / 響度"),
    pct: null,
    status: "running",
    cancel: () => void api.mediaCancel(jobId).catch(() => {}),
  });

  const promise = (async () => {
    const unlisten = await listen<MediaProgress>("media-progress", (ev) => {
      if (ev.payload.job_id !== jobId) return;
      useJobs.getState().upsert({ id: jobId, pct: Math.round(ev.payload.pct) });
    });
    try {
      const buf = await api.mediaAnalyzeLocal(jobId, path, fingerprint, durationMs);
      const a = parseAnalysis(buf);
      useTranscript.getState().setLocal(mediaId, a);
      useJobs.getState().upsert({ id: jobId, status: "done", step: t("波形就緒"), pct: 100, endedAt: Date.now() });
      window.setTimeout(() => {
        const j = useJobs.getState().jobs.find((x) => x.id === jobId);
        if (j?.status === "done") useJobs.getState().remove(jobId);
      }, 1500);
      return a;
    } catch (e) {
      const canceled = errKind(e) === "canceled";
      useJobs.getState().upsert({
        id: jobId,
        status: canceled ? "canceled" : "error",
        step: canceled ? t("已取消") : t("無法計算波形"),
        error: canceled ? undefined : errMessage(e),
        endedAt: Date.now(),
      });
      throw e;
    } finally {
      unlisten();
      inflight.delete(mediaId);
    }
  })();
  inflight.set(mediaId, { promise, jobId });
  return promise;
}

/** 移除媒體 / 關專案時：取消進行中的波形計算。 */
export function cancelLocalAnalysis(mediaId: string): void {
  const cur = inflight.get(mediaId);
  if (cur) useJobs.getState().cancel(cur.jobId);
}

/** 該媒體最近一筆波形 job（running / error 供 placeholder 顯示）。 */
export function selectWaveformJob(jobs: Job[], mediaId: string | null): Job | null {
  if (!mediaId) return null;
  for (let i = jobs.length - 1; i >= 0; i--) {
    const j = jobs[i];
    if (j.kind === "waveform" && j.mediaId === mediaId) return j;
  }
  return null;
}
