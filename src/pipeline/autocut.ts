import {
  DEFAULT_FILLER_PLAN,
  DEFAULT_STEPS,
  planFillerCuts,
  RELIABLE_KINDS,
  savedOf,
  type AutoCutReport,
  type AutoCutSteps,
} from "../analysis/autocut";
import { estimateCleanup, isCleanupActive } from "../analysis/cleanup";
import { t } from "../i18n";
import { useCleanup } from "../store/cleanup";
import { useDecisions } from "../store/decisions";
import { useProject } from "../store/project";
import { useShowNotes } from "../store/showNotes";
import { useTranscript } from "../store/transcript";
import { runAnalyze } from "./analyze";
import { runJudge } from "./judge";
import { edlFor, runRulesFor } from "./rules";
import { generateShowNotes } from "./shownotes";
import { ensureLocalAnalysis } from "./waveform";

/**
 * 一鍵粗剪：把「開檔之後每次都要做一遍」的那幾件事串起來。
 *
 * 這不是要取代人的判斷 —— 它只做**規則層有把握**的部分，
 * unclear / 離題 / 重講那些一律留著問人（`SUGGEST_ONLY_KINDS`）。
 *
 * 為什麼值得做：實測一集 57 分鐘的真實 podcast，光是規則層自動剪 + 接受可靠類別
 * + 批次剪三個口頭禪就省了 6.2 分鐘（10.9%），而且 1.6 秒跑完。
 * 但那一集同時有 1445 筆待決候選 —— 人要面對的其實是那個，不是剪輯本身。
 *
 * **每一步都是獨立的 undo 單位**，不做成一整包：使用者想反悔「批次剪口頭禪」
 * 但保留其他步驟時，才不用整個重來。
 */

export interface AutoCutProgress {
  /** 0–1；不知道進度時給 null。 */
  ratio: number | null;
  label: string;
}

export interface AutoCutOptions {
  steps?: Partial<AutoCutSteps>;
  onProgress?: (p: AutoCutProgress) => void;
  /** 回 true 表示使用者按了取消。 */
  isCancelled?: () => boolean;
}

export class AutoCutCancelled extends Error {}

