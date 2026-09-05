// 輸出流程：EDL → 響度單元 / 增益 → RenderPlan → Rust（串流剪接 + loudnorm 兩趟）；進度 / 完成事件回報。
import { listen } from "@tauri-apps/api/event";
import { api, type RenderDone, type RenderJoin, type RenderPlan, type RenderProgress, type RenderSeg } from "../api";
import type { Edl } from "../analysis/edl/build";
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
}

export function buildRenderPlan(mediaId: string, opts: RenderOptions): BuiltPlan | null {
  const proj = useProject.getState();
  const media = proj.media.find((m) => m.id === mediaId);
  const tr = useTranscript.getState().byMedia[mediaId];
  const local = useTranscript.getState().local[mediaId];
  const edl = edlFor(mediaId);
  if (!media || !edl) return null;
  const units = splitUnits(edl.keeps, tr?.vad ?? []);
  const measured = local ? measureUnits(units, local) : units.map((u) => ({ ...u, lufs: null, peakDb: 0 }));
  const gains = opts.leveling && local ? planGains(measured, { ...DEFAULT_GAIN_OPTIONS, targetLufs: opts.targetLufs }) : units.map((u) => ({ unitId: u.id, gainDb: 0 }));
  const segs: RenderSeg[] = units.map((u, i) => ({ src_start_ms: u.startMs, src_end_ms: u.endMs, gain_db: gains[i]?.gainDb ?? 0 }));
  const joins: RenderJoin[] = [];
  for (let i = 0; i + 1 < units.length; i++) {
    if (units[i].keepId === units[i + 1].keepId) joins.push({ kind: "seam", ms: 0 });
    else {
      const j = edl.joins.find((x) => x.afterKeepId === units[i].keepId);
      joins.push({ kind: j?.kind ?? "crossfade", ms: j?.ms ?? 20 });
    }
  }
  const channels = Math.max(1, Math.min(2, media.probe?.audio?.channels ?? 1));
  const effects = (useDecisions.getState().effects[mediaId] ?? []).map((e) => ({ kind: e.kind, start_ms: e.startMs, end_ms: e.endMs, db: e.db ?? 0 }));
  return {
    plan: { segs, effects, joins, crossfade_ms: 20, target_lufs: opts.targetLufs, true_peak_dbtp: -1.5, format: opts.format, out_path: opts.outPath, channels },
    edl,
    units: units.length,
    gains,
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
    if (r.out_path) useVerify.getState().setLastOutput(mediaId, { path: r.out_path, keptMs: built.edl.stats.keptMs });
    jobs.upsert({ id: jobId, status: "done", step: t("完成"), pct: 100, message: `${r.out_path ?? ""} · ${r.output_lufs?.toFixed(1) ?? "?"} LUFS`, endedAt: Date.now() });
  } else if (r.error === "已取消") {
    jobs.upsert({ id: jobId, status: "canceled", step: t("已取消"), endedAt: Date.now() });
  } else {
    jobs.upsert({ id: jobId, status: "error", step: t("失敗"), error: r.error ?? t("未知錯誤"), endedAt: Date.now() });
  }
  return r;
}
