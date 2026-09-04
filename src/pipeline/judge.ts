// AI 判讀：逐視窗呼叫 claude（結構化輸出）→ 驗證 → 併入決策。視窗以內容雜湊快取在專案 analysis 記錄。
import { api, errMessage } from "../api";
import { JUDGE_SYSTEM_PROMPT, renderWindow } from "../analysis/llm/prompt";
import { JUDGE_SCHEMA } from "../analysis/llm/schema";
import { validateJudge, type ValidatedJudge } from "../analysis/llm/validate";
import { makeWindows } from "../analysis/llm/windows";
import type { Candidate } from "../analysis/types";
import { replyLanguageLine, t, useLang } from "../i18n";
import { useDecisions } from "../store/decisions";
import { newJobId, useJobs } from "../store/jobs";
import { useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { useTranscript } from "../store/transcript";
import { toast } from "../ui";

interface CachedWindow {
  hash: string;
  updates: ValidatedJudge["updates"];
  added: Candidate[];
  at: string;
}

const CONCURRENCY = 2;

export async function runJudge(mediaId: string): Promise<void> {
  const tr = useTranscript.getState().byMedia[mediaId];
  if (!tr) throw new Error(t("尚未分析"));
  const claude = useSettings.getState().claude ?? (await api.claudeDetect().catch(() => null));
  if (!claude?.installed) {
    toast.error(t("找不到 claude CLI，無法 AI 判讀（規則層結果仍可用）"));
    return;
  }
  const d = useDecisions.getState();
  const candidates = (d.candidates[mediaId] ?? []).filter((c) => c.source !== "user");
  const decisions = d.decisions[mediaId] ?? {};
  const windows = makeWindows(tr, candidates);
  if (!windows.length) {
    toast.info(t("沒有需要判讀的候選"));
    return;
  }
  const jobs = useJobs.getState();
  const jobId = newJobId();
  let canceled = false;
  jobs.upsert({ id: jobId, kind: "judge", mediaId, step: t("AI 判讀"), pct: 0, status: "running", message: t("{n} 個視窗", { n: windows.length }), cancel: () => (canceled = true) });

  const rec = (useProject.getState().analysis[mediaId] ?? {}) as Record<string, unknown>;
  const cache = { ...((rec.llm as Record<string, CachedWindow> | undefined) ?? {}) };
  const model = useSettings.getState().s.claude_model || "sonnet";
  const lang = replyLanguageLine(useLang.getState().lang);
  const sys = lang ? `${JUDGE_SYSTEM_PROMPT}\n${lang}` : JUDGE_SYSTEM_PROMPT;

  let done = 0;
  let failed = 0;
  const allUpdates: ValidatedJudge["updates"] = [];
  const allAdded: Candidate[] = [];
  const warnings: string[] = [];

  const worker = async () => {
    for (;;) {
      if (canceled) return;
      const w = windows.shift();
      if (!w) return;
      const hit = cache[w.id + ":" + w.hash] ?? Object.values(cache).find((c) => c.hash === w.hash);
      if (hit) {
        allUpdates.push(...hit.updates);
        allAdded.push(...hit.added);
      } else {
        const r = renderWindow(tr, w, candidates, decisions);
        try {
          let raw = await api.claudeStructured(r.prompt, JUDGE_SCHEMA, model, sys, 240_000);
          let v = validateJudge(raw, w, r.alias, tr, candidates);
          if (v.warnings.includes("輸出不符 schema")) {
            raw = await api.claudeStructured(`${r.prompt}\n\n（上次輸出不符 schema，請只輸出符合 schema 的 JSON）`, JUDGE_SCHEMA, model, sys, 240_000);
            v = validateJudge(raw, w, r.alias, tr, candidates);
          }
          allUpdates.push(...v.updates);
          allAdded.push(...v.added);
          warnings.push(...v.warnings.map((x) => `${w.id}: ${x}`));
          cache[w.id + ":" + w.hash] = { hash: w.hash, updates: v.updates, added: v.added, at: new Date().toISOString() };
        } catch (e) {
          failed += 1;
          warnings.push(`${w.id}: ${errMessage(e)}`);
        }
      }
      done += 1;
      jobs.upsert({ id: jobId, pct: Math.round((done / (done + windows.length)) * 100), message: t("{d} / {n} 視窗", { d: done, n: done + windows.length }) });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, windows.length) }, worker));

  if (canceled) {
    jobs.upsert({ id: jobId, status: "canceled", step: t("已取消"), endedAt: Date.now() });
    return;
  }
  useDecisions.getState().applyJudge(mediaId, allUpdates, allAdded, useProject.getState().aggressiveness);
  useProject.getState().setAnalysis(mediaId, { ...rec, llm: cache, judgedAt: new Date().toISOString() });
  const applied = allUpdates.filter((u) => u.state === "auto").length;
  const pending = allUpdates.filter((u) => u.state === "pending").length + allAdded.length;
  const dropped = allUpdates.filter((u) => u.state === "rejected").length;
  const summary = t("AI 判讀完成：剪 {a}、建議 {p}、不剪 {d}，新增建議 {n}", { a: applied, p: pending, d: dropped, n: allAdded.length });
  jobs.upsert({ id: jobId, status: failed ? "error" : "done", step: failed ? t("部分失敗") : t("完成"), pct: 100, message: summary, error: failed ? warnings.slice(-3).join("；") : undefined, endedAt: Date.now() });
  if (failed) toast.error(t("AI 判讀有 {n} 個視窗失敗（其餘已套用）", { n: failed }));
  else toast.success(summary);
  if (warnings.length) console.warn("[judge] warnings", warnings);
}
