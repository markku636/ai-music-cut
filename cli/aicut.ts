#!/usr/bin/env node
// aicut — AI Music Cut 的命令列版：不開視窗也能轉寫 / 找贅字 / AI 判讀 / 剪接輸出 / 去人聲。
// 與 App 共用 src/analysis/*（規則、EDL、LLM 判讀、效果包絡）；I/O 改走 ffmpeg 子程序、fetch、claude CLI。
//
//   aicut transcribe <音檔> [--json out.json]
//   aicut analyze    <音檔> [--project out.aicut.json] [--aggressiveness 50] [--judge]
//   aicut cut        <音檔> [-o out.mp3] [--aggressiveness 50] [--judge] [--lufs -16] [--format mp3|m4a|wav]
//                          [--project p.aicut.json]（沿用 App 存的決策 / 手動剪輯 / 效果）
//   aicut separate   <音檔> [--stems vocals_accom|all] [--format wav] [--out-dir DIR]
//
// 金鑰：--key、環境變數 AICUT_TTLS_API_KEY、或專案根目錄 .env.local（gitignored）；不會印出、不會寫進任何輸出。
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildEdl, DEFAULT_EDL_OPTIONS, type Edl } from "../src/analysis/edl/build";
import type { AudioEffect } from "../src/analysis/effects";
import { normalizeTranscript, type ServerTranscript } from "../src/analysis/normalize";
import { runRulesAt } from "../src/analysis/rules";
import { thresholdsFor } from "../src/analysis/thresholds";
import { SUGGEST_ONLY_KINDS, isActiveState, KIND_LABEL, type Candidate, type DecisionMap, type DecisionState, type SplitPoint, type Transcript } from "../src/analysis/types";
import { detectBeats, MIN_BEAT_CONFIDENCE } from "../src/analysis/beats";
import type { LocalAnalysis } from "../src/analysis/peaks";
import { actualWords, expectedWords, verifyEdit, type VerifyReport } from "../src/analysis/verify";
import { Ffmpeg } from "./lib/ffmpeg";
import { judgeAll } from "./lib/judge";
import { generateMusic, health, keyFromEnvFile, resolveKey, separate, styleTransfer, transcribe, type TtlsClient } from "./lib/ttls";

const VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";
declare const __APP_VERSION__: string | undefined;

// ---------------- 參數解析（極簡，不拉套件） ----------------

interface Args {
  cmd: string;
  positional: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const [cmd = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < rest.length && !rest[i + 1].startsWith("-")) flags[a.slice(2)] = rest[++i];
      else flags[a.slice(2)] = true;
    } else if (a === "-o" && i + 1 < rest.length) flags.out = rest[++i];
    else positional.push(a);
  }
  return { cmd, positional, flags };
}

function str(f: Record<string, string | true>, k: string, d: string): string {
  const v = f[k];
  return typeof v === "string" ? v : d;
}
function num(f: Record<string, string | true>, k: string, d: number): number {
  const v = f[k];
  const n = typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
}

const log = (s: string) => process.stderr.write(`${s}\n`);
/** 會被忽略的東西一定要出聲：安靜地少東西最難發現（檔案有產出、長度也對，只是音樂不見了）。 */
const warn = (s: string) => process.stderr.write(`\u26a0 ${s}\n`);
const fmtMs = (ms: number) => {
  const t = Math.max(0, Math.floor(ms));
  const m = Math.floor(t / 60000);
  const s = Math.floor((t % 60000) / 1000);
  return `${m}:${String(s).padStart(2, "0")}.${String(t % 1000).padStart(3, "0")}`;
};

