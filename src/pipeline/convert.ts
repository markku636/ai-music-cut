// 轉檔 / 抽聲軌：一批檔案**序列**跑（ffmpeg 一次一個，不搶 CPU），逐檔 try/catch —— 一個壞檔不讓整批停。
import { api, errMessage, type ConvertDone } from "../api";
import { outPathFor, type ConvertOptions } from "../analysis/convertPlan";
import { t } from "../i18n";
import { newJobId, useJobs } from "../store/jobs";

export interface ConvertResult {
  src: string;
  outPath: string;
  ok: boolean;
  error?: string;
  done?: ConvertDone;
}

export interface ConvertBatchOptions extends ConvertOptions {
  /** null = 各自放在來源旁邊 */
  outDir: string | null;
}

/** 這一批會輸出到哪些路徑（UI 預告用；與實際跑的分配同一條規則）。 */
export function planOutPaths(srcs: readonly string[], opts: ConvertBatchOptions): string[] {
  const taken = new Set<string>();
  const sources = new Set(srcs.map((s) => s.toLowerCase()));
  return srcs.map((s) => outPathFor(s, opts.format, opts.outDir, taken, sources));
}

export async function runConvertBatch(srcs: readonly string[], opts: ConvertBatchOptions, onProgress?: (i: number, r: ConvertResult) => void): Promise<ConvertResult[]> {
  const outs = planOutPaths(srcs, opts);
  const jobs = useJobs.getState();
  const jobId = newJobId();
  let canceled = false;
  jobs.upsert({ id: jobId, kind: "convert", step: t("轉檔"), pct: 0, status: "running", message: `${srcs.length}`, cancel: () => (canceled = true) });
  const results: ConvertResult[] = [];
  for (let i = 0; i < srcs.length; i++) {
    if (canceled) {
      jobs.upsert({ id: jobId, status: "canceled", step: t("已取消"), endedAt: Date.now() });
      break;
    }
    const src = srcs[i];
    const outPath = outs[i];
    jobs.upsert({ id: jobId, step: t("轉檔"), pct: Math.round((i / srcs.length) * 100), message: src });
    let r: ConvertResult;
    try {
      const done = await api.convertFile({
        src,
        out_path: outPath,
        format: opts.format,
        sample_rate: opts.sampleRate,
        channels: opts.channels,
        bit_depth: opts.bitDepth,
        target_lufs: opts.targetLufs,
        true_peak_dbtp: -1.5,
        copy_if_possible: opts.copyIfPossible,
      });
      r = { src, outPath, ok: true, done };
    } catch (e) {
      r = { src, outPath, ok: false, error: errMessage(e) };
    }
    results.push(r);
    onProgress?.(i, r);
  }
  if (!canceled) {
    const failed = results.filter((r) => !r.ok).length;
    jobs.upsert({
      id: jobId,
      status: failed && failed === results.length ? "error" : "done",
      step: failed ? t("完成（{n} 個失敗）", { n: failed }) : t("完成"),
      pct: 100,
      message: `${results.length - failed}/${results.length}`,
      endedAt: Date.now(),
    });
  }
  return results;
}
