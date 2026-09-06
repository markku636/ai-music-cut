// 輸出流程：EDL → 響度單元 / 增益 → RenderPlan → Rust（串流剪接 + loudnorm 兩趟）；進度 / 完成事件回報。
import { listen } from "@tauri-apps/api/event";
import { api, type LoudnormStats, type RenderDone, type RenderJoin, type RenderOverlay, type RenderPlan, type RenderProgress, type RenderSeg } from "../api";
import type { Edl } from "../analysis/edl/build";
import { DEFAULT_EDL_OPTIONS } from "../analysis/edl/build";
import { buildChapters, toFfmetadata, type Chapter } from "../analysis/chapters";
import { clipOverlays, clipUnits } from "../analysis/clip";
import { outputDurationWithOverlays } from "../analysis/overlays";
import { mapSrcToOut } from "../analysis/edl/map";
import { effectiveXfMs, planOutDurationMs } from "../analysis/edl/joins";
import { DEFAULT_GAIN_OPTIONS, measureUnits, planGains } from "../analysis/loudness/plan";
import { splitUnits } from "../analysis/loudness/units";
import { t } from "../i18n";
import { useDecisions } from "../store/decisions";
import { newJobId, useJobs } from "../store/jobs";
import { useProject, type MediaItem } from "../store/project";
import { useVerify } from "../store/verify";
import { useTranscript } from "../store/transcript";
import { edlFor } from "./rules";

export type RenderFormat = "mp3" | "m4a" | "wav";

export interface RenderOptions {
  format: RenderFormat;
  outPath: string;
  leveling: boolean;
  targetLufs: number;
  /**
   * 預覽模式：剪接完全一樣，只跳過響度正規化的兩趟（改成 limiter + mp3 q5）。
   * 不會寫進「最近一次輸出」—— 驗收要對的是成品，不是預覽檔。
   */
  preview?: boolean;
  /** 分軌輸出：full = 完整混音、voice = 只有人聲（不含 overlays）、music = 只有 overlays。 */
  stem?: "full" | "voice" | "music";
  /** 沿用主混音那一趟的響度量測（分軌一定要帶，各軌才加得回原本的混音）。 */
  loudnormMeasured?: LoudnormStats | null;
  /**
   * 只輸出這一段（**來源**時間）。剪輯、配樂、閃避全部照舊，只是頭尾被夾掉；
   * 專案本身不動。社群短片用。
   */
  rangeMs?: { startMs: number; endMs: number } | null;
}

function sep(p: string): string {
  return p.includes("\\") ? "\\" : "/";
}

export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(0, i) : "";
}

export function defaultOutPath(media: MediaItem, format: RenderFormat, outputDir: string | null): string {
  const dir = outputDir?.trim() || dirname(media.path);
  const base = media.name.replace(/\.[^.]+$/, "");
  return `${dir}${sep(dir || media.path)}${base}_cut.${format}`;
}

export interface BuiltPlan {
  plan: RenderPlan;
  edl: Edl;
  units: number;
  gains: { unitId: number; gainDb: number }[];
  /** 這份計畫預期會產出多長（毫秒）。驗收比對成品時間軸要用這個，不是 edl.stats.keptMs。 */
  expectedOutMs: number;
  /** 會寫進成品的章節（成品時間軸）。 */
  chapters: Chapter[];
}