function help(): void {
  process.stdout.write(`aicut v${VERSION} — AI Podcast 自動粗剪（命令列）

用法：
  aicut transcribe <音檔> [--json out.json] [--lang zh] [--model auto] [--hotwords "A,B"]
  aicut analyze    <音檔> [--project out.aicut.json] [--aggressiveness 50] [--judge] [--claude-model sonnet]
  aicut cut        <音檔> [-o out.mp3] [--format mp3|m4a|wav] [--lufs -16] [--aggressiveness 50] [--judge]
                          [--project p.aicut.json]   沿用 App 存的決策 / 手動剪輯 / 效果（不重跑規則）
  aicut separate   <音檔> [--stems vocals_accom|all] [--format wav|mp3|flac] [--out-dir DIR]
  aicut verify     <原始音檔> <剪好的成品> [--project p.aicut.json]   用 ASR 重新轉寫成品，逐字比對該留的字
  aicut beats      <音檔> [--bars]                                    偵測 BPM / 拍點（剪音樂用；--bars 列出小節時間）
  aicut music      "<風格描述>" [--duration 30] [--bpm 0] [--quality fast|fine|max] [--n 1] [--format mp3] [--out-dir DIR]
  aicut style      <音檔> "<目標曲風>" [--from 0] [--to 30] [--strength 0.7] [--n 1] [--format mp3]   把一段改成另一種曲風

共用選項：
  --server URL      ttls 伺服器（預設 https://ttls.markkulab.net）
  --key KEY         ttls API 金鑰（或環境變數 AICUT_TTLS_API_KEY / .env.local；不會印出）
  --ffmpeg PATH     ffmpeg 執行檔（預設 PATH 裡的 ffmpeg；ffprobe 取同資料夾）
  --no-cache        不用逐字稿快取（預設同一檔案的轉寫結果快取在暫存目錄）
  --verify          cut 完成後用 ASR 重新轉寫成品並比對（人工驗收用）

範例：
  aicut cut ep12.m4a --judge -o ep12_cut.mp3 --verify
  aicut verify ep12.m4a ep12_cut.mp3
  aicut music "lofi hip hop, warm, mellow" --duration 30 --bpm 90
  aicut style song.mp3 "acoustic guitar arrangement" --from 30 --to 60
  aicut separate song.mp3 --format wav
`);
}

// ---------------- 共用 ----------------

async function client(flags: Record<string, string | true>): Promise<TtlsClient> {
  const base = str(flags, "server", "https://ttls.markkulab.net").replace(/\/+$/, "");
  const key = resolveKey(typeof flags.key === "string" ? flags.key : undefined) ?? (await keyFromEnvFile(process.cwd())) ?? (await keyFromEnvFile(path.dirname(new URL(import.meta.url).pathname)));
  if (!key) throw new Error("缺少 ttls 金鑰：用 --key、環境變數 AICUT_TTLS_API_KEY 或 .env.local 提供");
  const h = await health({ base, key });
  if (!h.ok) throw new Error(`ttls 伺服器無法連線（${base}）：${h.detail ?? `HTTP ${h.status}`}`);
  return { base, key };
}

function ffmpegOf(flags: Record<string, string | true>): Ffmpeg {
  const ff = str(flags, "ffmpeg", "ffmpeg");
  const probe = ff === "ffmpeg" ? "ffprobe" : path.join(path.dirname(ff), path.basename(ff).replace(/ffmpeg/i, "ffprobe"));
  return new Ffmpeg(ff, probe);
}

function cacheDir(): string {
  return path.join(os.tmpdir(), "aicut-cli-cache");
}