export async function runAutoCut(mediaId: string, opts: AutoCutOptions = {}): Promise<AutoCutReport> {
  const steps: AutoCutSteps = { ...DEFAULT_STEPS, ...opts.steps };
  const report: AutoCutReport = {
    lines: [],
    srcMs: 0,
    outMs: 0,
    savedByStep: [],
    acceptedCount: 0,
    fillerCuts: 0,
    cleanupApplied: false,
    judged: false,
    notesWritten: false,
    pendingCount: 0,
  };

  const media = useProject.getState().media.find((m) => m.id === mediaId);
  if (!media) throw new Error(t("找不到這個音檔"));
  const check = () => {
    if (opts.isCancelled?.()) throw new AutoCutCancelled(t("已取消"));
  };
  const say = (ratio: number | null, label: string) => opts.onProgress?.({ ratio, label });
  const outNow = () => edlFor(mediaId)?.stats.outMs ?? 0;
  /** 跑一步並記下它省了多少 —— 使用者想知道的是「哪一步幫上忙」，不是總數。 */
  const step = async (label: string, fn: () => Promise<void> | void) => {
    const before = outNow();
    await fn();
    const savedMs = Math.max(0, before - outNow());
    report.savedByStep.push({ label, savedMs });
  };

  report.srcMs = media.probe?.duration_ms ?? 0;

  // 1) 波形（只需 ffmpeg，快取命中幾乎即時）
  say(0.05, t("讀取波形…"));
  await ensureLocalAnalysis(mediaId).catch(() => {});
  check();

  // 2) 逐字稿：沒有才跑（ASR 是整條流程裡最慢的一步，有快取就別重跑）
  if (!useTranscript.getState().byMedia[mediaId]) {
    say(0.1, t("語音辨識中…（這一步最久）"));
    await runAnalyze(mediaId);
    check();
  }
  const tr = useTranscript.getState().byMedia[mediaId] ?? null;
  if (!tr) throw new Error(t("沒有逐字稿，無法自動粗剪"));
  report.lines.push(t("逐字稿 {n} 字").replace("{n}", String(tr.words.length)));

  // 3) 規則層（沒有候選才跑；已經有就沿用，不要蓋掉使用者已經做過的決定）
  const d = () => useDecisions.getState();
  if (!(d().candidates[mediaId] ?? []).length) {
    say(0.35, t("找出可以剪的段落…"));
    const n = runRulesFor(mediaId, { label: t("一鍵粗剪：規則層"), record: true });
    report.lines.push(t("規則層提出 {n} 個候選").replace("{n}", String(n)));
    check();
  }

  // 4) 接受規則層有把握的類別
  if (steps.reliable) {
    say(0.45, t("接受有把握的剪點…"));
    await step(t("接受有把握的剪點"), () => {
      const n = d().bulk(mediaId, (c) => RELIABLE_KINDS.includes(c.kind), "accepted", t("一鍵粗剪：接受可靠類別"));
      report.acceptedCount = n;
      report.lines.push(t("自動接受 {n} 個贅字 / 口吃 / 長停頓 / 重講").replace("{n}", String(n)));
    });
    check();
  }

  // 5) 批次剪重複的口頭禪
  if (steps.fillers) {
    say(0.55, t("清掉重複的口頭禪…"));
    await step(t("清掉重複的口頭禪"), () => {
      const plan = planFillerCuts(tr, report.srcMs, DEFAULT_FILLER_PLAN);
      let cut = 0;
      for (const item of plan) {
        d().addManualCuts(
          mediaId,
          item.hits.map((h) => ({ startMs: h.startMs, endMs: h.endMs, wordIds: h.wordIds, sentenceId: h.sentenceId })),
          t("一鍵粗剪：口頭禪「{q}」").replace("{q}", item.query),
          t("剪掉「{q}」×{n}").replace("{q}", item.query).replace("{n}", String(item.hits.length)),
        );
        cut += item.hits.length;
      }
      report.fillerCuts = cut;
      if (plan.length) report.lines.push(t("剪掉 {n} 處口頭禪（{list}）").replace("{n}", String(cut)).replace("{list}", plan.map((p) => `${p.query}×${p.count}`).join("、")));
      else report.lines.push(t("沒有值得批次剪的口頭禪"));
    });
    check();
  }

  // 6) 修聲（只在量得到、而且值得做的時候）
  if (steps.cleanup) {
    say(0.65, t("量底噪…"));
    const local = useTranscript.getState().local[mediaId] ?? null;
    const est = estimateCleanup(local);
    if (est.worthDenoise && isCleanupActive(est.suggested)) {
      useCleanup.getState().set(mediaId, est.suggested);
      report.cleanupApplied = true;
      report.lines.push(est.summary);
    } else {
      report.lines.push(t("底噪已經夠低，不做降噪"));
    }
    check();
  }

  // 7) AI 判讀（慢，預設不開）
  if (steps.judge) {
    say(0.75, t("claude 逐段判讀…"));
    await step(t("AI 判讀"), async () => {
      await runJudge(mediaId);
      report.judged = true;
    });
    check();
  }

  // 8) 節目筆記與章節（慢，預設不開）
  if (steps.notes) {
    say(0.9, t("claude 寫節目筆記…"));
    const notes = await generateShowNotes(mediaId);
    useShowNotes.getState().set(mediaId, notes);
    report.notesWritten = true;
    report.lines.push(t("節目筆記完成：{n} 個章節").replace("{n}", String(notes.chapters.length)));
    check();
  }

  report.outMs = outNow();
  const cands = d().candidates[mediaId] ?? [];
  const dec = d().decisions[mediaId] ?? {};
  report.pendingCount = cands.filter((c) => (dec[c.id]?.state ?? "pending") === "pending").length;
  const s = savedOf(report);
  report.lines.push(t("共短了 {min} 分鐘（{pct}%）").replace("{min}", (s.ms / 60000).toFixed(1)).replace("{pct}", s.percent.toFixed(1)));
  say(1, t("完成"));
  return report;
}
