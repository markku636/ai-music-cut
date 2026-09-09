// 批次處理：一次把好幾集從「開檔」帶到「成品」。
//
// 為什麼要有這個：這個 App 每一步都做得不錯，但一個週更的 podcast 主持人手上
// 常常同時有好幾集（補錄的、上週沒剪完的、分段錄的）。市售的 Auphonic / Descript
// 都有批次，而這裡的每一支管線本來就吃 mediaId，缺的只是外面那一圈編排。
//
// 三個刻意的設計：
//
// - **一次只跑一集**。ttls 有排隊上限、GPU 只有一張、ffmpeg 的響度正規化是兩趟 CPU 重活；
//   平行跑不會比較快，只會讓三個瓶頸互相踩。這不是「還沒做平行」，是不該平行。
// - **一集失敗不影響其他集**。批次最怕的就是跑到第 4 集掛掉、前 3 集的成果也跟著不見。
//   每一集自己記結果，錯誤留在那一列上。
// - **不自動存檔、不自動蓋掉專案**。批次改的是決策（進 undo），輸出寫的是新檔案；
//   要不要留下來仍然是人的決定。
import { errMessage } from "../api";
import { runAnalyze } from "./analyze";
import { runAutoCut, AutoCutCancelled } from "./autocut";
import { runJudge } from "./judge";
import { defaultOutPath, runRender, type RenderFormat } from "./render";
import { edlFor } from "./rules";
import { t } from "../i18n";
import { useJobs } from "../store/jobs";
import { useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { useTranscript } from "../store/transcript";

export interface BatchSteps {
  /** 轉寫 + 規則層。已經分析過的會跳過（除非 forceTranscribe）。 */
  analyze: boolean;
  /** 一鍵智慧剪輯。 */
  autoCut: boolean;
  /** AI 判讀（慢、要錢）—— 預設關。 */
  judge: boolean;
  /** 輸出成品。 */
  render: boolean;
}

export const DEFAULT_BATCH_STEPS: BatchSteps = { analyze: true, autoCut: true, judge: false, render: true };

export type BatchStepKey = keyof BatchSteps;
export type BatchItemStatus = "pending" | "running" | "done" | "failed" | "canceled";

export interface BatchStepResult {
  key: BatchStepKey;
  ok: boolean;
  /** 跳過的原因，或這一步的結果摘要。 */
  note?: string;
  skipped?: boolean;
}

export interface BatchItemResult {
  mediaId: string;
  name: string;
  status: BatchItemStatus;
  srcMs: number;
  outMs: number;
  savedMs: number;
  outPath?: string;
  error?: string;
  steps: BatchStepResult[];
}

export interface BatchOptions {
  steps?: Partial<BatchSteps>;
  format?: RenderFormat;
  /** 輸出目錄；不給就用設定裡的，再不然放在來源旁邊。 */
  outputDir?: string | null;
  leveling?: boolean;
  targetLufs?: number;
  forceTranscribe?: boolean;
  onProgress?: (p: BatchProgress) => void;
  isCancelled?: () => boolean;
}

export interface BatchProgress {
  /** 現在跑到第幾個（1-based）。 */
  index: number;
  total: number;
  mediaId: string;
  name: string;
  step: BatchStepKey;
  label: string;
  /** 這一集這一步的進度，不知道時給 null。 */
  ratio: number | null;
  /** 已經完成的集數。 */
  finished: number;
}

export interface BatchSummary {
  total: number;
  done: number;
  failed: number;
  canceled: number;
  srcMs: number;
  outMs: number;
  savedMs: number;
  /** 省下的比例（0–1）；沒有來源長度時給 0。 */
  ratio: number;
}

/** 純函式：把每一集的結果加總成一句話能講完的東西。 */
export function summarizeBatch(items: BatchItemResult[]): BatchSummary {
  const s: BatchSummary = { total: items.length, done: 0, failed: 0, canceled: 0, srcMs: 0, outMs: 0, savedMs: 0, ratio: 0 };
  for (const it of items) {
    if (it.status === "done") s.done += 1;
    else if (it.status === "failed") s.failed += 1;
    else if (it.status === "canceled") s.canceled += 1;
    // 只加總真的跑完的：失敗那集的 srcMs 可能是 0，混進去會讓比例失真
    if (it.status === "done") {
      s.srcMs += it.srcMs;
      s.outMs += it.outMs;
      s.savedMs += it.savedMs;
    }
  }
  s.ratio = s.srcMs > 0 ? s.savedMs / s.srcMs : 0;
  return s;
}

/**
 * 哪幾步要對這一集做。
 * 已經有逐字稿就不用再轉寫一次（那是整條路上最慢、最花錢的一步）。
 */
export function planForMedia(
  steps: BatchSteps,
  ctx: { hasTranscript: boolean; forceTranscribe: boolean },
): { key: BatchStepKey; run: boolean; skipNote?: string }[] {
  return [
    {
      key: "analyze",
      run: steps.analyze && (!ctx.hasTranscript || ctx.forceTranscribe),
      skipNote: steps.analyze && ctx.hasTranscript && !ctx.forceTranscribe ? "已經有逐字稿" : undefined,
    },
    { key: "autoCut", run: steps.autoCut },
    { key: "judge", run: steps.judge },
    { key: "render", run: steps.render },
  ];
}

export class BatchCancelled extends Error {}

/** 取消正在跑的 analyze —— 它自己開的 AbortController 綁在 job 上，只能從 job 那裡按。 */
function cancelAnalyzeJob(mediaId: string): void {
  const j = useJobs.getState().jobs.find((x) => x.kind === "analyze" && x.mediaId === mediaId && x.status === "running");
  if (j) useJobs.getState().cancel(j.id);
}

export async function runBatch(mediaIds: string[], opts: BatchOptions = {}): Promise<BatchItemResult[]> {
  const steps: BatchSteps = { ...DEFAULT_BATCH_STEPS, ...opts.steps };
  const settings = useSettings.getState().s;
  const format = opts.format ?? "mp3";
  const outputDir = opts.outputDir ?? settings.output_dir ?? null;
  const leveling = opts.leveling ?? true;
  const targetLufs = opts.targetLufs ?? settings.target_lufs ?? -16;
  const results: BatchItemResult[] = [];
  const cancelled = () => opts.isCancelled?.() ?? false;
  // 這一批已經配出去的成品路徑，以及所有來源檔（都用小寫比：Windows 大小寫不分）。
  // podcast 的檔案結構常常是 ep01/recording.wav、ep02/recording.wav —— 指定同一個
  // 輸出資料夾時，只用檔名的話兩集都算出 recording_cut.mp3，第二集會安靜蓋掉第一集。
  const takenOut = new Set<string>();
  const allMedia = useProject.getState().media;
  const sourcePaths: ReadonlySet<string> = new Set(
    mediaIds
      .map((id) => allMedia.find((m) => m.id === id)?.path)
      .filter((p): p is string => !!p)
      .map((p) => p.toLowerCase()),
  );

  for (let i = 0; i < mediaIds.length; i++) {
    const mediaId = mediaIds[i];
    const media = useProject.getState().media.find((m) => m.id === mediaId);
    const item: BatchItemResult = {
      mediaId,
      name: media?.name ?? mediaId,
      status: "running",
      srcMs: 0,
      outMs: 0,
      savedMs: 0,
      steps: [],
    };
    results.push(item);

    if (cancelled()) {
      item.status = "canceled";
      break;
    }
    if (!media) {
      item.status = "failed";
      item.error = t("找不到媒體");
      continue;
    }

    const report = (step: BatchStepKey, label: string, ratio: number | null) =>
      opts.onProgress?.({ index: i + 1, total: mediaIds.length, mediaId, name: item.name, step, label, ratio, finished: i });

    try {
      const plan = planForMedia(steps, {
        hasTranscript: !!useTranscript.getState().byMedia[mediaId],
        forceTranscribe: opts.forceTranscribe ?? false,
      });

      for (const p of plan) {
        if (cancelled()) throw new BatchCancelled();
        if (!p.run) {
          if (steps[p.key]) item.steps.push({ key: p.key, ok: true, skipped: true, note: p.skipNote });
          continue;
        }

        if (p.key === "analyze") {
          report("analyze", t("分析（轉寫 + 規則）"), null);
          // runAnalyze 自己開 AbortController 綁在它的 job 上，外面只能從 job 按取消
          const watch = window.setInterval(() => {
            if (cancelled()) cancelAnalyzeJob(mediaId);
          }, 500);
          try {
            await runAnalyze(mediaId, { forceTranscribe: opts.forceTranscribe });
          } finally {
            window.clearInterval(watch);
          }
          if (cancelled()) throw new BatchCancelled();
          const tr = useTranscript.getState().byMedia[mediaId];
          item.steps.push({ key: "analyze", ok: !!tr, note: tr ? t("{n} 個字", { n: tr.words.length }) : t("沒有逐字稿") });
          if (!tr) throw new Error(t("分析沒有產生逐字稿"));
        }

        if (p.key === "autoCut") {
          const r = await runAutoCut(mediaId, {
            onProgress: (pr) => report("autoCut", pr.label, pr.ratio),
            isCancelled: cancelled,
          });
          item.srcMs = r.srcMs;
          item.outMs = r.outMs;
          item.savedMs = Math.max(0, r.srcMs - r.outMs);
          item.steps.push({ key: "autoCut", ok: true, note: t("省 {s}", { s: fmtMin(item.savedMs) }) });
        }

        if (p.key === "judge") {
          report("judge", t("AI 判讀"), null);
          await runJudge(mediaId);
          item.steps.push({ key: "judge", ok: true });
        }

        if (p.key === "render") {
          const outPath = defaultOutPath(media, format, outputDir, takenOut, sourcePaths);
          report("render", t("輸出"), 0);
          const r = await runRender(mediaId, { format, outPath, leveling, targetLufs }, (pr) =>
            report("render", t("輸出"), pr.pct / 100),
          );
          if (!r.ok) throw new Error(r.error ?? t("輸出失敗"));
          item.outPath = r.out_path ?? outPath;
          item.steps.push({ key: "render", ok: true, note: r.output_lufs != null ? `${r.output_lufs.toFixed(1)} LUFS` : undefined });
        }
      }

      // 沒跑智慧剪輯但跑了輸出時，長度資訊還是要有 —— 報告上「省了多少」是使用者唯一在意的數字
      if (!item.srcMs) {
        const edl = edlFor(mediaId);
        if (edl) {
          item.outMs = edl.stats.outMs;
          // 用 stats.srcMs，不要湊 keptMs + removedMs —— 貼上會讓 keptMs 把同一段
          // 來源算兩次，「省了多少」就跟著虛報（v0.116 起 srcMs 是 EDL 的一等公民）。
          item.srcMs = edl.stats.srcMs;
          item.savedMs = Math.max(0, item.srcMs - item.outMs);
        }
      }
      item.status = "done";
    } catch (e) {
      if (e instanceof BatchCancelled || e instanceof AutoCutCancelled) {
        item.status = "canceled";
        break;
      }
      // 一集失敗不影響其他集 —— 批次最怕跑到第 4 集掛掉、前 3 集的成果也跟著不見
      item.status = "failed";
      item.error = errMessage(e);
    }
  }
  return results;
}

function fmtMin(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s}s`;
}