export function buildRenderPlan(mediaId: string, opts: RenderOptions): BuiltPlan | null {
  const proj = useProject.getState();
  const media = proj.media.find((m) => m.id === mediaId);
  const tr = useTranscript.getState().byMedia[mediaId];
  const local = useTranscript.getState().local[mediaId];
  const edl = edlFor(mediaId);
  if (!media || !edl) return null;
  const allUnits = splitUnits(edl.keeps, tr?.vad ?? []);
  // 只輸出一段：把響度單元夾在來源範圍內。範圍是連續的，所以只有頭尾會被切，
  // 中間不會出現洞 —— 接點因此可以原樣沿用。
  const units = opts.rangeMs ? clipUnits(allUnits, opts.rangeMs) : allUnits;
  if (!units.length) return null;
  const measured = local ? measureUnits(units, local) : units.map((u) => ({ ...u, lufs: null, peakDb: 0 }));
  const gains = opts.leveling && local ? planGains(measured, { ...DEFAULT_GAIN_OPTIONS, targetLufs: opts.targetLufs }) : units.map((u) => ({ unitId: u.id, gainDb: 0 }));
  const segs: RenderSeg[] = units.map((u, i) => ({ src_start_ms: u.startMs, src_end_ms: u.endMs, gain_db: gains[i]?.gainDb ?? 0 }));
  const joins: RenderJoin[] = [];
  for (let i = 0; i + 1 < units.length; i++) {
    if (units[i].keepId === units[i + 1].keepId) {
      // 同一保留段內的響度單元邊界：直接接，不淡也不重疊
      joins.push({ kind: "seam", ms: 0 });
      continue;
    }
    const j = edl.joins.find((x) => x.afterKeepId === units[i].keepId);
    if (j?.kind === "seam") {
      // 刀片切點：直接對接。**不可以**落到下面的 crossfade 分支 —— crossfade 是重疊，
      // 兩段各會被吃掉半個重疊長度，使用者只是切一刀卻聽到少了一塊。
      joins.push({ kind: "seam", ms: 0 });
      continue;
    }
    if (j?.kind === "gap") {
      // per-join 的淡出 / 淡入（EDL 的 fade policy 決定）；沒有就讓 Rust 用預設值
      joins.push({ kind: "gap", ms: j.ms, fade_out_ms: j.fadeOutMs, fade_in_ms: j.fadeInMs });
      continue;
    }
    // EDL 的 crossfade 是依「保留段」長度夾過的；送進 Rust 的是「單元」，
    // 所以要用單元長度重夾一次，兩邊的長度帳才會一致。
    const spec = j?.ms ?? DEFAULT_EDL_OPTIONS.crossfadeMs;
    const ms = effectiveXfMs(spec, units[i].endMs - units[i].startMs, units[i + 1].endMs - units[i + 1].startMs);
    joins.push({ kind: "crossfade", ms });
  }
  const channels = Math.max(1, Math.min(2, media.probe?.audio?.channels ?? 1));
  const effects = (useDecisions.getState().effects[mediaId] ?? []).map((e) => ({ kind: e.kind, start_ms: e.startMs, end_ms: e.endMs, db: e.db ?? 0 }));
  // 章節：標記是釘在來源上的，要換算成成品時間才寫進檔案
  const mainOutMs = planOutDurationMs(
    segs.map((sg) => ({ startMs: sg.src_start_ms, endMs: sg.src_end_ms })),
    joins,
  );
  // 章節只寫進完整成品：一段 60 秒的預告不需要章節，而且時間軸原點不一樣
  const chapters = opts.rangeMs ? [] : buildChapters(useDecisions.getState().markers[mediaId] ?? [], edl, { outDurationMs: mainOutMs });
  // 墊樂 / 音效。**先夾再轉成 RenderOverlay** —— 夾的邏輯用的是 store 的欄位名，
  // 而且只輸出一段時要連來源進出點一起移（不然音樂會從頭重播）。
  // 配樂的位置是成品時間，所以要先知道選取起點落在成品的哪裡。
  const storeOverlays = useDecisions.getState().overlays[mediaId] ?? [];
  const outOffsetMs = opts.rangeMs ? mapSrcToOut(edl.keeps, opts.rangeMs.startMs) : 0;
  const kept = opts.rangeMs ? clipOverlays(storeOverlays, outOffsetMs, mainOutMs) : storeOverlays;
  const clipped: RenderOverlay[] = [];
  for (const o of kept) {
    const srcMedia = proj.media.find((m) => m.id === o.mediaId);
    if (!srcMedia) continue; // 來源被移出媒體清單了 —— 靜靜跳過比讓整個輸出失敗好
    clipped.push({
      path: srcMedia.path,
      src_start_ms: o.srcInMs,
      src_end_ms: o.srcOutMs,
      out_start_ms: o.outStartMs,
      gain_db: o.gainDb,
      fade_in_ms: o.fadeInMs,
      fade_out_ms: o.fadeOutMs,
      points: o.points ?? [],
      lane: o.lane,
    });
  }

  return {
    plan: {
      segs,
      effects,
      joins,
      // 只當 fallback：joins[].ms 都帶了實際值，Rust 端只有在遇到舊 plan（ms=0）時才會用到它。
      crossfade_ms: DEFAULT_EDL_OPTIONS.crossfadeMs,
      preview: opts.preview === true,
      target_lufs: opts.targetLufs,
      true_peak_dbtp: -1.5,
      format: opts.format,
      out_path: opts.outPath,
      channels,
      ...(chapters.length ? { chapters_meta: toFfmetadata(chapters) } : {}),
      // 人聲 stem 不帶 overlays；配樂 stem 把主聲軌靜音
      ...(clipped.length && opts.stem !== "voice" ? { overlays: clipped } : {}),
      ...(opts.stem === "music" ? { mute_main: true } : {}),
      ...(opts.loudnormMeasured ? { loudnorm_measured: opts.loudnormMeasured } : {}),
    },
    edl,
    units: units.length,
    gains,
    // 片尾曲可能比最後一句話還晚結束 —— 驗收要對的是成品實際長度
    expectedOutMs: outputDurationWithOverlays(mainOutMs, kept),
    chapters,
  };
}

