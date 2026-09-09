// ASR 驗收：把剛輸出的成品用本機 faster-whisper 重新轉寫，跟 EDL 預期保留的字逐字比對。
// 人機協作的最後一哩：AI 剪完、人只需要聽「機器覺得可疑」的那幾個接縫。
import { api, errKind, errMessage } from "../api";
import { normalizeTranscript, type ServerTranscript } from "../analysis/normalize";
import { parseAnalysis } from "../analysis/peaks";
import { auditSplice, type SpliceAuditReport } from "../analysis/spliceAudit";
import { useDecisions } from "../store/decisions";
import { actualWords, expectedWords, verifyEdit, type VerifyReport } from "../analysis/verify";
import { t } from "../i18n";
import { newJobId, useJobs } from "../store/jobs";
import { useProject } from "../store/project";
import { useVerify } from "../store/verify";
import { toast } from "../ui";
import { edlOutDurationMs } from "../analysis/edl/joins";
import { mapSrcToOut } from "../analysis/edl/map";
import { resolveOverlays } from "../analysis/overlays";
import { edlFor } from "./rules";
import { isAbort } from "./retry";
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
    },
  });
  const step = (label: string, pct: number | null = null, message = "") => jobs.upsert({ id: jobId, step: label, pct, message });
  useVerify.getState().setRunning(mediaId, true);

  let splice: SpliceAuditReport | null = null;
  // 成品的真實長度自己量。呼叫端以前傳的是「EDL 估的長度」，跟期望值同源 →
  // durationDelta 永遠是 0，那個檢查等於沒做。
  let actualOutMs: number | null = opts.outDurationMs ?? null;
  try {
    const fp = await api.mediaFingerprint(opts.outPath);
    const outProbe = await api.mediaProbe(opts.outPath).catch(() => null);
    if (outProbe) actualOutMs = outProbe.duration_ms;

    // 1) 音訊比對（純本機，音樂也能驗）：把成品也算一份波形，逐段跟來源做正規化互相關
    const srcLocal = useTranscript.getState().local[mediaId];
    if (srcLocal && outProbe) {
      step(t("音訊比對（波形逐段對齊）"));
      try {
        const buf = await api.mediaAnalyzeLocal(newJobId(), opts.outPath, fp, outProbe.duration_ms);
        // 成品混了配樂時，波形相似度本來就不會像來源 —— 只看位置，不然會對好成品報假警報
        const hasOverlays = (useDecisions.getState().overlays[mediaId] ?? []).length > 0;
        // 反轉 / 變調過的區段波形本來就對不上來源，只比位置；被靜音的段落（重錄這句 / 提起）也是
        const mutedOut = (useDecisions.getState().effects[mediaId] ?? [])
          .filter((e) => e.kind === "mute")
          .map((e) => ({ startMs: mapSrcToOut(edl.keeps, e.startMs), endMs: mapSrcToOut(edl.keeps, e.endMs) }));
        const skipCorrOutSpans = [...(useVerify.getState().lastOutput[mediaId]?.fxSpans ?? []).filter((s) => !s.correlated), ...mutedOut];
        splice = auditSplice(srcLocal, parseAnalysis(buf), edl, { mixedWithOverlays: hasOverlays, skipCorrOutSpans });
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

    step(t("本機辨識中…"));
    const server = (await api.localAsrTranscribe(jobId, prep.upload_path, settings.asr_model, settings.asr_language)) as ServerTranscript;
    step(t("逐字比對"));
    const outTr = normalizeTranscript(server);
    const muted = (useDecisions.getState().effects[mediaId] ?? []).filter((e) => e.kind === "mute");
    const report = verifyEdit(expectedWords(tr, edl, muted), actualWords(outTr), edl, {
      outDurationMs: actualOutMs,
      // 成品時間軸的期望值要含接點帳（crossfade 扣重疊、gap 加 room tone）。
      // 用 keptMs 的話每刀差約 20 ms，2–3 刀就會誤報「時長不符」。
      expectedDurationMs: useVerify.getState().lastOutput[mediaId]?.expectedOutMs ?? edlOutDurationMs(edl),
    });
    // 重錄的段落：成品裡是新錄的 take，逐字稿還是舊的那一句 —— 多出來的字不算「該剪沒剪」，降成低信心
    const redubSpans = resolveOverlays(useDecisions.getState().overlays[mediaId] ?? [], edl.keeps)
      .filter((o) => o.role === "redub")
      .map((o) => ({ startMs: o.outStartMs - 300, endMs: o.outStartMs + (o.srcOutMs - o.srcInMs) + 300 }));
    if (redubSpans.length) {
      for (const f of report.findings) {
        if (f.kind === "extra" && redubSpans.some((s) => f.outMs >= s.startMs && f.outMs <= s.endMs)) f.lowConfidence = true;
      }
    }
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
