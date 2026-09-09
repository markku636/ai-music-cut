// 分析流程狀態機：probe → [本機波形/響度（waveform.ts，開檔時多半已好）∥ prepare → 本機轉寫] → normalize → 存 store / 專案。
// 規則層 / LLM 判讀 / EDL 在 M3+ 接在 `afterTranscript` 之後。
import { api, errMessage, errKind } from "../api";
import { normalizeTranscript, type ServerTranscript } from "../analysis/normalize";
import type { Transcript } from "../analysis/types";
import { t } from "../i18n";
import { newJobId, useJobs, type JobPhase } from "../store/jobs";
import { useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { useTranscript } from "../store/transcript";
import { toast } from "../ui";
import { restoreDecisions, type StoredAnalysis } from "./persist";
import { ensureLocalAnalysis } from "./waveform";
import { runRulesFor } from "./rules";
import { isAbort } from "./retry";

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
    },
  });
  proj.updateMedia(mediaId, { analysis: "analyzing", error: undefined });

  const step = (label: string, pct: number | null = null, message = "", phase?: JobPhase) =>
    jobs.upsert({ id: jobId, step: label, pct, message, ...(phase ? { phase } : {}) });

  try {
    const probe = media.probe ?? (await api.mediaProbe(media.path));
    if (!media.probe) proj.updateMedia(mediaId, { probe });
    const fp = probe.fingerprint;
    checkAbort(ac.signal);

    // 1) 本機波形 + 響度（開檔時通常已算好；這裡只是確保）∥ 2) 轉成辨識用的 opus（快取）→ 3) 本機轉寫
    const localTask = ensureLocalAnalysis(mediaId);
    step(t("轉檔（上傳用）"), null, "", "prepare");
    const prep = await api.mediaPrepare(media.path, fp);
    checkAbort(ac.signal);

    const transcribeTask = (async (): Promise<ServerTranscript> => {
      if (!opts.forceTranscribe) {
        const cached = await api.mediaCacheReadTranscript(fp).catch(() => null);
        if (cached && typeof cached === "object" && Array.isArray((cached as ServerTranscript).segments)) {
          return cached as ServerTranscript;
        }
      }
      // 轉寫一律在本機跑（faster-whisper）：不上傳、不需要金鑰、沒有伺服器要顧。
      step(t("本機辨識中…（第一次會先下載模型）"), null, "", "transcribe");
      const doc = (await api.localAsrTranscribe(jobId, prep.upload_path, settings.asr_model, settings.asr_language)) as ServerTranscript;
      await api.mediaCacheWriteTranscript(fp, doc).catch(() => {});
      return doc;
    })();

    const [, server] = await Promise.all([localTask, transcribeTask]);
    checkAbort(ac.signal);

    step(t("整理逐字稿"), null, "", "normalize");
    const transcript = normalizeTranscript(server);
    useTranscript.getState().setTranscript(mediaId, transcript);
    const record: MediaAnalysisRecord = { transcript, transcribedAt: new Date().toISOString() };
    useProject.getState().setAnalysis(mediaId, record);
    step(t("規則分析"), null, "", "rules");
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
  }
}


/** 開專案 / 重開同檔時：從專案檔的 analysis 記錄還原 store（波形由 waveform.ts 在開檔時獨立處理）。 */
export async function restoreAnalysis(mediaId: string): Promise<void> {
  const proj = useProject.getState();
  const media = proj.media.find((m) => m.id === mediaId);
  const rec = proj.analysis[mediaId] as (Partial<MediaAnalysisRecord> & StoredAnalysis) | undefined;
  if (!media) return;
  if (rec?.transcript && Array.isArray(rec.transcript.words) && !useTranscript.getState().byMedia[mediaId]) {
    useTranscript.getState().setTranscript(mediaId, rec.transcript);
    if (!restoreDecisions(mediaId, rec)) runRulesFor(mediaId, { record: false });
  }
}
