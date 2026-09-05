// ASR 驗收：把剛輸出的成品送回 ttls 重新轉寫，跟 EDL 預期保留的字逐字比對。
// 人機協作的最後一哩：AI 剪完、人只需要聽「機器覺得可疑」的那幾個接縫。
import { api, errKind, errMessage, type TranscribeJobInfo } from "../api";
import { normalizeTranscript, type ServerTranscript } from "../analysis/normalize";
import { parseAnalysis } from "../analysis/peaks";
import { auditSplice, type SpliceAuditReport } from "../analysis/spliceAudit";
import { actualWords, expectedWords, verifyEdit, type VerifyReport } from "../analysis/verify";
import { t } from "../i18n";
import { newJobId, useJobs } from "../store/jobs";
import { useProject } from "../store/project";
import { useVerify } from "../store/verify";
import { toast } from "../ui";
import { edlFor } from "./rules";
import { withVramRetry } from "./gpu";
import { isAbort, sleep, withBackoff } from "./retry";
import { useTranscript } from "../store/transcript";
import { useSettings } from "../store/settings";

export interface VerifyOpts {
  /** 成品檔案路徑（render 完成後的 out_path）。 */
  outPath: string;
  /** 成品時長（ms），有的話會比對 EDL 預估。 */
  outDurationMs?: number | null;
}

export interface VerifyResult {
  /** 逐字比對（需要逐字稿；音樂通常沒有）。 */
  asr: VerifyReport | null;
  /** 波形包絡逐段比對（音樂也適用，純本機）。 */
  splice: SpliceAuditReport | null;
}

/** 對某媒體的成品跑驗收：先做本機音訊比對，有逐字稿再加上 ASR 逐字比對。 */
export async function runVerify(mediaId: string, opts: VerifyOpts): Promise<VerifyResult> {
  const proj = useProject.getState();
  const media = proj.media.find((m) => m.id === mediaId);
  if (!media) throw new Error(t("找不到媒體"));
  const tr = useTranscript.getState().byMedia[mediaId];
  const edl = edlFor(mediaId);
  if (!edl) throw new Error(t("尚未建立剪輯計畫"));

  const jobs = useJobs.getState();
  const jobId = newJobId();
  const settings = useSettings.getState().s;
  let ttlsJobId: string | null = null;
  let canceled = false;
  jobs.upsert({
    id: jobId,
    kind: "verify",
    mediaId,
    step: t("轉檔（上傳用）"),
    pct: null,
    status: "running",
    message: opts.outPath,
    cancel: () => {
      canceled = true;
      if (ttlsJobId) void api.ttlsTranscribeCancel(ttlsJobId).catch(() => {});
    },
  });
  const step = (label: string, pct: number | null = null, message = "") => jobs.upsert({ id: jobId, step: label, pct, message });
  useVerify.getState().setRunning(mediaId, true);

  let splice: SpliceAuditReport | null = null;
  try {
    const fp = await api.mediaFingerprint(opts.outPath);

    // 1) 音訊比對（純本機，音樂也能驗）：把成品也算一份波形，逐段跟來源做正規化互相關
    const srcLocal = useTranscript.getState().local[mediaId];
    if (srcLocal) {
      step(t("音訊比對（波形逐段對齊）"));
      try {
        const outProbe = await api.mediaProbe(opts.outPath);
        const buf = await api.mediaAnalyzeLocal(newJobId(), opts.outPath, fp, outProbe.duration_ms);
        splice = auditSplice(srcLocal, parseAnalysis(buf), edl);
        useVerify.getState().setSplice(mediaId, { ...splice, outPath: opts.outPath, at: new Date().toISOString() });
      } catch {
        /* 比對失敗不影響 ASR 驗收 */
      }
    }
    if (canceled) throw new Error("canceled");
    if (!tr?.words.length) {
      const msg = splice ? splice.summary : t("沒有逐字稿可比對（音訊比對也無法進行）");
      jobs.upsert({ id: jobId, status: "done", step: t("完成"), pct: 100, message: msg, endedAt: Date.now() });
      if (splice && splice.okCount === splice.segments.length) toast.success(msg);
      else toast.info(msg);
      return { asr: null, splice };
    }

    const prep = await api.mediaPrepare(opts.outPath, fp);
    if (canceled) throw new Error("canceled");

    step(t("上傳到 ttls 轉寫…"));
    ttlsJobId = await withBackoff(() => withVramRetry(() => api.ttlsTranscribeStart(prep.upload_path, settings.asr_language, settings.asr_model, settings.hotwords), (m) => step(m)), {
      onRetry: (n, d, e) => step(t("等待 ttls"), null, `${errMessage(e)}（${Math.round(d / 1000)}s，${n}/6）`),
    });
    const startedAt = Date.now();
    let info: TranscribeJobInfo;
    for (;;) {
      if (canceled) throw new Error("canceled");
      await sleep(Date.now() - startedAt < 60_000 ? 2000 : 5000);
      info = await withBackoff(() => api.ttlsTranscribePoll(ttlsJobId!), { delaysMs: [3000, 5000, 10000, 20000] });
      if (info.status === "queued") step(t("ttls 排隊中"), null, `${Math.round(info.waiting_sec ?? 0)}s`);
      else if (info.status === "running" || info.status === "post") step(t("ttls 轉寫中"), null, info.progress ?? "");
      else if (info.status === "done") break;
      else if (info.status === "failed") throw new Error(info.error ?? t("轉寫失敗"));
      else if (info.status === "cancelled") throw new Error("canceled");
    }
    const server = (await api.ttlsTranscribeResult(ttlsJobId)) as ServerTranscript;
    step(t("逐字比對"));
    const outTr = normalizeTranscript(server);
    const report = verifyEdit(expectedWords(tr, edl), actualWords(outTr), edl, {
      outDurationMs: opts.outDurationMs ?? null,
      expectedDurationMs: edl.stats.keptMs,
    });
    useVerify.getState().setReport(mediaId, { ...report, outPath: opts.outPath, at: new Date().toISOString() });
    const hard = report.findings.filter((f) => (f.kind === "missing" || f.kind === "extra") && !f.lowConfidence).length;
    jobs.upsert({ id: jobId, status: "done", step: t("完成"), pct: 100, message: report.summary, endedAt: Date.now() });
    if (hard === 0) toast.success(report.summary);
    else toast.info(report.summary);
    return { asr: report, splice };
  } catch (e) {
    const msg = errMessage(e);
    if (canceled || isAbort(e) || errKind(e) === "canceled" || msg === "canceled") {
      jobs.upsert({ id: jobId, status: "canceled", step: t("已取消"), endedAt: Date.now() });
      throw e;
    }
    jobs.upsert({ id: jobId, status: "error", step: t("失敗"), error: msg, endedAt: Date.now() });
    toast.error(msg);
    throw e;
  } finally {
    useVerify.getState().setRunning(mediaId, false);
  }
}
