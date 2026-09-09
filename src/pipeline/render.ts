// 輸出流程：EDL → 響度單元 / 增益 → RenderPlan → Rust（串流剪接 + loudnorm 兩趟）；進度 / 完成事件回報。
import { listen } from "@tauri-apps/api/event";
import { toast } from "../ui";
import { api, type LoudnormStats, type RenderDone, type RenderJoin, type RenderOverlay, type RenderPlan, type RenderProgress, type RenderSeg } from "../api";
import type { Edl } from "../analysis/edl/build";
import { DEFAULT_EDL_OPTIONS } from "../analysis/edl/build";
import { buildChapters, toFfmetadata, type Chapter } from "../analysis/chapters";
import { clipOverlays, clipUnits } from "../analysis/clip";
import {
  clipUnitsMulti,
  normalizeRanges,
  REEL_BED_FADE_IN_MS,
  REEL_BED_FADE_OUT_MS,
  REEL_BED_GAIN_DB,
  REEL_CROSSFADE_MS,
  REEL_FADE_IN_MS,
  REEL_FADE_OUT_MS,
  type ReelRange,
} from "../analysis/reel";
import { outputDurationWithOverlays, resolveOverlays } from "../analysis/overlays";
import { overlayRole } from "../analysis/roles";
import { mapSrcToOut } from "../analysis/edl/map";
import { effectiveXfMs, planOutDurationMs } from "../analysis/edl/joins";
import { DEFAULT_GAIN_OPTIONS, measureUnits, planGains } from "../analysis/loudness/plan";
import { splitUnits } from "../analysis/loudness/units";
import { unitSpeakerMap } from "../analysis/speakerLevel";
import { t } from "../i18n";
import { isCleanupActive, type CleanupSpec } from "../analysis/cleanup";
import { isGainEffect, type AudioEffect, type GainEffectKind } from "../analysis/effects";
import { fxRegionsToOut, type FxRegion } from "../analysis/fx/regions";
import { useCleanup } from "../store/cleanup";
import { useDecisions } from "../store/decisions";
import { newJobId, useJobs } from "../store/jobs";
import { useProject, type MediaItem } from "../store/project";
import { useVerify } from "../store/verify";
import { useTranscript } from "../store/transcript";
import { edlFor } from "./rules";

import { type BitDepth, type RenderFormat } from "../analysis/formats";
export type { RenderFormat };

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
  /**
   * 只輸出這個角色的 overlays（主聲軌靜音）。給依角色分軌用；
   * 不指定時 `stem: "music"` 代表「全部 overlays」。
   */
  stemRole?: string | null;
  /** 沿用主混音那一趟的響度量測（分軌一定要帶，各軌才加得回原本的混音）。 */
  loudnormMeasured?: LoudnormStats | null;
  /** 修聲；不給就用這個媒體目前存的設定。傳 null 表示這一趟不修聲（A/B 比較用）。 */
  cleanup?: CleanupSpec | null;
  /**
   * 精華合輯：把好幾段**不相鄰**的範圍串成一支預告。與 `rangeMs` 互斥（同時給以這個為準）。
   * 專案不動、章節不寫、配樂不帶（散落的範圍上「配樂該在哪」沒有定義）。
   */
  reelRanges?: ReelRange[] | null;
  /** 合輯的墊樂（媒體 id）。整支預告底下鋪同一首，頭尾淡進淡出。 */
  reelBedMediaId?: string | null;
  /**
   * 只輸出這一段（**來源**時間）。剪輯、配樂、閃避全部照舊，只是頭尾被夾掉；
   * 專案本身不動。社群短片用。
   */
  rangeMs?: { startMs: number; endMs: number } | null;
  /**
   * 保留動態：寧可小聲也不要被壓。
   * 目標拉不到時 ffmpeg 會自己退回動態壓縮（見 v0.74 的驗收），開這個就改成
   * 把目標降到線性拿得到的位置。
   */
  preserveDynamics?: boolean;
  /** 尚未套用、只為了試聽的效果（EffectDialog 的 A/B 用）。 */
  extraEffects?: AudioEffect[];
  /** 無損格式的位元深度（省略 = 16）。 */
  bitDepth?: BitDepth;
}

function sep(p: string): string {
  return p.includes("\\") ? "\\" : "/";
}

export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i >= 0 ? p.slice(0, i) : "";
}

/**
 * 成品要寫到哪裡。
 *
 * `taken` / `sources` 只有**批次**會傳：一次跑好幾集、又指定同一個輸出資料夾時，
 * podcast 的檔案結構常常是 `ep01/recording.wav`、`ep02/recording.wav` ——
 * 只用檔名的話兩集都算出 `recording_cut.mp3`，第二集**安靜地蓋掉第一集**。
 * 使用者跑完看到一個檔案，以為是自己選錯了。
 *
 * `sources` 再擋一層：對著上一輪的成品資料夾再跑一次批次時，
 * 輸出不能蓋掉這一批自己的來源檔（跑到一半輸入就沒了）。
 *
 * 單檔輸出不傳，行為與以前逐字元相同。
 */