/** 啟動輸出並等待完成（工作列可取消）。 */
export async function runRender(mediaId: string, opts: RenderOptions, onProgress?: (p: RenderProgress) => void): Promise<RenderDone> {
  const proj = useProject.getState();
  const media = proj.media.find((m) => m.id === mediaId);
  if (!media) throw new Error(t("找不到媒體"));
  const built = buildRenderPlan(mediaId, opts);
  if (!built) throw new Error(t("無法建立輸出計畫（媒體尚未探測）"));
  const jobs = useJobs.getState();
  const jobId = newJobId();
  jobs.upsert({ id: jobId, kind: "render", mediaId, step: t("剪接"), pct: 0, status: "running", message: opts.outPath, cancel: () => void api.renderCancel(jobId) });
  const STAGE: Record<RenderProgress["stage"], string> = { cut: t("剪接"), measure: t("量測響度"), encode: t("響度正規化 + 編碼") };
  const WEIGHT: Record<RenderProgress["stage"], [number, number]> = { cut: [0, 45], measure: [45, 55], encode: [55, 100] };
  // 監聽器必須先掛好再啟動（失敗很快時 render-done 會早於監聽器註冊）
  let resolveDone: (r: RenderDone) => void = () => {};
  const done = new Promise<RenderDone>((resolve) => (resolveDone = resolve));
  const unProg = await listen<RenderProgress>("render-progress", (ev) => {
    if (ev.payload.job_id !== jobId) return;
    const [a, b] = WEIGHT[ev.payload.stage];
    jobs.upsert({ id: jobId, step: STAGE[ev.payload.stage], pct: Math.round(a + ((b - a) * ev.payload.pct) / 100) });
    onProgress?.(ev.payload);
  });
  const unDone = await listen<RenderDone>("render-done", (ev) => {
    if (ev.payload.job_id === jobId) resolveDone(ev.payload);
  });
  void api.clientLog(`[render] start job=${jobId} segs=${built.plan.segs.length} out=${opts.outPath}`).catch(() => {});
  try {
    await api.renderStart(jobId, media.path, built.plan);
  } catch (e) {
    unProg();
    unDone();
    jobs.upsert({ id: jobId, status: "error", step: t("失敗"), error: String(e), endedAt: Date.now() });
    throw e;
  }
  const r = await done;
  unProg();
  unDone();
  void api.clientLog(`[render] done ok=${r.ok} err=${r.error ?? ""} lufs=${r.output_lufs ?? ""}`).catch(() => {});
  if (r.ok) {
    // 預覽檔不算「最近一次輸出」：驗收要對的是成品
    if (r.out_path && !opts.preview && (opts.stem ?? "full") === "full")
      useVerify.getState().setLastOutput(mediaId, {
        path: r.out_path,
        expectedOutMs: built.expectedOutMs,
        outputLufs: r.output_lufs,
        outputTp: r.output_tp,
        targetLufs: opts.targetLufs,
      });
    jobs.upsert({ id: jobId, status: "done", step: t("完成"), pct: 100, message: `${r.out_path ?? ""} · ${r.output_lufs?.toFixed(1) ?? "?"} LUFS`, endedAt: Date.now() });
  } else if (r.error === "已取消") {
    jobs.upsert({ id: jobId, status: "canceled", step: t("已取消"), endedAt: Date.now() });
  } else {
    jobs.upsert({ id: jobId, status: "error", step: t("失敗"), error: r.error ?? t("未知錯誤"), endedAt: Date.now() });
  }
  return r;
}
