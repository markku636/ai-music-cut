// Guide / Dub 時間對齊（VocALign 式）：粗 → 細兩層帶狀 DTW，再把路徑變成分段速率交給 Rust 渲染。
//
// 三種用途、一個引擎、三組預設：
//   adr    補錄一句對回原位：語音特徵 5 ms、粗帶 ±1.5 s、細帶 ±200 ms、tightness 60
//   drift  多麥時鐘漂移：只用 RMS（串音不同、onset 不可靠）、粗帶依時長放大、細帶 ±120 ms、tightness 30
//   music  疊錄 / 和聲：RMS + onset 10 ms、粗帶 ±3 s、細帶 ±200 ms、tightness 70
//   （music 原計畫用 8 帶對數能量；這一版先用 RMS + onset，長音內的路徑可能較鬆 —— 對話框會標明）
import { api } from "../api";
import { bothQuiet, frameDistance, speechFeatures, type AlignFeatures } from "../analysis/align/features";
import { bandedDtw, pathConfidence } from "../analysis/align/dtw";
import { alignVerdict, residualByWindow, type AlignVerdict } from "../analysis/align/residual";
import { applyTightness, pathToWarp, resampleOnly, simplifyWarp, straightenSilence, summarizeWarp, warpAt, warpSegments, type WarpPoint, type WarpSegment, type WarpSummary } from "../analysis/align/warp";
import { estimateOffset } from "../analysis/sync";
import { t } from "../i18n";
import { newJobId, useJobs } from "../store/jobs";
import { useProject } from "../store/project";
import { ensureLocalAnalysis } from "./waveform";

export type AlignMode = "adr" | "drift" | "music";

export interface ModePreset {
  hopMs: number;
  coarseHopMs: number;
  /** 粗帶半寬（毫秒）；drift 另外依時長加。 */
  coarseBandMs: number;
  fineBandMs: number;
  tightness: number;
  onsetWeight: number;
  openEnds: boolean;
}

export const MODE_PRESETS: Record<AlignMode, ModePreset> = {
  adr: { hopMs: 5, coarseHopMs: 100, coarseBandMs: 1500, fineBandMs: 200, tightness: 60, onsetWeight: 1, openEnds: true },
  drift: { hopMs: 5, coarseHopMs: 100, coarseBandMs: 500, fineBandMs: 120, tightness: 30, onsetWeight: 0, openEnds: false },
  music: { hopMs: 10, coarseHopMs: 100, coarseBandMs: 3000, fineBandMs: 200, tightness: 70, onsetWeight: 1, openEnds: true },
};

export interface AlignOptions {
  mode: AlignMode;
  tightness?: number;
  /** guide 只看這一段（ADR：原句所在的視窗）。 */
  guideRange?: { startMs: number; endMs: number } | null;
  /** dub 只看這一段。 */
  dubRange?: { startMs: number; endMs: number } | null;
  /** 保護區（dub 時間）：裡面速率固定 1.0。 */
  protectedAreas?: { startMs: number; endMs: number }[];
}

export interface AlignAnalysis {
  guideId: string;
  dubId: string;
  mode: AlignMode;
  tightness: number;
  points: WarpPoint[];
  segments: WarpSegment[];
  summary: WarpSummary;
  /** 0–1；< 0.3 → 「可能沒對上」。 */
  confidence: number;
  resampleRatio: number | null;
  /** 全域位移（dub → guide，毫秒）。 */
  offsetMs: number;
  /** 顯示用：兩邊的能量包絡（20 ms）。 */
  lanes: { guide: Float32Array; dub: Float32Array; hopMs: number; guideStartMs: number; dubStartMs: number };
  /** 這次分析的細特徵（重算 tightness 不用再跑 DTW）。 */
  rawPoints: WarpPoint[];
  quietMask: (p: WarpPoint) => boolean;
}

export const LOW_CONFIDENCE = 0.3;
/** DTW 記憶體上限（格）：超過就把 hop 放大。 */
const MAX_CELLS = 150_000_000;

function makeDist(f: AlignFeatures, g: AlignFeatures, onsetWeight: number) {
  return (i: number, j: number) => frameDistance(f, i, g, j, onsetWeight);
}