export function defaultOutPath(
  media: MediaItem,
  format: RenderFormat,
  outputDir: string | null,
  taken?: Set<string>,
  sources?: ReadonlySet<string>,
): string {
  const dir = outputDir?.trim() || dirname(media.path);
  const base = media.name.replace(/\.[^.]+$/, "");
  const s = sep(dir || media.path);
  const lc = (x: string) => x.toLowerCase();
  let candidate = `${dir}${s}${base}_cut.${format}`;
  if (!taken && !sources) return candidate;
  let n = 2;
  while (taken?.has(lc(candidate)) || sources?.has(lc(candidate))) {
    candidate = `${dir}${s}${base}_cut_${n}.${format}`;
    n++;
  }
  taken?.add(lc(candidate));
  return candidate;
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
  /** 範圍濾波的區域（成品時間）：驗收要知道哪裡的波形被動過。 */
  fxRegions: FxRegion[];
  /** 引擎還不支援、這一趟不會處理的範圍效果 —— 要列出來，不能默默少掉。 */
  unsupportedFx: AudioEffect[];
  /** 太短（不到兩端交叉 20 ms）而整個沒套到的範圍效果 —— 使用者要知道為什麼聽不出差別。 */
  droppedFx: AudioEffect[];
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
  // 精華合輯：每個單元帶著自己屬於第幾個範圍，接點才判得出「這裡是範圍交界」
  const reel = opts.reelRanges?.length ? normalizeRanges(opts.reelRanges) : null;
  const units = reel ? clipUnitsMulti(allUnits, reel) : opts.rangeMs ? clipUnits(allUnits, opts.rangeMs) : allUnits;
  if (!units.length) return null;
  const measured = local ? measureUnits(units, local) : units.map((u) => ({ ...u, lufs: null, peakDb: 0 }));
  // 有講者標籤時，逐段平衡就知道哪裡是「換人」而不是「同一個人變大聲」——
  // 換人要一次補到位，慢慢爬會讓每次換人後的頭幾秒都還在錯的音量上（見 loudness/plan.ts）
  const turns = useDecisions.getState().speakers[mediaId]?.turns ?? [];
  const unitSpeaker = turns.length ? unitSpeakerMap(units, turns) : null;
  const speakerOf = unitSpeaker ? (id: number) => unitSpeaker.get(id) ?? null : undefined;
  const gains =
    opts.leveling && local
      ? planGains(measured, { ...DEFAULT_GAIN_OPTIONS, targetLufs: opts.targetLufs }, speakerOf)
      : units.map((u) => ({ unitId: u.id, gainDb: 0 }));
  const segs: RenderSeg[] = units.map((u, i) => ({ src_start_ms: u.startMs, src_end_ms: u.endMs, gain_db: gains[i]?.gainDb ?? 0 }));
  const joins: RenderJoin[] = [];
  for (let i = 0; i + 1 < units.length; i++) {
    // 精華合輯的範圍交界：兩邊在原本的錄音裡毫無關係，一定要交越。
    // **這一條要排在 keepId 判斷前面** —— 同一段話挑了兩句時 keepId 會相同，
    // 落到下面就會被當成「同段內的單元邊界」直接對接，聽起來是中間被挖掉一塊。
    const ri = (units[i] as { rangeIdx?: number }).rangeIdx;
    const rj = (units[i + 1] as { rangeIdx?: number }).rangeIdx;
    if (ri !== undefined && rj !== undefined && ri !== rj) {
      joins.push({ kind: "crossfade", ms: effectiveXfMs(REEL_CROSSFADE_MS, units[i].endMs - units[i].startMs, units[i + 1].endMs - units[i + 1].startMs) });
      continue;
    }
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
  // extraEffects：還沒套用、只是要試聽的效果（EffectDialog 的 A/B）—— 跟已存的合在一起渲染
  // 只有增益包絡類進 Cutter；範圍濾波（降噪…）走 R4 的 fx_regions，不在這裡
  const effects = [...(useDecisions.getState().effects[mediaId] ?? []), ...(opts.extraEffects ?? [])]
    .filter(isGainEffect)
    .map((e) => ({ kind: e.kind as GainEffectKind, start_ms: e.startMs, end_ms: e.endMs, db: e.db ?? 0, ...(e.shape ? { shape: e.shape } : {}) }));
  // 範圍濾波（降噪 / 去爆音…）：換算到成品時間的區域，Rust 在剪好之後 punch-in。
  // 建在 segs / joins 上（不是 edl.keeps）：只輸出一段 / 合輯的 units 已經裁過，逐 seg 走天然正確。
  const fx = fxRegionsToOut(
    [...(useDecisions.getState().effects[mediaId] ?? []), ...(opts.extraEffects ?? [])],
    segs.map((sg) => ({ startMs: sg.src_start_ms, endMs: sg.src_end_ms })),
    joins,
  );
  if (reel && units.length) {
    // 預告一定是從句子中間開始、句子中間結束，不淡就是硬切進一個字的中段。
    // **只加進這一趟的 plan，不寫進 store** —— 這是輸出這支預告的處理，
    // 不是對專案的編輯；寫進去的話完整成品也會莫名其妙在那兩個位置淡掉。
    const first = units[0];
    const last = units[units.length - 1];
    effects.push({ kind: "fade_in", start_ms: first.startMs, end_ms: Math.min(first.endMs, first.startMs + REEL_FADE_IN_MS), db: 0 });
    effects.push({ kind: "fade_out", start_ms: Math.max(last.startMs, last.endMs - REEL_FADE_OUT_MS), end_ms: last.endMs, db: 0 });
  }
  // 章節：標記是釘在來源上的，要換算成成品時間才寫進檔案
  const mainOutMs = planOutDurationMs(
    segs.map((sg) => ({ startMs: sg.src_start_ms, endMs: sg.src_end_ms })),
    joins,
  );
  // 章節只寫進完整成品：一段 60 秒的預告不需要章節，而且時間軸原點不一樣
  const chapters = opts.rangeMs || reel ? [] : buildChapters(useDecisions.getState().markers[mediaId] ?? [], edl, { outDurationMs: mainOutMs });
  // 墊樂 / 音效。**先夾再轉成 RenderOverlay** —— 夾的邏輯用的是 store 的欄位名，
  // 而且只輸出一段時要連來源進出點一起移（不然音樂會從頭重播）。
  // 配樂的位置是成品時間，所以要先知道選取起點落在成品的哪裡。
  // 錨在來源時間的 overlay（重錄這句 / 放進選取）先依現在的 EDL 換算成成品位置
  const storeOverlays = resolveOverlays(useDecisions.getState().overlays[mediaId] ?? [], edl.keeps);
  const outOffsetMs = opts.rangeMs ? mapSrcToOut(edl.keeps, opts.rangeMs.startMs) : 0;
  // 合輯不帶配樂：範圍是散落的，「這段音樂該落在合輯的哪裡」沒有定義。
  // 硬帶會得到一堆被切碎、對不上任何東西的片段 —— 不如明確地不帶。
  const kept = reel ? [] : opts.rangeMs ? clipOverlays(storeOverlays, outOffsetMs, mainOutMs) : storeOverlays;
  const clipped: RenderOverlay[] = [];
  for (const o of kept) {
    // 指定角色時只留那個角色 —— 拿到成品的人要換掉的通常正是廣告那一段，
    // 跟片尾曲混在同一個檔案裡就換不掉了
    if (opts.stemRole && overlayRole(o) !== opts.stemRole) continue;
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

  // 合輯的墊樂：整支預告底下鋪同一首。
  // 不走 store 的 overlays（那是釘在完整成品時間軸上的，合輯的時間軸完全不一樣），
  // 而是照這一趟算出來的長度現生一條。人聲是 wall-to-wall 的，所以不做閃避控制點 ——
  // 直接壓到 −22 dB 當底，反而比一路上上下下乾淨。
  if (reel && opts.reelBedMediaId) {
    const bed = proj.media.find((m) => m.id === opts.reelBedMediaId);
    const bedLen = bed?.probe?.duration_ms ?? 0;
    if (bed && bedLen > 0 && mainOutMs > 0) {
      clipped.push({
        path: bed.path,
        src_start_ms: 0,
        // 墊樂比預告短就播到哪算哪（Rust 端不會循環）；長就切掉尾巴
        src_end_ms: Math.min(bedLen, mainOutMs),
        out_start_ms: 0,
        gain_db: REEL_BED_GAIN_DB,
        fade_in_ms: Math.min(REEL_BED_FADE_IN_MS, mainOutMs / 3),
        fade_out_ms: Math.min(REEL_BED_FADE_OUT_MS, mainOutMs / 3),
        points: [],
        lane: "music",
      });
    }
  }

  // 修聲：opts 明講就用它（傳 null = 這一趟不修，A/B 比較用），沒講就用這個媒體存的設定
  const cleanupSpec: CleanupSpec | null = opts.cleanup !== undefined ? opts.cleanup : useCleanup.getState().get(mediaId);
  const cleanupPlan = isCleanupActive(cleanupSpec)
    ? {
        rumble_hz: cleanupSpec!.rumbleHz,
        denoise_db: cleanupSpec!.denoiseDb,
        noise_floor_db: cleanupSpec!.noiseFloorDb,
        deess_amount: cleanupSpec!.deessAmount,
      }
    : null;

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
      ...(opts.bitDepth && opts.bitDepth !== 16 ? { bit_depth: opts.bitDepth } : {}),
      out_path: opts.outPath,
      channels,
      ...(chapters.length ? { chapters_meta: toFfmetadata(chapters) } : {}),
      // 人聲 stem 不帶 overlays；配樂 / 角色 stem 把主聲軌靜音
      ...(clipped.length && opts.stem !== "voice" ? { overlays: clipped } : {}),
      ...(opts.stem === "music" ? { mute_main: true } : {}),
      ...(opts.loudnormMeasured ? { loudnorm_measured: opts.loudnormMeasured } : {}),
      ...(cleanupPlan ? { cleanup: cleanupPlan } : {}),
      ...(opts.preserveDynamics ? { preserve_dynamics: true } : {}),
      ...(fx.regions.length ? { fx_regions: fx.regions.map(({ out_start_ms, out_end_ms, chain }) => ({ out_start_ms, out_end_ms, chain })) } : {}),
    },
    edl,
    units: units.length,
    gains,
    // 片尾曲可能比最後一句話還晚結束 —— 驗收要對的是成品實際長度
    expectedOutMs: outputDurationWithOverlays(mainOutMs, kept),
    chapters,
    fxRegions: fx.regions,
    unsupportedFx: fx.unsupported,
    droppedFx: fx.dropped,
  };
}

