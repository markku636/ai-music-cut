// 產出發布包：一次把音檔、字幕、逐字稿、節目筆記、章節、清單寫進同一個資料夾。
//
// 這裡只做編排 —— 每一項的內容都由既有的模組產生（render / captions / shownotes /
// chapters），這一層不重新實作任何東西。**順序有意義**：音檔先跑（最久、最會失敗），
// 其他都是純文字，音檔沒成功就沒必要產一包只有文字的東西。
import { buildCues, renderCaptions, type CaptionFormat } from "../analysis/captions";
import { buildChapters } from "../analysis/chapters";
import { planBundle, bundleStem, reconcileBundleItems, renderChapterList, renderManifest, type BundleItem } from "../analysis/bundle";
import { hasBlocker, preflight } from "../analysis/preflight";
import { qcFor } from "./audioQc";
import { checkCompliance, explainMiss } from "../analysis/loudness/compliance";
import { assignWords, speakerStats } from "../analysis/speakers";
import { toMarkdown as notesToMarkdown } from "../analysis/shownotes";
import { api } from "../api";
import { t } from "../i18n";
import { useDecisions } from "../store/decisions";
import { useProject } from "../store/project";
import { useShowNotes } from "../store/showNotes";
import { useTranscript } from "../store/transcript";
import { edlFor } from "./rules";
import { buildRenderPlan, runRender, type RenderFormat } from "./render";
import type { RenderProgress } from "../api";

export interface BundleOptions {
  dir: string;
  stem?: string;
  audioFormat: RenderFormat;
  captionFormat: CaptionFormat;
  targetLufs: number;
}

export interface BundleResult {
  dir: string;
  stem: string;
  written: BundleItem[];
  skipped: BundleItem[];
  failed: { fileName: string; error: string }[];
  outMs: number;
  measuredLufs: number | null;
  blocked: boolean;
}

export type BundleStep = (label: string, done: number, total: number) => void;