/** 只做分析、不動檔案。 */
export async function analyzeAlignment(guideId: string, dubId: string, opts: AlignOptions): Promise<AlignAnalysis> {
  if (guideId === dubId) throw new Error(t("Guide 與 Dub 要是不同的檔"));
  const preset = MODE_PRESETS[opts.mode];
  const tightness = opts.tightness ?? preset.tightness;
  const guide = await ensureLocalAnalysis(guideId);
  const dub = await ensureLocalAnalysis(dubId);
  const gRange = opts.guideRange ?? null;
  const dRange = opts.dubRange ?? null;

  // 1) 全域位移（既有的 sync.ts）當粗帶中心
  const off = estimateOffset(guide, dub);
  // sync.ts 的 offsetMs 是「b 要往後移」= guide − dub
  const offsetMs0 = off.offsetMs;

  // 2) 粗對齊 100 ms
  const gc = speechFeatures(guide, { hopMs: preset.coarseHopMs, range: gRange });
  const dc = speechFeatures(dub, { hopMs: preset.coarseHopMs, range: dRange });
  const durMin = Math.max(guide.durationMs, dub.durationMs) / 60_000;
  // 兩檔長度差（扣掉位移）：可能是伸縮（時鐘漂移、講太慢）也可能只是尾巴多了靜音 ——
  // 帶寬把它整個含進去、中心用線性假設（伸縮），兩種情況都在帶內
  const wholeFile = !gRange && !dRange;
  const extraMs = wholeFile ? dub.durationMs + offsetMs0 - guide.durationMs : 0;
  const coarseBand = preset.coarseBandMs + Math.abs(extraMs) + (opts.mode === "drift" ? (2000 * durMin) / 60 : 0);
  const cHop = gc.hopMs;
  const guideLen = Math.max(1, gRange ? gRange.endMs - gRange.startMs : guide.durationMs);
  const coarse = bandedDtw(gc.rms.length, dc.rms.length, {
    center: (i) => {
      const gMs = gc.startMs + i * cHop;
      const stretch = wholeFile ? (gMs / guideLen) * extraMs : 0;
      return (gMs - offsetMs0 + stretch - dc.startMs) / cHop;
    },
    halfWidth: Math.max(2, Math.ceil(coarseBand / cHop)),
    dist: makeDist(gc, dc, preset.onsetWeight),
    openBegin: preset.openEnds,
    openEnd: preset.openEnds,
  });
  if (!coarse.path.length) throw new Error(t("粗對齊失敗：兩邊在允許的範圍內找不到對應"));
  const coarsePoints = pathToWarp(coarse.path, cHop, cHop, gc.startMs, dc.startMs);
  // coarsePoints：dubMs → guideMs；細對齊的帶中心要「guide i → dub j」，反過來查
  const guideToDub = coarsePoints.map((p) => ({ dubMs: p.guideMs, guideMs: p.dubMs }));

  // 3) 細對齊：hop 依記憶體上限放大
  let hop = preset.hopMs;
  let fineBand = preset.fineBandMs;
  for (;;) {
    const n = Math.ceil(((gRange ? gRange.endMs - gRange.startMs : guide.durationMs) / hop) as number);
    const width = 2 * Math.ceil(fineBand / hop) + 1;
    if (n * width <= MAX_CELLS || hop >= 40) break;
    hop *= 2;
  }
  const gf = speechFeatures(guide, { hopMs: hop, range: gRange });
  const df = speechFeatures(dub, { hopMs: hop, range: dRange });
  const fHop = gf.hopMs;
  const prot = opts.protectedAreas ?? [];
  const centerOf = (i: number) => (warpAt(guideToDub, gf.startMs + i * fHop) - df.startMs) / fHop;
  const fineDist = makeDist(gf, df, preset.onsetWeight);
  const fine = bandedDtw(gf.rms.length, df.rms.length, {
    center: centerOf,
    halfWidth: Math.max(2, Math.ceil(fineBand / fHop)),
    dist: fineDist,
    openBegin: preset.openEnds,
    openEnd: preset.openEnds,
    forceDiagonal: prot.length
      ? (i) => {
          const dubMs = df.startMs + centerOf(i) * fHop;
          return prot.some((a) => dubMs >= a.startMs && dubMs < a.endMs);
        }
      : undefined,
  });
  if (!fine.path.length) throw new Error(t("細對齊失敗：兩邊在允許的範圍內找不到對應"));
  const confidence = pathConfidence(fine.path, df.rms.length, Math.round(1500 / fHop), fineDist);
  const rawPoints = pathToWarp(fine.path, fHop, fHop, gf.startMs, df.startMs);
  const quietMask = (p: WarpPoint) => {
    const i = Math.round((p.guideMs - gf.startMs) / fHop);
    const j = Math.round((p.dubMs - df.startMs) / fHop);
    return i >= 0 && j >= 0 && i < gf.rms.length && j < df.rms.length && bothQuiet(gf, i, df, j);
  };
  const shaped = shapeWarp(rawPoints, quietMask, tightness);
  const summary = summarizeWarp(shaped.points);

  // 顯示用車道（20 ms）
  const gl = speechFeatures(guide, { hopMs: 20, range: gRange });
  const dl = speechFeatures(dub, { hopMs: 20, range: dRange });

  return {
    guideId,
    dubId,
    mode: opts.mode,
    tightness,
    points: shaped.points,
    segments: shaped.segments,
    summary,
    confidence,
    resampleRatio: resampleOnly(summary),
    offsetMs: summary.offsetMs,
    lanes: { guide: gl.rms, dub: dl.rms, hopMs: gl.hopMs, guideStartMs: gl.startMs, dubStartMs: dl.startMs },
    rawPoints,
    quietMask,
  };
}

