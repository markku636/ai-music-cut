// AI 判讀：逐視窗呼叫 claude（結構化輸出）→ 驗證 → 併入決策。視窗以內容雜湊快取在專案 analysis 記錄。
import { api, errMessage } from "../api";
import { renderWindow } from "../analysis/llm/prompt";
import { resolvePrompt } from "../analysis/prompts";
import { reviewWindow } from "./agents/reviewer";
import type { Opinion } from "../analysis/types";
import { JUDGE_SCHEMA } from "../analysis/llm/schema";
import { validateJudge, type ValidatedJudge } from "../analysis/llm/validate";
import { makeWindows } from "../analysis/llm/windows";
import type { Candidate } from "../analysis/types";
import { t, uiLanguageLine } from "../i18n";
import { useDecisions } from "../store/decisions";
import { newJobId, useJobs } from "../store/jobs";
import { useProject } from "../store/project";
import { agentBackend, useSettings } from "../store/settings";
import { useTranscript } from "../store/transcript";
import { toast } from "../ui";

interface CachedWindow {
  hash: string;
  updates: ValidatedJudge["updates"];
  added: Candidate[];
  at: string;
}

/**
 * 審核的快取獨立一張表（rec.llmReview），不跟剪輯共用。
 * 共用同一張表的話，`Object.values(cache).find(c => c.hash === w.hash)` 那條
 * 「同雜湊即命中」的捷徑會讓審核吃到剪輯的結果 —— 等於根本沒有第二個意見。
 */
interface CachedReview {
  hash: string;
  opinions: Record<string, Opinion>;
  at: string;
}

const CONCURRENCY = 2;

export async function runJudge(mediaId: string): Promise<void> {
  // 設定裡的總開關。擋在這裡而不是各個呼叫端 —— 工具列、一鍵智慧剪輯、批次三條路都會
  // 走到這支，擋在入口才不會漏掉其中一條。
  if (!useSettings.getState().s.judge_enabled) {
    toast.info(t("AI 判讀在設定裡被關掉了（規則層結果仍可用）"));
    return;
  }
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
  // 判讀理由是給**剪輯的人**看的，所以跟著介面語言，不跟著節目語言
  const lang = uiLanguageLine();
  // 兩個角色的人格設定都可以在「提示詞」對話框改；語言指示是執行期接上去的
  const editorBase = resolvePrompt("editor");
  const reviewerBase = resolvePrompt("reviewer");
  const sys = lang ? `${editorBase}\n${lang}` : editorBase;
  const reviewSys = lang ? `${reviewerBase}\n${lang}` : reviewerBase;
  const st = useSettings.getState().s;
  const withReviewer = (st.judge_roles || "editor+reviewer").includes("reviewer");
  const reviewModel = st.claude_review_model || "haiku";
  const reviewCache = { ...((rec.llmReview as Record<string, CachedReview> | undefined) ?? {}) };
  // 兩趟：先剪輯提議、再審核覆核。進度分兩段，取消在兩段之間都會生效。
  const allWindows = windows.slice();

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
          let raw = await api.claudeStructured(r.prompt, JUDGE_SCHEMA, model, sys, 240_000, agentBackend());
          let v = validateJudge(raw, w, r.alias, tr, candidates);
          if (v.warnings.includes("輸出不符 schema")) {
            raw = await api.claudeStructured(`${r.prompt}\n\n（上次輸出不符 schema，請只輸出符合 schema 的 JSON）`, JUDGE_SCHEMA, model, sys, 240_000, agentBackend());
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

  // ---- 第二趟：審核覆核「剪輯判剪」的候選 ----
  // 只覆核判剪的：keep 是安全方向（不剪不會壞），覆核它沒有價值，還省約 40% token。
  const reviewOpinions: Record<string, Opinion> = {};
  let reviewed = 0;
  if (withReviewer) {
    const cutIds = new Set(allUpdates.filter((u) => u.state === "auto").map((u) => u.id));
    const todo = allWindows.filter((w) => w.candidateIds.some((id) => cutIds.has(id)));
    if (todo.length) {
      jobs.upsert({ id: jobId, step: t("AI 審核"), pct: 0, message: t("{n} 個視窗", { n: todo.length }) });
      let rdone = 0;
      const queue = todo.slice();
      const rworker = async () => {
        for (;;) {
          if (canceled) return;
          const w = queue.shift();
          if (!w) return;
          const key = `${w.id}:${w.hash}:reviewer:v1`;
          const hit = reviewCache[key];
          if (hit) {
            Object.assign(reviewOpinions, hit.opinions);
          } else {
            const r = await reviewWindow(tr, w, candidates, decisions, cutIds, { model: reviewModel, systemPrompt: reviewSys });
            Object.assign(reviewOpinions, r.opinions);
            warnings.push(...r.warnings.map((x) => `review ${x}`));
            if (Object.keys(r.opinions).length) reviewCache[key] = { hash: w.hash, opinions: r.opinions, at: new Date().toISOString() };
          }
          rdone += 1;
          reviewed += 1;
          jobs.upsert({ id: jobId, pct: Math.round((rdone / todo.length) * 100), message: t("{d} / {n} 視窗", { d: rdone, n: todo.length }) });
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, rworker));
    }
  }

  if (canceled) {
    jobs.upsert({ id: jobId, status: "canceled", step: t("已取消"), endedAt: Date.now() });
    return;
  }
  useDecisions.getState().applyOpinions(mediaId, allUpdates, allAdded, reviewOpinions, useProject.getState().aggressiveness);
  useProject.getState().setAnalysis(mediaId, { ...rec, llm: cache, llmReview: reviewCache, judgedAt: new Date().toISOString() });
  const applied = allUpdates.filter((u) => u.state === "auto").length;
  const pending = allUpdates.filter((u) => u.state === "pending").length + allAdded.length;
  const dropped = allUpdates.filter((u) => u.state === "rejected").length;
  const conflicts = Object.entries(reviewOpinions).filter(([id, o]) => o.verdict === "keep" && allUpdates.some((u) => u.id === id && u.state === "auto")).length;
  const summary = withReviewer && reviewed
    ? t("剪輯＋審核完成：剪 {a}、建議 {p}、不剪 {d}，新增建議 {n}；審核推翻 {c} 筆（送你裁決）", { a: applied, p: pending, d: dropped, n: allAdded.length, c: conflicts })
    : t("AI 判讀完成：剪 {a}、建議 {p}、不剪 {d}，新增建議 {n}", { a: applied, p: pending, d: dropped, n: allAdded.length });
  jobs.upsert({ id: jobId, status: failed ? "error" : "done", step: failed ? t("部分失敗") : t("完成"), pct: 100, message: summary, error: failed ? warnings.slice(-3).join("；") : undefined, endedAt: Date.now() });
  if (failed) toast.error(t("AI 判讀有 {n} 個視窗失敗（其餘已套用）", { n: failed }));
  else toast.success(summary);
  if (warnings.length) console.warn("[judge] warnings", warnings);
}