function join(dir: string, name: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${sep}${name}`;
}

/**
 * 產一包。
 *
 * **交付前檢查有 blocker 時仍然照產**，只是把它寫進清單並回報 —— 擋下來反而讓人
 * 沒辦法先產一份給自己聽。決定要不要上架的是人，這裡的責任是「不要安靜地少東西」。
 */
export async function buildBundle(mediaId: string, opts: BundleOptions, onStep?: BundleStep, onProgress?: (p: RenderProgress) => void): Promise<BundleResult> {
  const proj = useProject.getState();
  const media = proj.media.find((m) => m.id === mediaId);
  if (!media) throw new Error(t("找不到媒體"));
  const d = useDecisions.getState();
  const tr = useTranscript.getState().byMedia[mediaId];
  const notes = useShowNotes.getState().byMedia[mediaId] ?? null;
  const markers = d.markers[mediaId] ?? [];
  const edl = edlFor(mediaId);
  const speakers = d.speakers[mediaId];

  const chapterMarks = markers.filter((m) => m.kind === "chapter");
  const stem = bundleStem({
    mediaName: media.name ?? "",
    audioFormat: opts.audioFormat,
    captionFormat: opts.captionFormat,
    hasTranscript: !!tr,
    hasShowNotes: !!notes,
    chapterCount: chapterMarks.length,
    stem: opts.stem,
  });
  const items = planBundle({
    mediaName: media.name ?? "",
    audioFormat: opts.audioFormat,
    captionFormat: opts.captionFormat,
    hasTranscript: !!tr,
    hasShowNotes: !!notes,
    chapterCount: chapterMarks.length,
    stem: opts.stem,
  });

  const written: BundleItem[] = [];
  const failed: { fileName: string; error: string }[] = [];
  const todo = items.filter((i) => !i.skipped);
  let done = 0;
  const step = (label: string) => onStep?.(label, done, todo.length);

  // --- 音檔（最久、最會失敗，先跑）---
  const audio = items.find((i) => i.kind === "audio")!;
  step(audio.fileName);
  const audioPath = join(opts.dir, audio.fileName);
  const built = buildRenderPlan(mediaId, { format: opts.audioFormat, outPath: audioPath, leveling: true, targetLufs: opts.targetLufs });
  let measuredLufs: number | null = null;
  let measuredTp: number | null = null;
  // ffmpeg 可能自己從 linear 退回 dynamic（動態壓縮）；它只在 JSON 裡講一次
  let normType: string | null = null;
  try {
    const r = await runRender(mediaId, { format: opts.audioFormat, outPath: audioPath, leveling: true, targetLufs: opts.targetLufs }, onProgress);
    measuredLufs = typeof r.output_lufs === "number" && Number.isFinite(r.output_lufs) ? r.output_lufs : null;
    measuredTp = typeof r.output_tp === "number" && Number.isFinite(r.output_tp) ? r.output_tp : null;
    normType = r.measured?.normalization_type ?? null;
    written.push(audio);
  } catch (e) {
    failed.push({ fileName: audio.fileName, error: e instanceof Error ? e.message : String(e) });
  }
  done++;

  const outMs = built?.expectedOutMs ?? 0;
  const chapters = buildChapters(markers, edl, { outDurationMs: outMs });

  const writeText = async (item: BundleItem, text: string) => {
    step(item.fileName);
    try {
      await api.writeTextFile(join(opts.dir, item.fileName), text);
      written.push(item);
    } catch (e) {
      failed.push({ fileName: item.fileName, error: e instanceof Error ? e.message : String(e) });
    }
    done++;
  };

  // --- 字幕與逐字稿 ---
  if (tr && edl) {
    const speakerOf = speakers?.turns.length ? assignWords(tr.words, speakers.turns) : undefined;
    const cues = buildCues({ words: tr.words, sentences: tr.sentences, keeps: edl.keeps, speakerOf });
    const labelOf = (id: string) => speakers?.list.find((s) => s.id === id)?.label ?? id;
    const cap = items.find((i) => i.kind === "captions")!;
    if (!cap.skipped) await writeText(cap, renderCaptions(cues, opts.captionFormat, { labelOf }));
    const trx = items.find((i) => i.kind === "transcript")!;
    // 逐字稿一律帶講者名字：那是給人讀的，不是給播放器讀的
    if (!trx.skipped) await writeText(trx, renderCaptions(cues, "md", { labelOf }));
  }

  // --- 節目筆記 ---
  const nt = items.find((i) => i.kind === "notes")!;
  if (!nt.skipped && notes) await writeText(nt, notesToMarkdown(notes, { title: media.name }));

  // --- 章節清單 ---
  const ch = items.find((i) => i.kind === "chapters")!;
  if (!ch.skipped) await writeText(ch, renderChapterList(chapters.map((c) => ({ outMs: c.startMs, title: c.title }))));

  // --- 清單（最後，才知道前面成功了什麼）---
  const decisions = d.decisions[mediaId] ?? {};
  const candidates = d.candidates[mediaId] ?? [];
  const overlays = d.overlays[mediaId] ?? [];
  const bundleQc = qcFor(mediaId);
  const findings = preflight({
    pending: candidates.reduce((n, c) => n + ((decisions[c.id]?.state ?? "pending") === "pending" ? 1 : 0), 0),
    conflicts: candidates.reduce((n, c) => n + (decisions[c.id]?.conflict ? 1 : 0), 0),
    openTodos: markers.reduce((n, m) => n + (m.kind === "todo" && !m.done ? 1 : 0), 0),
    chapters: chapterMarks.length,
    srcMs: built?.edl.stats.srcMs ?? (media.probe?.duration_ms ?? 0),
    outMs,
    overlays: overlays.length,
    musicWithoutDuck: overlays.filter((o) => o.lane === "music" && !(o.points?.length ?? 0)).length,
    stems: false,
    hasTranscript: !!tr,
    qc: bundleQc?.summary,
    qcAt: bundleQc?.at,
  });
  // 對帳：每一項都必須落在「寫出來了」或「產生失敗」其中一邊。
  // 掉在中間的話清單會把它列成正常項目，但那個檔案根本不存在 ——
  // 而清單正是使用者拿去對「這包裡有什麼」的東西。
  failed.push(...reconcileBundleItems(items, written, failed, t("沒有產生（缺少必要資料）")));

  // 產不出來的也算「沒帶到」，清單要看得出來
  const finalItems = items.map((i) => {
    const f = failed.find((x) => x.fileName === i.fileName);
    return f ? { ...i, skipped: t("產生失敗：{e}", { e: f.error }) } : i;
  });
  const manifest = items.find((i) => i.kind === "manifest")!;
  await writeText(
    manifest,
    renderManifest({
      stem,
      mediaName: media.name ?? "",
      items: finalItems.filter((i) => i.kind !== "manifest").concat(manifest),
      outMs,
      srcMs: built?.edl.stats.srcMs ?? (media.probe?.duration_ms ?? 0),
      targetLufs: opts.targetLufs,
      measuredLufs,
      compliance: measuredLufs == null ? null : checkCompliance({ outputLufs: measuredLufs, outputTp: measuredTp, targetLufs: opts.targetLufs, normalizationType: normType }),
      miss: measuredLufs == null ? null : explainMiss({ outputLufs: measuredLufs, outputTp: measuredTp, targetLufs: opts.targetLufs }),
      chapters: chapters.map((c) => ({ outMs: c.startMs, title: c.title })),
      speakers: speakers?.list.length
        ? speakerStats(speakers.turns, speakers.list).map((s) => ({
            label: speakers.list.find((x) => x.id === s.speakerId)?.label ?? s.speakerId,
            share: s.share,
          }))
        : [],
      findings,
      generatedAt: new Date(),
    }),
  );

  return {
    dir: opts.dir,
    stem,
    written,
    skipped: items.filter((i) => i.skipped),
    failed,
    outMs,
    measuredLufs,
    blocked: hasBlocker(findings),
  };
}
