// 轉檔 / 抽聲軌：一批檔案**序列**跑（ffmpeg 一次一個，不搶 CPU），逐檔 try/catch —— 一個壞檔不讓整批停。
import { api, errMessage, type ConvertDone } from "../api";
import { effectiveBitDepth, outPathFor, type ConvertOptions } from "../analysis/convertPlan";
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

/** 一次查一批路徑存不存在（api.pathsExist 的形狀；測試注入假的）。 */
export type PathsExist = (paths: string[]) => Promise<boolean[]>;

function assignOutPaths(srcs: readonly string[], opts: ConvertBatchOptions, taken: Set<string>): string[] {
  const sources = new Set(srcs.map((s) => s.toLowerCase()));
  return srcs.map((s) => outPathFor(s, opts.format, opts.outDir, taken, sources));
}

/**
 * 這一批會輸出到哪些路徑（UI 預告用；與實際跑的分配同一條規則）。
 * 不看磁碟 —— 真正要跑之前用 planOutPathsOnDisk 再避開已存在的檔。
 */
export function planOutPaths(srcs: readonly string[], opts: ConvertBatchOptions): string[] {
  return assignOutPaths(srcs, opts, new Set());
}

/** 最多再排幾輪：每輪把撞到的記成已佔用重排一次，正常情況一兩輪就收斂。 */
const ON_DISK_ROUNDS = 32;

/**
 * 同一條規則，但拿 `exists` 去磁碟上確認：輸出路徑已經有檔（例如 mp3 旁邊的無損母帶）
 * 就當它已佔用、用 `_2`、`_3`… 往後排，排到的新名字再查一次，直到沒有撞的為止。
 * Rust 端的 rename 會直接蓋掉，這裡是唯一的守門。
 * `exists` 失敗（後端沒有 paths_exist 指令）就退回不看磁碟的排法，跟以前一樣。
 */
export async function planOutPathsOnDisk(srcs: readonly string[], opts: ConvertBatchOptions, exists: PathsExist): Promise<string[]> {
  const onDisk = new Set<string>();
  let outs = planOutPaths(srcs, opts);
  for (let round = 0; round < ON_DISK_ROUNDS; round++) {
    let hits: boolean[];
    try {
      hits = await exists(outs);
    } catch {
      return outs;
    }
    const collided = outs.filter((_, i) => hits[i] === true);
    if (!collided.length) return outs;
    for (const p of collided) onDisk.add(p.toLowerCase());
    outs = assignOutPaths(srcs, opts, new Set(onDisk));
  }
  return outs;
}

export async function runConvertBatch(srcs: readonly string[], opts: ConvertBatchOptions, onProgress?: (i: number, r: ConvertResult) => void): Promise<ConvertResult[]> {
  const outs = await planOutPathsOnDisk(srcs, opts, (paths) => api.pathsExist(paths));
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
        // 送實際會編成的深度（FLAC 選 32 → 24），跟 describeConvert 講的一致
        bit_depth: effectiveBitDepth(opts.format, opts.bitDepth) ?? opts.bitDepth,
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