async function getTranscript(file: string, ff: Ffmpeg, flags: Record<string, string | true>): Promise<{ transcript: Transcript; raw: ServerTranscript }> {
  const { stat } = await import("node:fs/promises");
  const st = await stat(file);
  const key = `${path.basename(file)}-${st.size}-${Math.floor(st.mtimeMs)}`.replace(/[^\w.-]+/g, "_");
  const cachePath = path.join(cacheDir(), `${key}.transcript.json`);
  if (!flags["no-cache"]) {
    try {
      const raw = JSON.parse(await readFile(cachePath, "utf8")) as ServerTranscript;
      log(`逐字稿：使用快取（${cachePath}）`);
      return { transcript: normalizeTranscript(raw), raw };
    } catch {
      /* 沒快取 */
    }
  }
  const c = await client(flags);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "aicut-up-"));
  try {
    const opus = path.join(tmp, "upload.ogg");
    log("轉檔（16k mono opus 上傳用）…");
    await ff.toUploadOpus(file, opus);
    log("上傳到 ttls 轉寫（faster-whisper）…");
    let last = "";
    const raw = (await transcribe(c, opus, {
      language: str(flags, "lang", "zh"),
      model: str(flags, "model", "auto"),
      hotwords: str(flags, "hotwords", ""),
      onProgress: (status, progress, waiting) => {
        const line = status === "queued" ? `  排隊中 ${Math.round(waiting)}s` : status === "busy" ? `  伺服器忙碌，${waiting}s 後重試` : `  ${status}${progress ? ` ${progress}` : ""}`;
        if (line !== last) {
          log(line);
          last = line;
        }
      },
    })) as ServerTranscript;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(cachePath, JSON.stringify(raw), "utf8");
    return { transcript: normalizeTranscript(raw), raw };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** 規則候選的預設狀態（與 App store/decisions.ts 的 defaultStateFor 相同）。 */
function defaultState(c: Candidate, aggressiveness: number): DecisionState {
  if (c.source === "user") return "accepted";
  if (SUGGEST_ONLY_KINDS.has(c.kind)) return "pending";
  return c.score >= thresholdsFor(aggressiveness).fillerAutoScore ? "auto" : "pending";
}

interface Analysis {
  transcript: Transcript;
  candidates: Candidate[];
  decisions: DecisionMap;
  effects: AudioEffect[];
  /** App 裡用刀片切的切點。沒讀的話 CLI 會剪出跟 App 不一樣長度的成品。 */
  splits: SplitPoint[];
  /**
   * CLI **做不到**的東西有幾個。
   *
   * CLI 的剪接器是 ffmpeg 的 atrim + concat，沒有 App 那套逐 frame 混音，也不寫章節。
   * 專案裡有配樂 / 章節時，CLI 產出的東西會跟 App 不一樣 —— 這種「安靜地少東西」
   * 最難發現（檔案有產出、長度也對，只是音樂不見了），所以一定要出聲。
   */
  unsupported: { overlays: number; chapters: number };
}

async function analyze(file: string, ff: Ffmpeg, flags: Record<string, string | true>): Promise<Analysis> {
  const aggr = Math.max(0, Math.min(100, num(flags, "aggressiveness", 50)));
  const { transcript } = await getTranscript(file, ff, flags);
  log(`逐字稿：${transcript.words.length} 字 · ${transcript.sentences.length} 句 · ${transcript.model || "ttls"}`);
  const candidates = runRulesAt({ transcript, loudness: [], loudnessHopMs: 100 }, aggr);
  const decisions: DecisionMap = {};
  const at = new Date().toISOString();
  for (const c of candidates) decisions[c.id] = { state: defaultState(c, aggr), origin: "rule", at };
  log(`規則層：${candidates.length} 個候選（${summarizeKinds(candidates)}）`);
  if (flags.judge) {
    const model = str(flags, "claude-model", "sonnet");
    log(`AI 判讀（claude ${model}）…`);
    const r = await judgeAll(transcript, candidates, decisions, model, (d, n) => log(`  ${d} / ${n} 視窗`));
    for (const u of r.updates) if (decisions[u.id]) decisions[u.id] = { state: u.state, origin: "llm", reason: u.reason, at };
    for (const c of r.added) {
      if (candidates.some((x) => x.id === c.id)) continue;
      candidates.push(c);
      decisions[c.id] = { state: SUGGEST_ONLY_KINDS.has(c.kind) ? "pending" : defaultState(c, aggr), origin: "llm", reason: c.reason, at };
    }
    candidates.sort((a, b) => a.startMs - b.startMs);
    const applied = r.updates.filter((u) => u.state === "auto").length;
    const dropped = r.updates.filter((u) => u.state === "rejected").length;
    log(`AI 判讀完成：剪 ${applied}、不剪 ${dropped}、新增建議 ${r.added.length}${r.failed ? `（${r.failed} 個視窗失敗）` : ""}`);
    for (const w of r.warnings.slice(0, 5)) log(`  ! ${w}`);
  }
  return { transcript, candidates, decisions, effects: [], splits: [], unsupported: { overlays: 0, chapters: 0 } };
}

function summarizeKinds(cands: Candidate[]): string {
  const m = new Map<string, number>();
  for (const c of cands) m.set(c.kind, (m.get(c.kind) ?? 0) + 1);
  return [...m].map(([k, n]) => `${KIND_LABEL[k as keyof typeof KIND_LABEL] ?? k} ${n}`).join("、") || "無";
}

async function loadProject(p: string): Promise<Analysis & { mediaPath: string | null; aggressiveness: number; targetLufs: number }> {
  const doc = JSON.parse(await readFile(p, "utf8")) as {
    media?: { id: string; path: string }[];
    activeMediaId?: string | null;
    settings?: { aggressiveness?: number; targetLufs?: number };
    analysis?: Record<
      string,
      {
        transcript?: Transcript;
        candidates?: Candidate[];
        decisions?: DecisionMap;
        effects?: AudioEffect[];
        splits?: SplitPoint[];
        overlays?: { lane: string }[];
        markers?: { kind: string }[];
      }
    >;
  };
  const id = doc.activeMediaId ?? doc.media?.[0]?.id;
  const rec = id ? doc.analysis?.[id] : undefined;
  if (!rec) throw new Error("專案檔沒有分析記錄（請先在 App 分析或手動剪輯後儲存）");
  const media = doc.media?.find((m) => m.id === id);
  return {
    transcript: rec.transcript ?? { words: [], segments: [], sentences: [], vad: [], durationMs: 0, language: "", model: "" },
    candidates: rec.candidates ?? [],
    decisions: rec.decisions ?? {},
    effects: rec.effects ?? [],
    splits: rec.splits ?? [],
    unsupported: {
      overlays: rec.overlays?.length ?? 0,
      chapters: (rec.markers ?? []).filter((m) => m.kind === "chapter").length,
    },
    mediaPath: media?.path ?? null,
    aggressiveness: doc.settings?.aggressiveness ?? 50,
    targetLufs: doc.settings?.targetLufs ?? -16,
  };
}

function edlOf(a: Analysis, durationMs: number, aggressiveness: number): Edl {
  const th = thresholdsFor(aggressiveness);
  const tr = a.transcript;
  return buildEdl(
    { words: tr.words, sentences: tr.sentences, vad: tr.vad, durationMs: tr.durationMs || durationMs, splits: a.splits },
    a.candidates,
    a.decisions,
    { ...DEFAULT_EDL_OPTIONS, maxSentenceRemovalRatio: th.maxSentenceRemovalRatio },
  );
}

function printDecisions(a: Analysis): void {
  const rows = a.candidates.map((c) => {
    const d = a.decisions[c.id];
    const st = d?.state ?? "pending";
    const mark = isActiveState(st) ? "✂" : st === "rejected" ? "·" : "?";
    return `  ${mark} ${fmtMs(c.startMs)} ${((c.endMs - c.startMs) / 1000).toFixed(2)}s ${KIND_LABEL[c.kind]}  ${c.reason}${d?.origin === "llm" && d.reason ? `  [AI] ${d.reason}` : ""}`;
  });
  process.stdout.write(`${rows.join("\n")}\n`);
}

// ---------------- 指令 ----------------

async function cmdTranscribe(args: Args): Promise<void> {
  const file = args.positional[0];
  if (!file) throw new Error("請給音檔路徑");
  const ff = ffmpegOf(args.flags);
  const { transcript, raw } = await getTranscript(file, ff, args.flags);
  const out = typeof args.flags.json === "string" ? args.flags.json : null;
  if (out) {
    await writeFile(out, JSON.stringify(raw, null, 2), "utf8");
    log(`已寫入 ${out}`);
  }
  for (const s of transcript.sentences) {
    const text = s.wordIds.map((id) => transcript.words[id]?.text ?? "").join("");
    process.stdout.write(`${fmtMs(s.startMs)}  ${text}\n`);
  }
}

async function cmdAnalyze(args: Args): Promise<void> {
  const file = args.positional[0];
  if (!file) throw new Error("請給音檔路徑");
  const ff = ffmpegOf(args.flags);
  const probe = await ff.probe(file);
  const a = await analyze(file, ff, args.flags);
  printDecisions(a);
  const aggr = num(args.flags, "aggressiveness", 50);
  const edl = edlOf(a, probe.durationMs, aggr);
  log(`EDL：剪掉 ${(edl.stats.removedMs / 1000).toFixed(1)} 秒 / 保留 ${(edl.stats.keptMs / 1000).toFixed(1)} 秒 · ${edl.stats.cutCount} 刀`);
  const proj = typeof args.flags.project === "string" ? args.flags.project : null;
  if (proj) {
    const id = `cli-${Date.now().toString(36)}`;
    const doc = {
      schemaVersion: 1,
      app: { name: "AI Music Cut CLI", version: VERSION },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      media: [{ id, path: path.resolve(file), name: path.basename(file), fingerprint: "", probe: null, analysis: "ready" }],
      activeMediaId: id,
      settings: { aggressiveness: aggr, targetLufs: num(args.flags, "lufs", -16) },
      analysis: { [id]: { transcript: a.transcript, candidates: a.candidates, decisions: a.decisions, transcribedAt: new Date().toISOString() } },
    };
    await writeFile(proj, JSON.stringify(doc, null, 2), "utf8");
    log(`專案已寫入 ${proj}（可用 App 開啟微調）`);
  }
}

async function cmdCut(args: Args): Promise<void> {
  const ff = ffmpegOf(args.flags);
  let a: Analysis;
  let file = args.positional[0];
  let aggr = num(args.flags, "aggressiveness", 50);
  let lufs = num(args.flags, "lufs", -16);
  if (typeof args.flags.project === "string") {
    const p = await loadProject(args.flags.project);
    a = p;
    file = file || p.mediaPath || "";
    if (!args.flags.aggressiveness) aggr = p.aggressiveness;
    if (!args.flags.lufs) lufs = p.targetLufs;
    log(`專案：${a.candidates.length} 個候選、${a.effects.length} 個效果、${a.splits.length} 個切點（沿用 App 決策）`);
    // 安靜地少東西最難發現（檔案有產出、長度也對，只是音樂不見了），所以講清楚
    if (a.unsupported.overlays > 0) {
      warn(`這個專案有 ${a.unsupported.overlays} 段配樂 / 音效，**CLI 不會把它們混進去** —— 需要配樂請用 App 輸出。`);
    }
    if (a.unsupported.chapters > 0) {
      warn(`這個專案有 ${a.unsupported.chapters} 個章節，**CLI 不會寫進成品** —— 需要章節請用 App 輸出。`);
    }
  } else {
    if (!file) throw new Error("請給音檔路徑");
    a = await analyze(file, ff, args.flags);
  }
  if (!file) throw new Error("專案檔沒有媒體路徑，請一併給音檔");
  const probe = await ff.probe(file);
  const edl = edlOf(a, probe.durationMs, aggr);
  const format = (str(args.flags, "format", "") || (typeof args.flags.out === "string" ? path.extname(args.flags.out).slice(1) : "mp3") || "mp3").toLowerCase() as "mp3" | "m4a" | "wav";
  const out = typeof args.flags.out === "string" ? args.flags.out : path.join(path.dirname(file), `${path.basename(file).replace(/\.[^.]+$/, "")}_cut.${format}`);
  log(`剪接：${edl.keeps.length} 段保留 · 剪掉 ${(edl.stats.removedMs / 1000).toFixed(1)} 秒 · 目標 ${lufs} LUFS → ${out}`);
  const segs = edl.keeps.map((k) => ({ startMs: k.srcStartMs, endMs: k.srcEndMs, gainDb: k.gainDb }));
  const r = await ff.render(file, segs, a.effects, out, {
    targetLufs: lufs,
    truePeak: -1.5,
    format,
    onProgress: (st) => log(`  ${st === "cut" ? "剪接" : st === "measure" ? "量測響度" : "響度正規化 + 編碼"}…`),
  });
  const outProbe = await ff.probe(out);
  process.stdout.write(`${out}\n`);
  log(`完成：${(outProbe.durationMs / 1000).toFixed(1)} 秒（原 ${(probe.durationMs / 1000).toFixed(1)}）· 輸出 ${r.outputLufs?.toFixed(1) ?? "?"} LUFS`);
  if (args.flags.verify) await verifyOutput(a, edl, out, ff, args.flags);
}

/** 用 ASR 重新轉寫成品，與 EDL 預期保留的字逐字比對。 */
async function verifyOutput(a: Analysis, edl: Edl, outFile: string, ff: Ffmpeg, flags: Record<string, string | true>): Promise<VerifyReport> {
  if (!a.transcript.words.length) throw new Error("沒有逐字稿可比對（純人工剪輯無法用 ASR 驗證）");
  log("驗證：把成品送回 ttls 重新轉寫…");
  const { transcript: outTr } = await getTranscript(outFile, ff, { ...flags, "no-cache": true });
  const probe = await ff.probe(outFile);
  const r = verifyEdit(expectedWords(a.transcript, edl), actualWords(outTr), edl, {
    outDurationMs: probe.durationMs,
    // 這裡刻意用 keptMs 而不是 edl.stats.outMs：CLI 的剪接器是 ffmpeg 的 atrim + concat，
    // 沒有 crossfade、沒有 room tone gap，成品長度天生就等於保留段總長。
    // App 走 Rust 的 Cutter（有接點），才要用含接點帳的 outMs / expectedOutMs。
    expectedDurationMs: edl.stats.keptMs,
  });
  printVerify(r);
  return r;
}

function printVerify(r: VerifyReport): void {
  process.stdout.write(`\n${r.summary}\n`);
  if (r.durationDeltaMs != null) process.stdout.write(`  時長差：${(r.durationDeltaMs / 1000).toFixed(2)} 秒（成品 vs EDL 預估）\n`);
  const hard = r.findings.filter((f) => (f.kind === "missing" || f.kind === "extra") && !f.lowConfidence);
  for (const f of hard.slice(0, 20)) {
    const tag = f.kind === "missing" ? "漏字" : "該剪沒剪";
    process.stdout.write(`  ${tag} 原始 ${fmtMs(f.srcMs)} / 成品 ${fmtMs(f.outMs)}  「${f.expected ?? f.actual}」${f.nearSeam ? "（接縫附近）" : ""}\n`);
  }
  if (hard.length > 20) process.stdout.write(`  …還有 ${hard.length - 20} 筆\n`);
  for (const s of r.seams.filter((x) => !x.ok).slice(0, 10)) {
    process.stdout.write(`  可疑接縫 成品 ${fmtMs(s.outMs)}（原始 ${fmtMs(s.srcBeforeMs)} → ${fmtMs(s.srcAfterMs)}）：${s.note}\n`);
  }
}

async function cmdVerify(args: Args): Promise<void> {
  const [src, out] = args.positional;
  if (!src || !out) throw new Error("用法：aicut verify <原始音檔> <剪好的成品> [--project p.aicut.json]");
  const ff = ffmpegOf(args.flags);
  let a: Analysis;
  let aggr = num(args.flags, "aggressiveness", 50);
  if (typeof args.flags.project === "string") {
    const p = await loadProject(args.flags.project);
    a = p;
    if (!args.flags.aggressiveness) aggr = p.aggressiveness;
  } else {
    a = await analyze(src, ff, args.flags);
  }
  const probe = await ff.probe(src);
  const edl = edlOf(a, probe.durationMs, aggr);
  const r = await verifyOutput(a, edl, out, ff, args.flags);
  process.exitCode = r.findings.some((f) => (f.kind === "missing" || f.kind === "extra") && !f.lowConfidence) ? 2 : 0;
}

async function cmdBeats(args: Args): Promise<void> {
  const file = args.positional[0];
  if (!file) throw new Error("請給音檔路徑");
  const ff = ffmpegOf(args.flags);
  const probe = await ff.probe(file);
  log("解碼並計算能量包絡…");
  const { rmsU8, pps, sampleRate, totalSamples } = await ff.rmsBuckets(file);
  const a: LocalAnalysis = {
    version: 2,
    pps,
    hopMs: 100,
    sampleRate,
    nBuckets: rmsU8.length,
    nWin: 0,
    totalSamples,
    durationMs: probe.durationMs,
    mins: new Int8Array(0),
    maxs: new Int8Array(0),
    rmsU8,
    win: new Float32Array(0),
  };
  const g = detectBeats(a);
  const ok = g.confidence >= MIN_BEAT_CONFIDENCE;
  process.stdout.write(`${g.bpm} BPM · 每拍 ${g.periodMs.toFixed(1)} ms · 首拍 ${fmtMs(g.offsetMs)} · 信心 ${(g.confidence * 100).toFixed(0)}%${ok ? "" : "（信心不足，可能不是節奏明顯的音樂）"}\n`);
  if (args.flags.bars) {
    const bars = g.beats.filter((_, i) => i % g.beatsPerBar === 0).slice(0, 40);
    process.stdout.write(`小節線：${bars.map((b) => fmtMs(b, )).join("  ")}\n`);
  }
  process.exitCode = ok ? 0 : 3;
}

async function cmdMusic(args: Args): Promise<void> {
  const prompt = args.positional.join(" ").trim();
  if (!prompt) throw new Error('用法：aicut music "<風格描述>" [--duration 30] [--bpm 90] [--quality fast|fine|max]');
  const c = await client(args.flags);
  const durationSec = Math.max(10, Math.min(240, num(args.flags, "duration", 30)));
  const bpm = Math.max(0, Math.min(300, num(args.flags, "bpm", 0)));
  const quality = str(args.flags, "quality", "fast");
  const nCandidates = Math.max(1, Math.min(4, num(args.flags, "n", 1)));
  const format = str(args.flags, "format", "mp3");
  const dir = str(args.flags, "out-dir", process.cwd());
  log(`ACE-Step 生成中（${durationSec} 秒${bpm ? ` · ${bpm} BPM` : ""} · ${quality} · ${nCandidates} 首）…`);
  let last = "";
  const outs = await generateMusic(c, {
    prompt,
    durationSec,
    bpm,
    quality,
    nCandidates,
    format,
    onProgress: (status, sec) => {
      const line = `  ${status} ${sec}s`;
      if (line !== last) {
        log(line);
        last = line;
      }
    },
  });
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  const stem = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "bgm";
  for (const o of outs) {
    const name = outs.length > 1 ? `${stem}-${o.index + 1}` : stem;
    const p = path.join(dir, `${name}.${o.format}`);
    await writeFile(p, o.data);
    process.stdout.write(`${p}\n`);
    log(`  ${(o.data.length / 1048576).toFixed(1)} MB${o.seed != null ? ` · seed ${o.seed}` : ""}`);
  }
}

async function cmdStyle(args: Args): Promise<void> {
  const [file, ...rest] = args.positional;
  const prompt = rest.join(" ").trim();
  if (!file || !prompt) throw new Error('用法：aicut style <音檔> "<目標曲風>" [--from 0] [--to 30] [--strength 0.7]');
  const ff = ffmpegOf(args.flags);
  const probe = await ff.probe(file);
  const fromMs = Math.max(0, num(args.flags, "from", 0) * 1000);
  const toMs = Math.min(probe.durationMs, num(args.flags, "to", 0) * 1000 || probe.durationMs);
  if (toMs - fromMs < 2000) throw new Error("參考片段至少要 2 秒");
  const strength = Math.max(0, Math.min(1, num(args.flags, "strength", 0.7)));
  const nCandidates = Math.max(1, Math.min(4, num(args.flags, "n", 1)));
  const format = str(args.flags, "format", "mp3");
  const dir = str(args.flags, "out-dir", path.dirname(file));
  const c = await client(args.flags);

  const tmp = await mkdtemp(path.join(os.tmpdir(), "aicut-style-"));
  try {
    const clip = path.join(tmp, "source.wav");
    log(`切出參考片段 ${fmtMs(fromMs)}–${fmtMs(toMs)}…`);
    await ff.clip(file, fromMs, toMs, clip);
    log(`上傳並轉換曲風（貼近度 ${(strength * 100).toFixed(0)}% · ${nCandidates} 首）…`);
    let last = "";
    const outs = await styleTransfer(c, {
      prompt,
      audioPath: clip,
      coverStrength: strength,
      durationSec: num(args.flags, "duration", (toMs - fromMs) / 1000),
      nCandidates,
      format,
      onProgress: (status, sec) => {
        const line = `  ${status} ${sec}s`;
        if (line !== last) {
          log(line);
          last = line;
        }
      },
    });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    const base = path.basename(file).replace(/\.[^.]+$/, "");
    const stem = `${base}-${prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "style"}`;
    for (const o of outs) {
      const name = outs.length > 1 ? `${stem}-${o.index + 1}` : stem;
      const p = path.join(dir, `${name}.${o.format}`);
      await writeFile(p, o.data);
      process.stdout.write(`${p}\n`);
      log(`  ${(o.data.length / 1048576).toFixed(1)} MB${o.seed != null ? ` · seed ${o.seed}` : ""}`);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function cmdSeparate(args: Args): Promise<void> {
  const file = args.positional[0];
  if (!file) throw new Error("請給音檔路徑");
  const c = await client(args.flags);
  const stems = (str(args.flags, "stems", "vocals_accom") === "all" ? "all" : "vocals_accom") as "vocals_accom" | "all";
  const format = str(args.flags, "format", "wav");
  const dir = str(args.flags, "out-dir", path.dirname(file));
  log(`上傳並分離（demucs htdemucs，${stems === "all" ? "4 軌" : "人聲 + 伴奏"}）…`);
  const res = await separate(c, file, stems, format);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  const base = path.basename(file).replace(/\.[^.]+$/, "");
  for (const s of res) {
    const p = path.join(dir, `${base}_${s.name}.${s.format}`);
    await writeFile(p, s.data);
    process.stdout.write(`${p}\n`);
    log(`  ${s.label}：${(s.data.length / 1048576).toFixed(1)} MB`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.cmd) {
    case "transcribe":
      return cmdTranscribe(args);
    case "analyze":
      return cmdAnalyze(args);
    case "cut":
      return cmdCut(args);
    case "separate":
      return cmdSeparate(args);
    case "verify":
      return cmdVerify(args);
    case "beats":
      return cmdBeats(args);
    case "music":
      return cmdMusic(args);
    case "style":
      return cmdStyle(args);
    case "--version":
    case "version":
      process.stdout.write(`${VERSION}\n`);
      return;
    default:
      help();
  }
}

main().catch((e: unknown) => {
  const raw = e instanceof Error ? e.message : String(e);
  const msg = /out of memory|OutOfMemoryError/i.test(raw)
    ? "GPU 記憶體不足：音樂生成與語音合成共用同一張卡，請等其他任務結束或重啟 tts-service 後再試（曲風轉換比純生成更吃記憶體）。"
    : raw.length > 400
      ? `${raw.slice(0, 400)}…`
      : raw;
  log(`錯誤：${msg}`);
  process.exit(1);
});