/** 路徑 → 拉直靜音 → tightness → 簡化 → 分段。tightness 一改只要重跑這裡。 */
export function shapeWarp(rawPoints: WarpPoint[], quietMask: (p: WarpPoint) => boolean, tightness: number): { points: WarpPoint[]; segments: WarpSegment[] } {
  const straight = straightenSilence(rawPoints, quietMask, 150);
  const tight = applyTightness(straight, tightness);
  const tol = 5 + (100 - tightness) * 0.45;
  const points = simplifyWarp(tight, tol);
  return { points, segments: warpSegments(points) };
}

export function retighten(a: AlignAnalysis, tightness: number): AlignAnalysis {
  const shaped = shapeWarp(a.rawPoints, a.quietMask, tightness);
  const summary = summarizeWarp(shaped.points);
  return { ...a, tightness, points: shaped.points, segments: shaped.segments, summary, resampleRatio: resampleOnly(summary), offsetMs: summary.offsetMs };
}

/** 對齊檔的路徑：dub 旁邊的 `<dub>_aligned.wav`。 */
export function alignedPathFor(dubPath: string): string {
  return dubPath.replace(/\.[^.]+$/, "") + "_aligned.wav";
}

export interface AlignRenderResult {
  outPath: string;
  mediaId: string;
  verdict: AlignVerdict | null;
}

/** 渲染對齊檔（dub 扭到 guide 時間軸）、加進媒體清單、跑殘差驗收。 */
export async function renderAlignment(a: AlignAnalysis, opts: { verify?: boolean } = {}): Promise<AlignRenderResult> {
  const proj = useProject.getState();
  const dub = proj.media.find((m) => m.id === a.dubId);
  const guideM = proj.media.find((m) => m.id === a.guideId);
  if (!dub || !guideM) throw new Error(t("找不到媒體"));
  const outPath = alignedPathFor(dub.path);
  const jobs = useJobs.getState();
  const jobId = newJobId();
  jobs.upsert({ id: jobId, kind: "align", mediaId: a.dubId, step: t("對齊輸出"), pct: null, status: "running", message: outPath });
  try {
    // 分段速率 → atempo tempo（= 1 / rate）；純重取樣也用一段 atempo（WSOLA 在 0.2% 內是透明的）
    const segments = a.resampleRatio
      ? [{ dub_start_ms: 0, tempo: 1 / a.resampleRatio }]
      : a.segments.map((s) => ({ dub_start_ms: s.dubStartMs, tempo: Math.max(0.5, Math.min(2, 1 / s.rate)) }));
    // 位移：dub 時間 0 對到 guide 的哪裡（外推）
    const offsetMs = Math.round(warpAt(a.points, 0));
    await api.alignRender({ src: dub.path, out_path: outPath, offset_ms: offsetMs, segments, channels: Math.max(1, Math.min(2, dub.probe?.audio?.channels ?? 1)) });
    jobs.upsert({ id: jobId, status: "done", step: t("完成"), pct: 100, endedAt: Date.now() });
  } catch (e) {
    jobs.upsert({ id: jobId, status: "error", step: t("失敗"), error: String(e), endedAt: Date.now() });
    throw e;
  }
  const mediaId = await useProject.getState().openMedia(outPath);
  let verdict: AlignVerdict | null = null;
  if (opts.verify !== false) {
    try {
      const guide = await ensureLocalAnalysis(a.guideId);
      const aligned = await ensureLocalAnalysis(mediaId);
      verdict = alignVerdict(residualByWindow(guide, aligned));
    } catch {
      verdict = null;
    }
  }
  return { outPath, mediaId, verdict };
}

/** 多麥同步用：以 base 為 guide 校正另一軌的時鐘漂移，回對齊檔路徑（不驗收、不切 active）。 */
export async function alignForSync(baseId: string, otherId: string): Promise<{ path: string; mediaId: string; confidence: number; summary: WarpSummary }> {
  const prevActive = useProject.getState().activeMediaId;
  const a = await analyzeAlignment(baseId, otherId, { mode: "drift" });
  const r = await renderAlignment(a, { verify: false });
  if (prevActive) useProject.getState().setActive(prevActive);
  return { path: r.outPath, mediaId: r.mediaId, confidence: a.confidence, summary: a.summary };
}

/** 漂移值不值得校正：> 20 分鐘且兩軌長度差（扣掉位移）> 300 ms。 */
export function suggestDrift(durAMs: number, durBMs: number, offsetMs: number): boolean {
  return Math.max(durAMs, durBMs) > 20 * 60_000 && Math.abs(durBMs - durAMs - offsetMs) > 300;
}