/** 啟動輸出並等待完成（工作列可取消）。 */
export async function runRender(mediaId: string, opts: RenderOptions, onProgress?: (p: RenderProgress) => void): Promise<RenderDone> {
  const proj = useProject.getState();
  const media = proj.media.find((m) => m.id === mediaId);
  if (!media) throw new Error(t("找不到媒體"));
  const built = buildRenderPlan(mediaId, opts);
  if (!built) throw new Error(t("無法建立輸出計畫（媒體尚未探測）"));
  // 重排過的 EDL（剪下貼上 / 搬移）自 v0.111 起可以輸出：Rust 端偵測到段落離開
  // 「來源時間遞增且不重疊」時，改走先解碼成暫存 raw、再照成品順序回頭讀的路徑
  // （render.rs 的 needs_random_access / cut_to_wav_arranged）。順序正常的專案
  // 仍然走原本的單趟串流，逐位元相同（有隨機 plan 對拍測試釘住）。
  const jobs = useJobs.getState();
  const jobId = newJobId();
  jobs.upsert({ id: jobId, kind: "render", mediaId, step: t("剪接"), pct: 0, status: "running", message: opts.outPath, cancel: () => void api.renderCancel(jobId) });
  const STAGE: Record<RenderProgress["stage"], string> = { cut: t("剪接"), fx: t("範圍濾波"), measure: t("量測響度"), encode: t("響度正規化 + 編碼") };
  const WEIGHT: Record<RenderProgress["stage"], [number, number]> = { cut: [0, 40], fx: [40, 50], measure: [50, 58], encode: [58, 100] };
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
    // 沒帶進成品的東西要講（flac / wav 寫不進章節）—— 不能默默少掉
    if (r.dropped?.length) toast.info(t("這個格式寫不進：{items}（成品裡沒有）", { items: r.dropped.join("、") }));
    // 太短的範圍效果沒套（放不下兩端 10 ms 的交叉）—— 不講的話使用者只會覺得「效果沒作用」
    if (built.droppedFx.length) toast.info(t("有 {n} 段效果太短（不到 20 ms）沒有套用", { n: built.droppedFx.length }));
    // 預覽檔不算「最近一次輸出」：驗收要對的是成品
    if (r.out_path && !opts.preview && (opts.stem ?? "full") === "full")
      useVerify.getState().setLastOutput(mediaId, {
        path: r.out_path,
        expectedOutMs: built.expectedOutMs,
        outputLufs: r.output_lufs,
        outputTp: r.output_tp,
        targetLufs: opts.targetLufs,
        fxSpans: built.fxRegions.map((x) => ({ startMs: x.out_start_ms, endMs: x.out_end_ms, correlated: x.correlated })),
      });
    jobs.upsert({ id: jobId, status: "done", step: t("完成"), pct: 100, message: `${r.out_path ?? ""} · ${r.output_lufs?.toFixed(1) ?? "?"} LUFS`, endedAt: Date.now() });
  } else if (r.error === "已取消") {
    jobs.upsert({ id: jobId, status: "canceled", step: t("已取消"), endedAt: Date.now() });
  } else {
    jobs.upsert({ id: jobId, status: "error", step: t("失敗"), error: r.error ?? t("未知錯誤"), endedAt: Date.now() });
  }
  return r;
}
