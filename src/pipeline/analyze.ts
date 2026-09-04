// 分析流程狀態機：probe → cache → prepare → [本機波形/響度 ∥ ttls 轉寫（202+輪詢）] → normalize → 存 store / 專案。
// 規則層 / LLM 判讀 / EDL 在 M3+ 接在 `afterTranscript` 之後。
import { listen } from "@tauri-apps/api/event";
import { api, errMessage, errKind, type MediaProgress, type TranscribeJobInfo } from "../api";
import { normalizeTranscript, type ServerTranscript } from "../analysis/normalize";
import { parseAnalysis } from "../analysis/peaks";
import type { Transcript } from "../analysis/types";
import { t } from "../i18n";
import { newJobId, useJobs } from "../store/jobs";
import { useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { useTranscript } from "../store/transcript";
import { toast } from "../ui";
import { restoreDecisions, type StoredAnalysis } from "./persist";
import { runRulesFor } from "./rules";
import { isAbort, sleep, withBackoff } from "./retry";

export interface AnalyzeOptions {
  /** 忽略逐字稿快取，重新轉寫。 */
  forceTranscribe?: boolean;
  /** 轉寫完成後（規則層等）。 */
  afterTranscript?: (mediaId: string, transcript: Transcript) => Promise<void> | void;
}

class Canceled extends Error {
  constructor() {
    super("canceled");
    this.name = "Canceled";
  }
}

function checkAbort(signal: AbortSignal) {
  if (signal.aborted) throw new Canceled();
}

/** 專案檔內每個媒體的分析產物形狀（analysis[mediaId]）。 */
export interface MediaAnalysisRecord {
  transcript: Transcript;
  serverJobId?: string;
  transcribedAt: string;
  [k: string]: unknown;
}

export async function runAnalyze(mediaId: string, opts: AnalyzeOptions = {}): Promise<void> {
  const proj = useProject.getState();
  const media = proj.media.find((m) => m.id === mediaId);
  if (!media) throw new Error("找不到媒體");
  const settings = useSettings.getState().s;
  const jobs = useJobs.getState();
  const jobId = newJobId();
  const ac = new AbortController();
  let ttlsJobId: string | null = null;

  jobs.upsert({
    id: jobId,
    kind: "analyze",
    mediaId,
    step: t("準備中"),
    pct: null,
    status: "running",
    cancel: () => {
      ac.abort();
      void api.mediaCancel(jobId).catch(() => {});
      if (ttlsJobId) void api.ttlsTranscribeCancel(ttlsJobId).catch(() => {});
    },
  });
  proj.updateMedia(mediaId, { analysis: "analyzing", error: undefined });

  const step = (label: string, pct: number | null = null, message = "") => jobs.upsert({ id: jobId, step: label, pct, message });

  const unlisten = await listen<MediaProgress>("media-progress", (ev) => {
    if (ev.payload.job_id !== jobId) return;
    const cur = useJobs.getState().jobs.find((j) => j.id === jobId);
    if (cur && cur.step === t("本機波形 / 響度")) step(cur.step, ev.payload.pct);
  });

  try {
    const probe = media.probe ?? (await api.mediaProbe(media.path));
    if (!media.probe) proj.updateMedia(mediaId, { probe });
    const fp = probe.fingerprint;
    checkAbort(ac.signal);

    // 1) 上傳用 opus（快取）
    step(t("轉檔（上傳用）"));
    const prep = await api.mediaPrepare(media.path, fp);
    checkAbort(ac.signal);

    // 2) 本機波形 + 響度 ∥ 3) ttls 轉寫
    const localTask = (async () => {
      const buf = await api.mediaAnalyzeLocal(jobId, media.path, fp, probe.duration_ms);
      const a = parseAnalysis(buf);
      useTranscript.getState().setLocal(mediaId, a);
      return a;
    })();

    const transcribeTask = (async (): Promise<ServerTranscript> => {
      if (!opts.forceTranscribe) {
        const cached = await api.mediaCacheReadTranscript(fp).catch(() => null);
        if (cached && typeof cached === "object" && Array.isArray((cached as ServerTranscript).segments)) {
          return cached as ServerTranscript;
        }
      }
      step(t("本機波形 / 響度"), 0, t("同時上傳到 ttls 轉寫…"));
      ttlsJobId = await withBackoff(
        () => api.ttlsTranscribeStart(prep.upload_path, settings.asr_language, settings.asr_model, settings.hotwords),
        {
          signal: ac.signal,
          onRetry: (n, d, e) => {
            toast.info(t("伺服器忙碌（{msg}），{sec} 秒後重試（{n}/6）", { msg: errMessage(e), sec: Math.round(d / 1000), n }));
            step(t("等待 ttls"), null, errMessage(e));
          },
        },
      );
      const startedAt = Date.now();
      let info: TranscribeJobInfo;
      for (;;) {
        checkAbort(ac.signal);
        const elapsed = Date.now() - startedAt;
        await sleep(elapsed < 60_000 ? 2000 : 5000, ac.signal);
        info = await withBackoff(() => api.ttlsTranscribePoll(ttlsJobId!), { signal: ac.signal, delaysMs: [3000, 5000, 10000, 20000] });
        const prog = info.progress ? `（${info.progress}）` : "";
        if (info.status === "queued") step(t("ttls 排隊中"), null, `${Math.round((info.waiting_sec ?? 0))}s`);
        else if (info.status === "running" || info.status === "post") step(t("ttls 轉寫中"), pctOf(info.progress), prog);
        else if (info.status === "done") break;
        else if (info.status === "failed") throw new Error(info.error ?? t("轉寫失敗"));
        else if (info.status === "cancelled") throw new Canceled();
      }
      const res = (await withBackoff(() => api.ttlsTranscribeResult(ttlsJobId!), { signal: ac.signal, delaysMs: [3000, 5000, 10000] })) as ServerTranscript;
      await api.mediaCacheWriteTranscript(fp, res).catch(() => {});
      return res;
    })();

    const [, server] = await Promise.all([localTask, transcribeTask]);
    checkAbort(ac.signal);

    step(t("整理逐字稿"));
    const transcript = normalizeTranscript(server);
    useTranscript.getState().setTranscript(mediaId, transcript);
    const record: MediaAnalysisRecord = { transcript, serverJobId: ttlsJobId ?? undefined, transcribedAt: new Date().toISOString() };
    useProject.getState().setAnalysis(mediaId, record);
    step(t("規則分析"));
    const nCands = runRulesFor(mediaId, { label: t("規則分析") });
    await opts.afterTranscript?.(mediaId, transcript);

    useProject.getState().updateMedia(mediaId, { analysis: "ready", error: undefined });
    jobs.upsert({ id: jobId, status: "done", step: t("完成"), pct: 100, message: t("{n} 字 · {c} 個候選 · {m}", { n: transcript.words.length, c: nCands, m: transcript.model || "ttls" }), endedAt: Date.now() });
  } catch (e) {
    if (e instanceof Canceled || isAbort(e) || errKind(e) === "canceled") {
      useProject.getState().updateMedia(mediaId, { analysis: "none" });
      jobs.upsert({ id: jobId, status: "canceled", step: t("已取消"), endedAt: Date.now() });
      return;
    }
    const msg = errMessage(e);
    useProject.getState().updateMedia(mediaId, { analysis: "error", error: msg });
    jobs.upsert({ id: jobId, status: "error", step: t("失敗"), error: msg, endedAt: Date.now() });
    if (errKind(e) === "auth") toast.error(t("ttls 金鑰缺少或錯誤，請到設定輸入"));
    else toast.error(msg);
    throw e;
  } finally {
    unlisten();
  }
}

function pctOf(progress: string | null): number | null {
  if (!progress) return null;
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(progress);
  if (!m) return null;
  const done = Number(m[1]);
  const total = Number(m[2]);
  return total > 0 ? Math.round((done / total) * 100) : null;
}

/** 開專案 / 重開同檔時：從專案檔的 analysis 記錄還原 store，並嘗試載入磁碟快取的波形。 */
export async function restoreAnalysis(mediaId: string): Promise<void> {
  const proj = useProject.getState();
  const media = proj.media.find((m) => m.id === mediaId);
  const rec = proj.analysis[mediaId] as (Partial<MediaAnalysisRecord> & StoredAnalysis) | undefined;
  if (!media) return;
  if (rec?.transcript && Array.isArray(rec.transcript.words) && !useTranscript.getState().byMedia[mediaId]) {
    useTranscript.getState().setTranscript(mediaId, rec.transcript);
    if (!restoreDecisions(mediaId, rec)) runRulesFor(mediaId, { record: false });
  }
  if (media.fingerprint && !useTranscript.getState().local[mediaId]) {
    try {
      const st = await api.mediaCacheStatus(media.fingerprint);
      if (st.analysis && media.probe) {
        const buf = await api.mediaAnalyzeLocal(newJobId(), media.path, media.fingerprint, media.probe.duration_ms);
        useTranscript.getState().setLocal(mediaId, parseAnalysis(buf));
      }
    } catch {
      /* 波形快取缺失不影響逐字稿 */
    }
  }
}
