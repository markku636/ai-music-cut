// AI 助手的工具目錄（MCP tools）：名稱 / JSON schema / handler。
// Rust 端只當 JSON-RPC 轉發器：claude 呼叫 → `mcp-tool-call` 事件 → 這裡執行 → `mcp_tool_result` 回寫。
import { listen } from "@tauri-apps/api/event";
import { effectId as fxEffectId } from "../analysis/effects";
import { allEffectSpecs, applyEffect, effectContext, effectSpec, rangeFor } from "../effects/registry";
import { resolveValues, type ParamValue } from "../effects/spec";
import { makeNoisePrint, matchLoudnessGainDb, peakNormalizeGainDb } from "../analysis/levels";
import { analyzeAlignment, LOW_CONFIDENCE as ALIGN_LOW_CONFIDENCE, renderAlignment, type AlignMode } from "../pipeline/align";
import { RENDER_FORMATS } from "../analysis/formats";
import { api, type McpToolCall, type McpToolDef } from "../api";
import { KIND_LABEL, isActiveState, type Candidate, type CandidateKind, type DecisionState, type MarkerKind } from "../analysis/types";
import { buildChapters } from "../analysis/chapters";
import { fillerCandidates, findText, totalMs } from "../analysis/textSearch";
import { describeCleanup, estimateCleanup, isCleanupActive, normalizeCleanup, CLEANUP_OFF } from "../analysis/cleanup";
import { useCleanup } from "../store/cleanup";
import { useHighlights } from "../store/highlights";
import { useShowNotes } from "../store/showNotes";
import { generateShowNotes } from "../pipeline/shownotes";
import { stamp, toMarkdown } from "../analysis/shownotes";
import { normalizeRanges, reelSourceMs } from "../analysis/reel";
import { assignWords, speakerStats, type Speaker } from "../analysis/speakers";
import { levelSpread, speakerLevels, spreadVerdict } from "../analysis/speakerLevel";
import { groupFillers } from "../analysis/fillerStats";
import { hasSignal, observeEpisode, parseObservations, putObservation, serializeObservations, suggestRules, totalsOf } from "../analysis/fillerLearn";
import { useSettings } from "../store/settings";
import { buildCues, CAPTION_EXT, renderCaptions, type CaptionFormat } from "../analysis/captions";
import { splitByChapters, totalOutMs } from "../analysis/splitExport";
import { loudnessProfile, vsEpisode } from "../analysis/profile";
import { hasBlocker, preflight, summarize } from "../analysis/preflight";

import { DEFAULT_DUCK, DEFAULT_MUSIC, DEFAULT_SFX, planDuck, voiceRegionsInOutput } from "../analysis/overlays";
import { analyzeMicSync, combineMics } from "../pipeline/syncMics";
import type { EffectKind } from "../analysis/effects";
import { edlFor, runRulesFor } from "../pipeline/rules";
import { qcFor } from "../pipeline/audioQc";
import { keepTake, takesFor } from "../pipeline/takes";
import { savedMsOf } from "../analysis/takes";
import { useTimeline } from "../store/timeline";
import { addEffectOnSelection } from "../timeline/selectionActions";
import { bladeAt, liftSelection, seamsOfEdl, setSeamPause, trimSeam } from "../timeline/trimActions";
import { playRange } from "../preview/playerRef";
import { decisionCounts, useDecisions } from "../store/decisions";
import { usePlayback } from "../store/playback";
import { selectActiveMedia, useProject } from "../store/project";
import { useTranscript } from "../store/transcript";
import { formatMs } from "../time";

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

class ToolError extends Error {}

/**
 * 需要逐字稿的工具用這個（候選、判讀、逐字比對之類）。
 */
function ctx() {
  const m = ctxMedia();
  const tr = useTranscript.getState().byMedia[m.media.id];
  if (!tr) throw new ToolError(`「${m.media.name}」尚未分析（請先按「分析」）`);
  return { ...m, tr, cands: m.d.candidates[m.media.id] ?? [], dec: m.d.decisions[m.media.id] ?? {} };
}

/**
 * 只需要「有開檔」的工具用這個。
 *
 * 手動剪輯、刀片、標記、配樂都**不需要**先跑 ASR（App 本來就是開檔就能剪），
 * 所以這些工具不該因為沒有逐字稿就拒絕 —— 那會逼使用者為了放一段開場音樂
 * 先花幾分鐘上傳轉寫。
 */
function ctxMedia() {
  const proj = useProject.getState();
  const media = selectActiveMedia(proj);
  if (!media) throw new ToolError("目前沒有開啟的音檔");
  const d = useDecisions.getState();
  return { proj, media, d };
}

function num(v: unknown, dflt: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function candText(c: Candidate, tr: ReturnType<typeof ctx>["tr"]): string {
  if (c.wordIds.length) return c.wordIds.map((id) => tr.words[id]?.text ?? "").join("");
  return `[${KIND_LABEL[c.kind]} ${((c.endMs - c.startMs) / 1000).toFixed(1)}s]`;
}

function candView(c: Candidate, x: ReturnType<typeof ctx>) {
  return {
    id: c.id,
    kind: c.kind,
    state: x.dec[c.id]?.state ?? "pending",
    startMs: c.startMs,
    endMs: c.endMs,
    at: formatMs(c.startMs, { millis: false }),
    text: candText(c, x.tr),
    reason: c.reason,
    score: Number(c.score.toFixed(2)),
    sentenceId: c.sentenceId,
  };
}

const STATE_ENUM: DecisionState[] = ["accepted", "rejected", "pending"];
const KIND_ENUM: CandidateKind[] = ["filler", "stutter", "restart", "long_pause", "unclear", "noise", "rambling", "off_topic", "redo", "manual"];

export const TOOLS: ToolSpec[] = [
  {
    name: "get_project_summary",
    description:
      "目前開啟音檔的總覽：長度、逐字稿字數（若已分析）、候選各狀態/類型數量、目前會剪掉幾秒、切點 / 標記 / 配樂的數量、激進度。任何操作前先呼叫。**沒有逐字稿也能用** —— 手動剪輯、刀片、標記、配樂都不需要先分析。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      // 這是所有工作的入口，**不能**因為「還沒分析」就整個失敗 ——
      // App 本身開檔就能剪，而且 MCP 的指示叫 claude 先呼叫這一支；
      // 它一丟例外，claude 就會以為什麼都不能做而放棄整個任務（實測過）。
      const x = ctxMedia();
      const tr = useTranscript.getState().byMedia[x.media.id];
      const cands = x.d.candidates[x.media.id] ?? [];
      const dec = x.d.decisions[x.media.id] ?? {};
      const edl = edlFor(x.media.id);
      return {
        media: { id: x.media.id, name: x.media.name, durationMs: x.media.probe?.duration_ms ?? tr?.durationMs ?? 0 },
        analyzed: !!tr,
        transcript: tr ? { words: tr.words.length, sentences: tr.sentences.length, model: tr.model, language: tr.language } : null,
        counts: decisionCounts(cands, dec),
        removedMs: edl?.stats.removedMs ?? 0,
        keptMs: edl?.stats.keptMs ?? 0,
        cutCount: edl?.stats.cutCount ?? 0,
        splits: (x.d.splits[x.media.id] ?? []).length,
        markers: (x.d.markers[x.media.id] ?? []).length,
        overlays: (x.d.overlays[x.media.id] ?? []).length,
        aggressiveness: x.proj.aggressiveness,
        targetLufs: x.proj.targetLufs,
        stateMeaning: { auto: "規則自動剪（可 undo）", accepted: "使用者/AI 接受，會剪", pending: "待決建議，不剪", rejected: "不剪" },
        ...(tr
          ? {}
          : { note: "這個檔案還沒做逐字稿分析，所以沒有候選可以判讀；但刀片、修剪、標記、章節、配樂這些都能直接做。" }),
      };
    },
  },
  {
    name: "get_transcript",
    description: "讀逐字稿（依句子分頁，預設每次 60 句）。每句附時間、文字與覆蓋它的候選（id/kind/state/reason）。用 fromMs 分頁。",
    inputSchema: {
      type: "object",
      properties: {
        fromMs: { type: "number", description: "從這個時間（ms）開始" },
        toMs: { type: "number" },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "最多幾句（預設 60）" },
        withWords: { type: "boolean", description: "是否附每個字的 id/時間/信心（較長）" },
      },
      additionalProperties: false,
    },
    handler: (a) => {
      const x = ctx();
      const from = num(a.fromMs, 0);
      const to = num(a.toMs, Number.POSITIVE_INFINITY);
      const limit = Math.min(200, Math.max(1, num(a.limit, 60)));
      const all = x.tr.sentences.filter((s) => s.endMs > from && s.startMs < to);
      const page = all.slice(0, limit);
      const bySentence = new Map<number, Candidate[]>();
      for (const c of x.cands) {
        const arr = bySentence.get(c.sentenceId) ?? [];
        arr.push(c);
        bySentence.set(c.sentenceId, arr);
      }
      return {
        sentences: page.map((s) => ({
          id: s.id,
          startMs: s.startMs,
          endMs: s.endMs,
          at: formatMs(s.startMs, { millis: false }),
          text: s.wordIds.map((id) => x.tr.words[id].text).join(""),
          ...(a.withWords ? { words: s.wordIds.map((id) => ({ id, text: x.tr.words[id].text, startMs: x.tr.words[id].startMs, endMs: x.tr.words[id].endMs, prob: Number(x.tr.words[id].prob.toFixed(2)) })) } : {}),
          candidates: (bySentence.get(s.id) ?? []).map((c) => ({ id: c.id, kind: c.kind, state: x.dec[c.id]?.state ?? "pending", text: candText(c, x.tr), reason: c.reason })),
        })),
        more: all.length > page.length,
        nextFromMs: all.length > page.length ? page[page.length - 1].endMs : null,
      };
    },
  },
  {
    name: "list_candidates",
    description: "列出候選（可依 kind / state / 時間範圍篩選）。回 id、類型、狀態、時間、文字、理由、分數。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: KIND_ENUM },
        state: { type: "string", enum: ["auto", "accepted", "rejected", "pending", "active"], description: "active = auto 或 accepted" },
        fromMs: { type: "number" },
        toMs: { type: "number" },
        textContains: { type: "string", description: "文字包含（例如「就是」）" },
        limit: { type: "integer", minimum: 1, maximum: 500 },
      },
      additionalProperties: false,
    },
    handler: (a) => {
      const x = ctx();
      const from = num(a.fromMs, 0);
      const to = num(a.toMs, Number.POSITIVE_INFINITY);
      const limit = Math.min(500, Math.max(1, num(a.limit, 100)));
      const q = typeof a.textContains === "string" ? a.textContains.trim() : "";
      const list = x.cands.filter((c) => {
        if (a.kind && c.kind !== a.kind) return false;
        const st = x.dec[c.id]?.state ?? "pending";
        if (a.state === "active" ? !isActiveState(st) : a.state && st !== a.state) return false;
        if (c.endMs <= from || c.startMs >= to) return false;
        if (q && !candText(c, x.tr).includes(q)) return false;
        return true;
      });
      return { total: list.length, candidates: list.slice(0, limit).map((c) => candView(c, x)) };
    },
  },
  {
    name: "set_decisions",
    description: "把一批候選設為 accepted（會剪）/ rejected（不剪）/ pending（留給使用者決定）。一次呼叫＝一筆可復原操作。",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, minItems: 1 },
        state: { type: "string", enum: STATE_ENUM },
        reason: { type: "string", description: "簡短理由（顯示在決策面板）" },
      },
      required: ["ids", "state"],
      additionalProperties: false,
    },
    handler: (a) => {
      const x = ctx();
      const ids = Array.isArray(a.ids) ? (a.ids as unknown[]).map(String) : [];
      const known = new Set(x.cands.map((c) => c.id));
      const ok = ids.filter((id) => known.has(id));
      const state = a.state as DecisionState;
      if (!STATE_ENUM.includes(state)) throw new ToolError(`state 必須是 ${STATE_ENUM.join("/")}`);
      if (ok.length) x.d.decide(x.media.id, ok, state, { origin: "llm", reason: typeof a.reason === "string" ? a.reason : undefined, label: `AI：${state} ${ok.length} 筆` });
      const counts = decisionCounts(x.cands, useDecisions.getState().decisions[x.media.id] ?? {});
      return { updated: ok.length, notFound: ids.filter((id) => !known.has(id)), counts: counts.byState };
    },
  },
  {
    name: "add_cut",
    description: "新增一段手動剪除（來源時間 ms）。會自動對齊到落在範圍內的字；用於使用者指定「把這段剪掉」。",
    inputSchema: {
      type: "object",
      properties: { startMs: { type: "number" }, endMs: { type: "number" }, reason: { type: "string" } },
      required: ["startMs", "endMs"],
      additionalProperties: false,
    },
    handler: (a) => {
      const x = ctx();
      const s = num(a.startMs, -1);
      const e = num(a.endMs, -1);
      if (s < 0 || e <= s) throw new ToolError("startMs/endMs 無效");
      const wordIds = x.tr.words.filter((w) => w.startMs >= s - 1 && w.endMs <= e + 1).map((w) => w.id);
      const sid = wordIds.length ? (x.tr.sentences.find((st) => st.wordIds.includes(wordIds[0]))?.id ?? -1) : -1;
      const id = x.d.addManualCut(x.media.id, s, e, wordIds, typeof a.reason === "string" ? a.reason : "AI 助手新增剪除", sid);
      return { id, wordIds, text: wordIds.map((w) => x.tr.words[w].text).join("") };
    },
  },
  {
    name: "find_text",
    description:
      "在逐字稿裡找一段文字，回所有命中（來源時間、原文）。比對忽略標點與空白，所以「那個那個」找得到「那個，那個」，也可以跨句。用於回答「這集講過幾次 X」或先確認要剪什麼。",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 500 } },
      required: ["query"],
      additionalProperties: false,
    },
    handler: (a) => {
      const x = ctx();
      const q = typeof a.query === "string" ? a.query : "";
      const hits = findText(x.tr, q, { limit: num(a.limit, 200) });
      return {
        query: q,
        count: hits.length,
        totalMs: Math.round(totalMs(hits)),
        hits: hits.map((h) => ({ startMs: Math.round(h.startMs), endMs: Math.round(h.endMs), text: h.text, sentenceId: h.sentenceId })),
        // 沒命中不是錯誤：可能只是這集真的沒講過。順手提供這集真正的口頭禪，省一輪往返。
        fillers: hits.length ? undefined : fillerCandidates(x.tr).slice(0, 8),
      };
    },
  },
  {
    name: "cut_text",
    description:
      "把逐字稿裡所有（或指定第幾個）命中的文字剪掉，一次 undo 就能全部還原。用於「把整集的『呃』拿掉」這種批次清理。沒有命中時回 0，不算錯誤。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        occurrences: { type: "array", items: { type: "integer", minimum: 1 }, description: "只剪第幾個（1 起算）；不給就是全部" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: (a) => {
      const x = ctx();
      const q = typeof a.query === "string" ? a.query : "";
      const all = findText(x.tr, q);
      const picked = Array.isArray(a.occurrences) && a.occurrences.length
        ? (a.occurrences as unknown[]).map((n) => all[Math.round(Number(n)) - 1]).filter((h) => h != null)
        : all;
      if (!picked.length) return { query: q, cut: 0, removedMs: 0, note: all.length ? "指定的序號超出命中範圍" : "逐字稿裡找不到這段文字" };
      const added = x.d.addManualCuts(
        x.media.id,
        picked.map((h) => ({ startMs: h.startMs, endMs: h.endMs, wordIds: h.wordIds, sentenceId: h.sentenceId })),
        `AI 助手：逐字稿剪除「${q}」`,
        `AI：剪掉「${q}」×${picked.length}`,
      );
      return {
        query: q,
        cut: picked.length,
        added,
        removedMs: Math.round(totalMs(picked)),
        // 重試同一個查詢時講清楚「已經剪過了」，否則模型會以為沒生效而一直重打
        note: added === 0 ? "這些段落先前就已經剪掉了，這次沒有變動" : undefined,
      };
    },
  },
  {
    name: "get_show_notes",
    description:
      "拿這一集已經產好的節目筆記（摘要 / 章節 / 節錄 / 關鍵字）。時間戳是**成品**時間。還沒產過就回 null，這時可以用 write_show_notes 產一份。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      const x = ctxMedia();
      const n = useShowNotes.getState().get(x.media.id);
      if (!n) return { notes: null, note: "還沒有節目筆記" };
      return {
        summary: n.summary,
        chapters: n.chapters.map((c) => ({ at: stamp(c.outMs), outMs: Math.round(c.outMs), title: c.title })),
        quotes: n.quotes.map((q) => ({ at: stamp(q.outMs), text: q.text })),
        keywords: n.keywords,
        markdown: toMarkdown(n, { title: x.media.name }),
      };
    },
  },
  {
    name: "write_show_notes",
    description:
      "讀這一集的逐字稿寫節目筆記（摘要 / 章節 / 節錄 / 關鍵字），存進專案。需要逐字稿。時間戳會自動換算成成品時間，被剪掉的段落不會被算進去。已經有的話會覆蓋。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const x = ctxMedia();
      const n = await generateShowNotes(x.media.id);
      useShowNotes.getState().set(x.media.id, n);
      return {
        summary: n.summary,
        chapters: n.chapters.map((c) => ({ at: stamp(c.outMs), title: c.title })),
        quotes: n.quotes.length,
        keywords: n.keywords,
      };
    },
  },
  {
    name: "list_highlights",
    description: "列出目前挑好的精華片段（之後可以串成一支預告輸出）。回每段的來源時間、長度與名稱。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      const x = ctxMedia();
      const list = useHighlights.getState().list(x.media.id);
      return {
        count: list.length,
        mergedCount: normalizeRanges(list).length,
        totalMs: Math.round(reelSourceMs(list)),
        highlights: list.map((h) => ({ id: h.id, startMs: Math.round(h.startMs), endMs: Math.round(h.endMs), title: h.title ?? null })),
      };
    },
  },
  {
    name: "add_highlight",
    description:
      "把一段標成精華（來源時間 ms）。用於「這句很適合放預告」。重疊的段落輸出時會自動合併，所以重複標同一處是安全的。",
    inputSchema: {
      type: "object",
      properties: { startMs: { type: "number" }, endMs: { type: "number" }, title: { type: "string" } },
      required: ["startMs", "endMs"],
      additionalProperties: false,
    },
    handler: (a) => {
      const x = ctxMedia();
      const st = num(a.startMs, -1);
      const en = num(a.endMs, -1);
      if (st < 0 || en <= st) throw new ToolError("startMs/endMs 無效");
      const hl = useHighlights.getState();
      // 已經標過同一段就不再加一筆（agent 會重試）
      const same = hl.list(x.media.id).find((h) => Math.abs(h.startMs - st) < 20 && Math.abs(h.endMs - en) < 20);
      if (same) return { id: same.id, added: false, note: "這一段先前就標過了", count: hl.list(x.media.id).length };
      const id = hl.add(x.media.id, st, en, typeof a.title === "string" ? a.title : undefined);
      return { id, added: true, count: hl.list(x.media.id).length };
    },
  },
  {
    name: "remove_highlight",
    description: "移除一個精華片段（id 來自 list_highlights）。",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    handler: (a) => {
      const x = ctxMedia();
      const hl = useHighlights.getState();
      const id = typeof a.id === "string" ? a.id : "";
      const existed = hl.list(x.media.id).some((h) => h.id === id);
      hl.remove(x.media.id, id);
      return { removed: existed, count: hl.list(x.media.id).length, note: existed ? undefined : "沒有這個 id（可能先前就移除了）" };
    },
  },
  {
    name: "get_cleanup",
    description:
      "看這個音檔的底噪量測與目前的修聲設定（去隆隆 / 降噪 / 齒音）。回建議值與「值不值得降噪」的判斷。不用先分析也能呼叫，只是沒分析就量不到底噪。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      const x = ctxMedia();
      const local = useTranscript.getState().local[x.media.id] ?? null;
      const est = estimateCleanup(local);
      const current = useCleanup.getState().get(x.media.id);
      return {
        measured: local ? { floorDb: +est.floorDb.toFixed(1), speechDb: +est.speechDb.toFixed(1), marginDb: +est.marginDb.toFixed(1) } : null,
        worthDenoise: est.worthDenoise,
        suggested: est.suggested,
        current,
        currentDescription: describeCleanup(current),
        summary: est.summary,
      };
    },
  },
  {
    name: "set_cleanup",
    description:
      "設定修聲。只給要改的欄位，其他沿用目前的設定。`useSuggested: true` 直接套建議值；`off: true` 全部關掉。修聲在響度正規化之前套用，輸出與預覽都會生效。",
    inputSchema: {
      type: "object",
      properties: {
        useSuggested: { type: "boolean" },
        off: { type: "boolean" },
        rumbleHz: { type: "number", description: "高通截止 Hz，0 = 關" },
        denoiseDb: { type: "number", description: "降噪量 dB，0 = 關；超過 18 安靜處會出現水聲" },
        deessAmount: { type: "number", description: "齒音抑制 0–1，0 = 關" },
      },
      additionalProperties: false,
    },
    handler: (a) => {
      const x = ctxMedia();
      const cl = useCleanup.getState();
      if (a.off === true) {
        cl.set(x.media.id, null);
        return { cleanup: null, description: describeCleanup(null) };
      }
      const local = useTranscript.getState().local[x.media.id] ?? null;
      const base = a.useSuggested === true ? estimateCleanup(local).suggested : (cl.get(x.media.id) ?? CLEANUP_OFF);
      const next = normalizeCleanup({
        ...base,
        ...(typeof a.rumbleHz === "number" ? { rumbleHz: a.rumbleHz } : {}),
        ...(typeof a.denoiseDb === "number" ? { denoiseDb: a.denoiseDb } : {}),
        ...(typeof a.deessAmount === "number" ? { deessAmount: a.deessAmount } : {}),
      });
      cl.set(x.media.id, isCleanupActive(next) ? next : null);
      const saved = cl.get(x.media.id);
      return { cleanup: saved, description: describeCleanup(saved) };
    },
  },
  {
    name: "set_aggressiveness",
    description: "調整激進度 0–100 並重跑規則層（使用者手動決定的候選會保留）。回新的候選數量。",
    inputSchema: { type: "object", properties: { value: { type: "integer", minimum: 0, maximum: 100 } }, required: ["value"], additionalProperties: false },
    handler: (a) => {
      const x = ctx();
      const v = Math.max(0, Math.min(100, Math.round(num(a.value, 50))));
      x.proj.setAggressiveness(v);
      const n = runRulesFor(x.media.id, { label: `AI：激進度 ${v}`, record: true });
      const counts = decisionCounts(useDecisions.getState().candidates[x.media.id] ?? [], useDecisions.getState().decisions[x.media.id] ?? {});
      return { aggressiveness: v, candidates: n, counts: counts.byState };
    },
  },
  {
    name: "get_edl_stats",
    description: "目前決策算出的剪輯統計：剪掉幾秒、保留幾秒、幾刀、各類型剪掉多少、被自然度守門降級的候選。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      const x = ctx();
      const edl = edlFor(x.media.id);
      if (!edl) throw new ToolError("無法建立 EDL");
      return { ...edl.stats, keeps: edl.keeps.length, downgrades: edl.downgrades };
    },
  },
  {
    name: "seek",
    description: "把播放游標移到某個時間（ms），讓使用者看到那段。",
    inputSchema: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"], additionalProperties: false },
    handler: (a) => {
      ctx();
      usePlayback.getState().seek(Math.max(0, num(a.ms, 0)));
      return { ok: true };
    },
  },
  {
    name: "preview",
    description: "播放一段給使用者聽（startMs–endMs）。skip=true 時套用目前剪除（聽剪後效果），false 聽原始。",
    inputSchema: {
      type: "object",
      properties: { startMs: { type: "number" }, endMs: { type: "number" }, skip: { type: "boolean" } },
      required: ["startMs", "endMs"],
      additionalProperties: false,
    },
    handler: (a) => {
      ctx();
      playRange(num(a.startMs, 0), num(a.endMs, 0), { skip: a.skip !== false });
      return { ok: true };
    },
  },
  {
    name: "undo",
    description: "復原上一步。一步是**整批**的 —— cut_text 一次剪掉 40 個「呃」算一步，undo 一次就全部回來，不必也不該呼叫 40 次。回傳還剩幾步可以復原。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      const d = useDecisions.getState();
      const label = d.past[d.past.length - 1]?.label ?? null;
      d.undo();
      return { undone: label };
    },
  },
  {
    name: "redo",
    description: "重做剛才復原掉的那一步（同樣是整批）。只有在剛 undo 過而且中間沒有做別的改動時才有東西可以重做。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      const d = useDecisions.getState();
      const label = d.future[d.future.length - 1]?.label ?? null;
      d.redo();
      return { redone: label };
    },
  },
  {
    name: "list_seams",
    description: "列出目前所有接縫（剪除區的接點與刀片切點），含位置、剪掉多長、接法（crossfade / gap / seam）。修剪前先呼叫這支看有哪些刀。",
    inputSchema: {
      type: "object",
      properties: {
        fromMs: { type: "number", description: "只列這個時間之後的" },
        toMs: { type: "number", description: "只列這個時間之前的" },
        limit: { type: "integer", minimum: 1, maximum: 500, default: 100 },
      },
      additionalProperties: false,
    },
    handler: (a) => {
      const x = ctxMedia();
      const from = num(a.fromMs, 0);
      const to = num(a.toMs, Number.MAX_SAFE_INTEGER);
      const all = seamsOfEdl(edlFor(x.media.id));
      const rows = all
        .filter((s) => s.srcBeforeMs >= from && s.srcBeforeMs <= to)
        .slice(0, Math.round(num(a.limit, 100)))
        .map((s) => ({
          afterKeepId: s.afterKeepId,
          at: formatMs(s.srcBeforeMs, { millis: true }),
          srcBeforeMs: Math.round(s.srcBeforeMs),
          srcAfterMs: Math.round(s.srcAfterMs),
          // 編排接縫（貼上 / 搬移）沒有「剪掉多久」—— 相減是負數，報出去只會讓 agent
          // 以為那裡「剪掉了 -13 秒」然後想去修它，但 trim_seam 對它是拒絕的。
          removedMs: s.rearranged ? null : Math.round(s.srcAfterMs - s.srcBeforeMs),
          rearranged: s.rearranged,
          trimmable: !s.rearranged,
          kind: s.kind,
          isBlade: !!s.splitId,
          pauseMs: Math.round(s.gapMs),
        }));
      return { total: all.length, seams: rows, note: "afterKeepId 只在下一次修剪前有效（保留段會重新編號）；連續操作請每次重新呼叫這支。" };
    },
  },
  {
    name: "blade_at",
    description:
      "刀片：在指定時間切一刀。切點本身不改變聲音，只是立一個可以修剪 / 插留白的接縫。**冪等** —— 同一個位置再呼叫一次不會把它拿掉（要移除請用 remove_blade）。切完接著呼叫 list_seams 拿 afterKeepId。",
    inputSchema: {
      type: "object",
      properties: { ms: { type: "number", description: "來源時間（毫秒）" } },
      required: ["ms"],
      additionalProperties: false,
    },
    handler: (a) => {
      ctxMedia();
      const ms = num(a.ms, -1);
      if (ms < 0) throw new ToolError("ms 必須是非負數");
      const r = bladeAt(ms);
      if (r === null) throw new ToolError("這個位置切不了：太靠近既有接縫，或落在已經剪掉的區段裡");
      return { bladed: r, ms: Math.round(ms), next: "用 list_seams 拿這一刀的 afterKeepId，再用 insert_pause / trim_seam 動它" };
    },
  },
  {
    name: "remove_blade",
    description: "移除某個刀片切點（±20 ms 內）。blade_at 是冪等的，要拿掉切點只能用這一支。",
    inputSchema: { type: "object", properties: { ms: { type: "number" } }, required: ["ms"], additionalProperties: false },
    handler: (a) => {
      const x = ctxMedia();
      const ms = num(a.ms, -1);
      if (ms < 0) throw new ToolError("ms 必須是非負數");
      const hit = (x.d.splits[x.media.id] ?? []).find((s2) => Math.abs(s2.ms - ms) <= 20);
      if (!hit) throw new ToolError("那個位置沒有切點");
      x.d.removeSplit(x.media.id, hit.id);
      return { removed: hit.id, ms: hit.ms };
    },
  },
  {
    name: "trim_seam",
    description: "修剪一個接縫。mode=ripple 只動一側（後面整串跟著位移、成品變長或變短）；mode=roll 兩側一起動（成品總長不變，只換接縫落在哪）。afterKeepId 從 list_seams 取得。",
    inputSchema: {
      type: "object",
      properties: {
        afterKeepId: { type: "integer", description: "從 list_seams 取得" },
        deltaMs: { type: "number", description: "位移量，正數往後、負數往前" },
        mode: { type: "string", enum: ["ripple", "roll"], default: "ripple" },
        side: { type: "string", enum: ["left", "right"], default: "left", description: "ripple 時要動哪一邊的邊界" },
      },
      required: ["afterKeepId", "deltaMs"],
      additionalProperties: false,
    },
    handler: (a) => {
      ctxMedia();
      const mode = a.mode === "roll" ? "roll" : "ripple";
      const side = a.side === "right" ? "right" : "left";
      const ok = trimSeam(Math.round(num(a.afterKeepId, -1)), Math.round(num(a.deltaMs, 0)), mode, side);
      if (!ok) throw new ToolError("修剪沒有生效：接縫不存在，或這個方向沒有意義（切點上的漣漪只能往外吃）");
      return { trimmed: true, mode, side, deltaMs: Math.round(num(a.deltaMs, 0)) };
    },
  },
  {
    name: "insert_pause",
    description: "在刀片切點插入留白（room tone）當段落呼吸；0 = 拿掉留白回到直接對接。只有刀片切出來的接縫可以。",
    inputSchema: {
      type: "object",
      properties: {
        afterKeepId: { type: "integer", description: "從 list_seams 取得（isBlade 必須是 true）" },
        ms: { type: "number", minimum: 0, maximum: 5000, description: "留白長度（毫秒）" },
      },
      required: ["afterKeepId", "ms"],
      additionalProperties: false,
    },
    handler: (a) => {
      ctxMedia();
      const ok = setSeamPause(Math.round(num(a.afterKeepId, -1)), Math.round(num(a.ms, 0)));
      if (!ok) throw new ToolError("那個接縫不是刀片切點（一般接縫的呼吸由 breath 自動決定）");
      return { pauseMs: Math.round(num(a.ms, 0)) };
    },
  },
  {
    name: "list_markers",
    description: "列出標記 / 章節 / 待辦。章節（kind=chapter）會寫進成品檔案的章節資訊（mp3 的 ID3 CHAP、m4a 的 QuickTime 章節）。",
    inputSchema: {
      type: "object",
      properties: { kind: { type: "string", enum: ["standard", "chapter", "todo"], description: "只列這一類" } },
      additionalProperties: false,
    },
    handler: (a) => {
      const x = ctxMedia();
      const kind = typeof a.kind === "string" ? a.kind : null;
      const list = (x.d.markers[x.media.id] ?? []).filter((m) => !kind || m.kind === kind);
      return {
        markers: list.map((m) => ({ id: m.id, kind: m.kind, ms: Math.round(m.ms), at: formatMs(m.ms, { millis: false }), title: m.title, done: m.done })),
      };
    },
  },
  {
    name: "add_marker",
    description: "在指定時間下一個標記。kind=chapter 的會寫進成品檔案當章節，所以一定要給 title。",
    inputSchema: {
      type: "object",
      properties: {
        ms: { type: "number" },
        kind: { type: "string", enum: ["standard", "chapter", "todo"], default: "standard" },
        title: { type: "string", maxLength: 60 },
      },
      required: ["ms"],
      additionalProperties: false,
    },
    handler: (a) => {
      const x = ctxMedia();
      const kind = (a.kind === "chapter" || a.kind === "todo" ? a.kind : "standard") as MarkerKind;
      const title = typeof a.title === "string" ? a.title.trim() : "";
      if (kind === "chapter" && !title) throw new ToolError("章節一定要給 title（那會顯示在 Podcast 播放器裡）");
      const id = x.d.addMarker(x.media.id, num(a.ms, 0), kind, title);
      return { id, kind, ms: Math.round(num(a.ms, 0)) };
    },
  },
  {
    name: "set_chapters",
    description:
      "整批設定章節（取代現有的章節標記，standard / todo 不動），一筆 undo。時間用**來源**時間軸；輸出時會自動換算成剪完之後的位置。標題請具體（「來賓怎麼開始寫程式」勝過「訪談」），≤ 14 字最好。",
    inputSchema: {
      type: "object",
      properties: {
        chapters: {
          type: "array",
          maxItems: 60,
          items: {
            type: "object",
            properties: { ms: { type: "number" }, title: { type: "string", maxLength: 60 } },
            required: ["ms", "title"],
            additionalProperties: false,
          },
        },
      },
      required: ["chapters"],
      additionalProperties: false,
    },
    handler: (a) => {
      const x = ctxMedia();
      const raw = Array.isArray(a.chapters) ? a.chapters : [];
      const rows = raw
        .map((c) => {
          const o = (c ?? {}) as Record<string, unknown>;
          return { ms: num(o.ms, -1), title: typeof o.title === "string" ? o.title.trim() : "" };
        })
        .filter((c) => c.ms >= 0 && c.title);
      if (!rows.length) throw new ToolError("chapters 是空的（每一筆都要有 ms 與 title）");
      const n = x.d.setChapters(x.media.id, rows);
      const built = buildChapters(x.d.markers[x.media.id] ?? [], edlFor(x.media.id), { outDurationMs: edlFor(x.media.id)?.stats.outMs ?? 0 });
      return {
        set: n,
        // 回報換算之後的成品時間，讓 claude 看得到剪輯造成的位移
        inOutput: built.map((c) => ({ startMs: Math.round(c.startMs), at: formatMs(c.startMs, { millis: false }), title: c.title })),
      };
    },
  },
  {
    name: "list_media",
    description: "媒體清單裡有哪些檔案（主聲軌之外的可以拿來當配樂 / 音效）。放配樂之前先看這個拿 mediaId。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      const x = ctxMedia();
      return {
        active: x.media.id,
        media: x.proj.media.map((m) => ({ id: m.id, name: m.name, durationMs: Math.round(m.probe?.duration_ms ?? 0), isActive: m.id === x.media.id })),
      };
    },
  },
  {
    name: "list_overlays",
    description: "目前疊在主聲軌上的配樂 / 音效。位置是**成品時間**（剪完之後的時間軸）。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      const x = ctxMedia();
      const list = x.d.overlays[x.media.id] ?? [];
      return {
        overlays: list.map((o) => ({
          id: o.id,
          lane: o.lane,
          source: x.proj.media.find((m) => m.id === o.mediaId)?.name ?? o.mediaId,
          outStartMs: Math.round(o.outStartMs),
          at: formatMs(o.outStartMs, { millis: false }),
          lengthMs: Math.round(o.srcOutMs - o.srcInMs),
          gainDb: o.gainDb,
          duckPoints: o.points?.length ?? 0,
        })),
      };
    },
  },
  {
    name: "place_overlay",
    description:
      "把媒體清單裡的某個檔案放到配樂（music）或音效（sfx）軌上。outStartMs 是**成品時間**。配樂預設 −18 dB 並帶 2 秒進出，音效預設 −6 dB。放完通常接著呼叫 duck_overlay。",
    inputSchema: {
      type: "object",
      properties: {
        mediaId: { type: "string", description: "從 list_media 取得" },
        lane: { type: "string", enum: ["music", "sfx"], default: "music" },
        outStartMs: { type: "number", default: 0 },
        srcInMs: { type: "number", default: 0 },
        srcOutMs: { type: "number", description: "省略＝用到來源結尾" },
        gainDb: { type: "number", minimum: -48, maximum: 12 },
      },
      required: ["mediaId"],
      additionalProperties: false,
    },
    handler: (a) => {
      const x = ctxMedia();
      const src = x.proj.media.find((m) => m.id === a.mediaId);
      if (!src?.probe) throw new ToolError("找不到那個媒體（先用 list_media）");
      if (src.id === x.media.id) throw new ToolError("不能把主聲軌自己疊在自己身上");
      const lane = a.lane === "sfx" ? "sfx" : "music";
      const preset = lane === "music" ? DEFAULT_MUSIC : DEFAULT_SFX;
      const srcInMs = Math.max(0, num(a.srcInMs, 0));
      const srcOutMs = Math.min(src.probe.duration_ms, num(a.srcOutMs, src.probe.duration_ms));
      if (srcOutMs - srcInMs < 100) throw new ToolError("片段太短（至少 100 ms）");
      const id = x.d.addOverlay(x.media.id, {
        lane,
        mediaId: src.id,
        srcInMs,
        srcOutMs,
        outStartMs: Math.max(0, num(a.outStartMs, 0)),
        ...preset,
        ...(typeof a.gainDb === "number" ? { gainDb: a.gainDb } : {}),
      });
      return { id, lane, source: src.name, lengthMs: Math.round(srcOutMs - srcInMs) };
    },
  },
  {
    name: "duck_overlay",
    description:
      "讓配樂在人聲底下自動閃避：依人聲區間算出音量控制點（人聲進來前壓下去、講完再回來）。這不是壓縮器，是看得見也拖得動的曲線。省略 id 就對所有 music 軌做。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "省略＝所有配樂" },
        depthDb: { type: "number", minimum: -40, maximum: 0, description: "壓多少（預設 −9）" },
        attackMs: { type: "number", minimum: 0, maximum: 3000 },
        releaseMs: { type: "number", minimum: 0, maximum: 5000 },
      },
      additionalProperties: false,
    },
    handler: (a) => {
      const x = ctxMedia();
      const edl = edlFor(x.media.id);
      if (!edl) throw new ToolError("還沒有 EDL（媒體尚未探測）");
      // 有逐字稿就用 VAD（準）；沒有就退回「保留段就是人聲」（粗，但不必先跑 ASR 才能閃避）
      const tr = useTranscript.getState().byMedia[x.media.id];
      const vad = tr?.vad.length ? tr.vad : edl.keeps.map((k) => ({ startMs: k.srcStartMs, endMs: k.srcEndMs }));
      const voice = voiceRegionsInOutput(vad, edl.keeps);
      const opts = {
        ...DEFAULT_DUCK,
        ...(typeof a.depthDb === "number" ? { depthDb: a.depthDb } : {}),
        ...(typeof a.attackMs === "number" ? { attackMs: a.attackMs } : {}),
        ...(typeof a.releaseMs === "number" ? { releaseMs: a.releaseMs } : {}),
      };
      const list = (x.d.overlays[x.media.id] ?? []).filter((o) => (a.id ? o.id === a.id : o.lane === "music"));
      if (!list.length) throw new ToolError(a.id ? "找不到那一段配樂" : "沒有配樂可以閃避（先用 place_overlay）");
      const done: { id: string; points: number }[] = [];
      for (const o of list) {
        const pts = planDuck(voice, o, opts);
        if (!pts.length) continue;
        x.d.updateOverlay(x.media.id, o.id, { points: pts }, "自動閃避");
        done.push({ id: o.id, points: pts.length });
      }
      if (!done.length) throw new ToolError("那些配樂底下沒有人聲，不需要閃避");
      return { ducked: done, depthDb: opts.depthDb };
    },
  },
  {
    name: "update_overlay",
    description: "調整一段配樂 / 音效：音量、位置、長度、淡入淡出。remove=true 就移除。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        gainDb: { type: "number", minimum: -48, maximum: 12 },
        outStartMs: { type: "number", minimum: 0 },
        srcInMs: { type: "number", minimum: 0 },
        srcOutMs: { type: "number", minimum: 0 },
        fadeInMs: { type: "number", minimum: 0, maximum: 20000 },
        fadeOutMs: { type: "number", minimum: 0, maximum: 20000 },
        remove: { type: "boolean" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: (a) => {
      const x = ctxMedia();
      const id = String(a.id);
      const cur = (x.d.overlays[x.media.id] ?? []).find((o) => o.id === id);
      if (!cur) throw new ToolError("找不到那一段配樂（先用 list_overlays）");
      if (a.remove === true) {
        x.d.removeOverlay(x.media.id, id);
        return { removed: id };
      }
      const patch: Record<string, number> = {};
      for (const k of ["gainDb", "outStartMs", "srcInMs", "srcOutMs", "fadeInMs", "fadeOutMs"] as const) {
        if (typeof a[k] === "number") patch[k] = a[k] as number;
      }
      if (!Object.keys(patch).length) throw new ToolError("沒有任何要改的欄位");
      x.d.updateOverlay(x.media.id, id, patch, "調整配樂");
      return { updated: id, patch };
    },
  },
  {
    name: "get_preflight",
    description:
      "交付前檢查：這一集現在輸出的話，有什麼會出問題、有什麼只是提醒。回答「可以輸出了嗎 / 還缺什麼」用這支，不要自己憑候選數量推測。blocker 是會產出壞檔案的（例如整集被剪光），warning 是多半該處理的，note 只是提醒。有 blocker 時**不要**直接叫使用者輸出。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      const m = ctxMedia();
      const edl = edlFor(m.media.id);
      const decisions = m.d.decisions[m.media.id] ?? {};
      const candidates = m.d.candidates[m.media.id] ?? [];
      const markers = m.d.markers[m.media.id] ?? [];
      const overlays = m.d.overlays[m.media.id] ?? [];
      const hasTranscript = !!useTranscript.getState().byMedia[m.media.id];
      const qc = qcFor(m.media.id);
      const findings = preflight({
        pending: candidates.reduce((n, c) => n + ((decisions[c.id]?.state ?? "pending") === "pending" ? 1 : 0), 0),
        conflicts: candidates.reduce((n, c) => n + (decisions[c.id]?.conflict ? 1 : 0), 0),
        openTodos: markers.reduce((n, x) => n + (x.kind === "todo" && !x.done ? 1 : 0), 0),
        chapters: markers.reduce((n, x) => n + (x.kind === "chapter" ? 1 : 0), 0),
        srcMs: edl ? edl.stats.keptMs + edl.stats.removedMs : (m.media.probe?.duration_ms ?? 0),
        outMs: edl ? edl.stats.outMs : 0,
        overlays: overlays.length,
        musicWithoutDuck: overlays.filter((o) => o.lane === "music" && !(o.points?.length ?? 0)).length,
        stems: false,
        hasTranscript,
        qc: qc?.summary,
        qcAt: qc?.at,
      });
      return {
        ready: !hasBlocker(findings),
        counts: summarize(findings),
        findings: findings.map((f) => ({ severity: f.severity, title: f.title, detail: f.detail, action: f.action, atMs: f.atMs })),
        // null = **沒檢查**（這一集還沒做本機分析），不是「檢查過很乾淨」
        audioQc: qc ? { ...qc.summary, spots: qc.findings.map((f) => ({ kind: f.kind, atMs: f.startMs, value: f.value })) } : null,
      };
    },
  },
  {
    name: "list_takes",
    description:
      "找出**同一句話講了好幾次**的地方（Final Cut 的 Audition）。一個人錄音講壞了最常見的反應不是說「重講」，而是停半秒直接再講一次 —— 錄完一集下來同一句有兩三個版本。回每一組的各次嘗試、時間、原文，以及留一個能省多少。**只找不剪**：要剪要用 keep_take，而且剪的是一整句真正的內容，判斷錯的代價很高，先讓使用者聽過。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      const m = ctxMedia();
      const groups = takesFor(m.media.id);
      return {
        groups: groups.map((g) => ({
          id: g.id,
          defaultKeep: g.defaultKeep,
          savedMsIfDefault: savedMsOf(g, g.defaultKeep),
          attempts: g.attempts.map((a) => ({ index: a.index, atMs: a.startMs, endMs: a.endMs, text: a.text })),
        })),
        hint: groups.length ? "預設建議留最後一次（會再講一遍就是因為前面不滿意）。" : undefined,
      };
    },
  },
  {
    name: "keep_take",
    description:
      "在一組替代 take 裡留下某一次，其餘剪掉（一次 undo 就能全還原）。groupId 來自 list_takes。keepIndex 是第幾次嘗試（0 起算）。索引超出範圍時**什麼都不做**，不會把整組剪光。",
    inputSchema: {
      type: "object",
      properties: {
        groupId: { type: "string", description: "list_takes 回的那個 id。" },
        keepIndex: { type: "integer", minimum: 0, description: "要留第幾次（0 起算）；不給就用 defaultKeep（最後一次）。" },
      },
      required: ["groupId"],
      additionalProperties: false,
    },
    handler: (a) => {
      const m = ctxMedia();
      const groupId = String(a?.groupId ?? "");
      const group = takesFor(m.media.id).find((g) => g.id === groupId);
      if (!group) return { error: "找不到這一組 take（先用 list_takes）" };
      const keep = a?.keepIndex == null ? group.defaultKeep : Math.round(Number(a.keepIndex));
      const r = keepTake(m.media.id, groupId, keep);
      if (!r.cut) return { cut: 0, error: "keepIndex 超出範圍，沒有動任何東西" };
      return { ...r, kept: group.attempts[keep]?.text };
    },
  },
  {
    name: "suggest_filler_rules",
    description:
      "依**使用者親手做過的判斷**（不是規則層、也不是 AI 的決定）建議贅字詞表要怎麼設。回「這個詞你最近幾集剪了幾次、留了幾次、建議設成什麼」。要回答「我這個節目該把哪些詞設進詞表」用這支。證據不夠或意見不一面倒的詞不會出現 —— 那些本來就該看語境。這支**不會改任何設定**。",
    inputSchema: {
      type: "object",
      properties: {
        minObservations: { type: "integer", minimum: 1, maximum: 100, description: "至少看過幾筆才建議（預設 5）。" },
      },
      additionalProperties: false,
    },
    handler: (a) => {
      const st = useSettings.getState().s;
      const obs = parseObservations(st.filler_observations);
      const opts = { minObservations: Math.round(Number(a?.minObservations) || 5), minAgreement: 0.9, keepEpisodes: 20 };
      const list = suggestRules(totalsOf(obs), st.filler_rules ?? {}, opts);
      return {
        episodesLearned: obs.length,
        suggestions: list.map((x) => ({
          word: x.text,
          suggest: x.mode,
          current: x.current,
          cut: x.cut,
          kept: x.kept,
          episodes: x.episodes,
          why: x.kind === "change" ? "跟目前的設定相反" : x.builtin ? "內建詞表會剪，但你都留著" : "你一直這樣做",
        })),
        hint: obs.length ? undefined : "還沒有學過任何一集 —— 先用 learn_filler_decisions 把這一集記起來。",
      };
    },
  },
  {
    name: "learn_filler_decisions",
    description:
      "把**這一集**使用者親手做過的贅字裁決記下來，之後 suggest_filler_rules 才有依據。同一集重複呼叫是覆蓋不是累加。只記「接受 / 拒絕」而且來源是使用者的那幾筆；自動剪的與 AI 決定的不算。這支不改詞表、也不改任何剪輯決策。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const m = ctxMedia();
      const tr = useTranscript.getState().byMedia[m.media.id];
      if (!tr) return { error: "還沒有逐字稿" };
      const obs = observeEpisode(m.d.candidates[m.media.id] ?? [], m.d.decisions[m.media.id] ?? {}, tr.words, {
        episode: m.media.id,
        name: m.media.name,
      });
      if (!hasSignal(obs)) return { learned: 0, hint: "這一集還沒有使用者親手做過的贅字裁決" };
      const settings = useSettings.getState();
      const next = putObservation(parseObservations(settings.s.filler_observations), obs);
      await settings.save({ filler_observations: serializeObservations(next) });
      const words = Object.entries(obs.words).map(([norm, [cut, kept]]) => ({ word: obs.texts[norm] ?? norm, cut, kept }));
      return { learned: words.reduce((n, w) => n + w.cut + w.kept, 0), words, episodesLearned: next.length };
    },
  },
  {
    name: "get_loudness_profile",
    description:
      "**你聽不到聲音，這支讓你看得到。** 回這一集的響度輪廓（一條粗略的曲線）、最安靜與最大聲的幾段、底噪與人聲水準。用來回答「哪裡特別小聲」「這集吵不吵」「要不要修聲」這種光看逐字稿答不出來的問題。數字是**來源**的響度，不是成品 —— 輸出時的逐段平衡與響度正規化還會再動一次。",
    inputSchema: {
      type: "object",
      properties: {
        bucketSec: { type: "integer", minimum: 5, maximum: 600, description: "每一格多少秒（預設 30）。節目太長時會自動加寬，回傳的 bucketMs 才是實際用的。" },
      },
      additionalProperties: false,
    },
    handler: (a) => {
      const m = ctxMedia();
      const local = useTranscript.getState().local[m.media.id];
      const p = loudnessProfile(local, Math.round(num(a.bucketSec, 30) * 1000));
      if (!p) throw new ToolError("這個音檔還沒有本機波形分析（請先按「分析」）");
      const view = (b: { startMs: number; endMs: number; lufs: number }) => ({
        at: formatMs(b.startMs, { millis: false }),
        startMs: Math.round(b.startMs),
        endMs: Math.round(b.endMs),
        lufs: Number(b.lufs.toFixed(1)),
        vsEpisodeLu: vsEpisode(p, b) == null ? null : Number(vsEpisode(p, b)!.toFixed(1)),
      });
      return {
        durationMs: Math.round(p.durationMs),
        bucketMs: p.bucketMs,
        episodeLufs: Number(p.episodeLufs.toFixed(1)),
        // 一條粗略的曲線：只給數字，位置用索引 × bucketMs 推得出來
        curveLufs: p.buckets.map((b) => Number(b.lufs.toFixed(1))),
        quietest: p.quietest.map(view),
        loudest: p.loudest.map(view),
        noiseFloorDb: p.gate ? Number(p.gate.noiseFloorDb.toFixed(1)) : null,
        speechDb: p.gate ? Number(p.gate.speechDb.toFixed(1)) : null,
        speechToNoiseLu: p.gate ? Number(p.gate.marginDb.toFixed(1)) : null,
        // 差距小於 12 dB 的話修聲會傷到內容（見 analysis/gate.ts）
        note: p.gate && p.gate.marginDb < 12 ? "人聲與底噪只差不到 12 dB，這一集本來就偏吵；硬做降噪會傷到內容" : undefined,
      };
    },
  },
  {
    name: "list_speakers",
    description:
      "這一集有哪些講者、各講了多久、佔比、以及每個人的**來源**響度與落差。沒有講者標籤時回空陣列（一人一軌的素材用 sync_mics 合併時會自動指派；單軌只能用 assign_speaker 手動標）。佔比算的是「佔有人在講的時間」，不是佔整集長度。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      const m = ctxMedia();
      const st = m.d.speakers[m.media.id];
      if (!st?.list.length) return { speakers: [], note: "這一集還沒有講者標籤" };
      const local = useTranscript.getState().local[m.media.id];
      const levels = speakerLevels(local, st.turns, st.list);
      const stats = speakerStats(st.turns, st.list);
      const spread = levelSpread(levels);
      return {
        speakers: stats.map((x) => {
          const sp = st.list.find((y) => y.id === x.speakerId);
          const lv = levels.find((y) => y.speakerId === x.speakerId);
          return {
            id: x.speakerId,
            label: sp?.label ?? x.speakerId,
            ms: Math.round(x.ms),
            at: formatMs(x.ms, { millis: false }),
            share: Number(x.share.toFixed(3)),
            turns: x.turns,
            longestMs: Math.round(x.longestMs),
            sourceLufs: lv?.lufs == null ? null : Number(lv.lufs.toFixed(1)),
          };
        }),
        spreadDb: spread == null ? null : Number(spread.toFixed(1)),
        spreadVerdict: spreadVerdict(spread),
        note: spreadVerdict(spread) === "bad" ? "落差超過 6 dB，這不是後製能好好補救的：把小聲的那位拉起來，底噪與房間聲會一起拉起來" : undefined,
      };
    },
  },
  {
    name: "assign_speaker",
    description:
      "把一段時間指派給某個講者（來源時間）。`speaker` 給的是名字，找不到就新增一個。`speaker` 給 null 代表清掉這段的講者。單軌素材唯一能標講者的方式，也是自動指派標錯時的補救。一次 undo 可還原。",
    inputSchema: {
      type: "object",
      properties: {
        startMs: { type: "integer", minimum: 0 },
        endMs: { type: "integer", minimum: 0 },
        speaker: { type: ["string", "null"], description: "講者名字；找不到就新增。null = 清掉這段" },
      },
      required: ["startMs", "endMs"],
      additionalProperties: false,
    },
    handler: (a) => {
      const m = ctxMedia();
      const startMs = num(a.startMs, 0);
      const endMs = num(a.endMs, 0);
      if (endMs <= startMs) throw new ToolError("endMs 必須大於 startMs");
      const label = typeof a.speaker === "string" ? a.speaker.trim() : null;
      let id: string | null = null;
      if (label) {
        const cur = m.d.speakers[m.media.id]?.list ?? [];
        const same = cur.filter((x) => x.label === label);
        if (same.length > 1) throw new ToolError(`有 ${same.length} 位講者都叫「${label}」，分不出要指派給誰 —— 先用 rename_speaker 改掉其中一位。`);
        id = same[0] ? same[0].id : m.d.addSpeaker(m.media.id, label);
      }
      m.d.assignSpeaker(m.media.id, startMs, endMs, id, label ? `AI：${label} ${formatMs(startMs, { millis: false })}` : "AI：清除講者");
      const st = useDecisions.getState().speakers[m.media.id];
      return {
        assigned: label ?? null,
        speakerId: id,
        startMs,
        endMs,
        speakers: st?.list.map((x) => x.label) ?? [],
        turns: st?.turns.length ?? 0,
      };
    },
  },
  {
    name: "rename_speaker",
    description: "把講者改名（自動指派時預設用檔名，例如 mark_20260907.wav → mark）。重跑自動指派不會把改好的名字打回去。",
    inputSchema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
      additionalProperties: false,
    },
    handler: (a) => {
      const m = ctxMedia();
      const from = typeof a.from === "string" ? a.from.trim() : "";
      const to = typeof a.to === "string" ? a.to.trim() : "";
      if (!to) throw new ToolError("新名字不能是空的");
      const cur: Speaker[] = m.d.speakers[m.media.id]?.list ?? [];
      const sp = cur.find((x) => x.label === from || x.id === from);
      if (!sp) throw new ToolError(`找不到講者「${from}」（目前有：${cur.map((x) => x.label).join("、") || "無"}）`);
      // 名字是查表的鍵（assign_speaker / cut_fillers_by_speaker 都用名字找人）——
      // 兩個人同名的話，之後的每一次查找都會靜靜地選到第一個那位
      if (cur.some((x) => x.id !== sp.id && x.label === to)) {
        throw new ToolError(`已經有一位講者叫「${to}」了。名字要能分辨得出來，換一個或先改掉那一位。`);
      }
      m.d.renameSpeaker(m.media.id, sp.id, to);
      return { from: sp.label, to, speakers: (useDecisions.getState().speakers[m.media.id]?.list ?? []).map((x) => x.label) };
    },
  },
  {
    name: "cut_fillers_by_speaker",
    description:
      "只剪某一個講者的贅字，其他人的留著。「來賓的口頭禪剪掉、主持人的留著」用這個 —— 主持人的「對」多半是在給回饋，整群剪掉會讓對話聽起來很冷淡。不給 speaker 就是全部人。可以用 words 限定只剪哪幾個詞。先用 list_speakers 確認名字。判不出是誰講的（兩個人同時講）會被排除，不會誤剪。回傳的 matched 是符合的總筆數、changed 才是這次真正改動的筆數（其餘本來就已經是剪掉的狀態）。",
    inputSchema: {
      type: "object",
      properties: {
        speaker: { type: "string", description: "講者名字；不給就是全部人" },
        words: { type: "array", items: { type: "string" }, description: "只剪這幾個詞；不給就是全部贅字" },
        dryRun: { type: "boolean", description: "true = 只回報會剪掉什麼，不真的剪" },
      },
      additionalProperties: false,
    },
    handler: (a) => {
      const x = ctx();
      const st = x.d.speakers[x.media.id];
      let only: string | null = null;
      if (typeof a.speaker === "string" && a.speaker.trim()) {
        const sp = (st?.list ?? []).find((y) => y.label === a.speaker || y.id === a.speaker);
        if (!sp) throw new ToolError(`找不到講者「${a.speaker}」（目前有：${(st?.list ?? []).map((y) => y.label).join("、") || "無"}）`);
        only = sp.id;
      }
      const groups = groupFillers(x.cands, x.dec, x.tr.words, { turns: st?.turns, only });
      const want = Array.isArray(a.words) && a.words.length ? new Set((a.words as unknown[]).map((w) => String(w))) : null;
      const picked = want ? groups.filter((g) => want.has(g.text) || want.has(g.norm)) : groups;
      const ids = picked.flatMap((g) => g.ids);
      const view = picked.map((g) => ({ word: g.text, count: g.count, alreadyCut: g.cut, savesMs: Math.round(g.totalMs) }));
      if (!ids.length) return { speaker: a.speaker ?? null, words: view, matched: 0, changed: 0, note: "沒有符合的贅字候選" };
      if (a.dryRun === true) {
        const wouldChange = ids.filter((id) => !isActiveState(x.dec[id]?.state)).length;
        return { speaker: a.speaker ?? null, words: view, matched: ids.length, wouldChange, dryRun: true };
      }
      // 已經是剪掉狀態的不算「這次剪的」—— 回報 ids.length 會讓模型以為省下了整批的時間，
      // 但其中大部分本來就剪掉了（自動判定），實際多省的只有差額
      const changed = ids.filter((id) => !isActiveState(x.dec[id]?.state)).length;
      const savedMs = picked.reduce((s, g) => s + (g.totalMs - g.cutMs), 0);
      x.d.decide(x.media.id, ids, "accepted", { origin: "user", label: `AI：剪掉${a.speaker ? `「${String(a.speaker)}」的` : ""}贅字 ×${ids.length}` });
      return {
        speaker: a.speaker ?? null,
        words: view,
        matched: ids.length,
        changed,
        savedMs: Math.round(savedMs),
        note: changed === 0 ? "這些贅字先前就已經是剪掉的狀態，這次沒有變動" : undefined,
      };
    },
  },
  {
    name: "export_captions",
    description:
      "產字幕 / 逐字稿。時間戳是**成品**時間（被剪掉的字整個不出現，後面的往前挪），所以字幕不會愈到後面愈飄。format: srt / vtt / md / txt。給 path 就寫檔，不給就把內容回傳（太長會截斷）。有講者標籤時 withSpeaker 可以把名字寫進去。",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["srt", "vtt", "md", "txt"] },
        path: { type: "string", description: "輸出檔路徑；不給就回傳內容" },
        withSpeaker: { type: "boolean" },
      },
      additionalProperties: false,
    },
    handler: async (a) => {
      const x = ctx();
      const edl = edlFor(x.media.id);
      if (!edl) throw new ToolError("還沒有 EDL（請先分析）");
      const st = x.d.speakers[x.media.id];
      const speakerOf = st?.turns.length ? assignWords(x.tr.words, st.turns) : undefined;
      const cues = buildCues({ words: x.tr.words, sentences: x.tr.sentences, keeps: edl.keeps, speakerOf });
      const format = (typeof a.format === "string" ? a.format : "srt") as CaptionFormat;
      const labelOf = (id: string) => st?.list.find((y) => y.id === id)?.label ?? id;
      const text = renderCaptions(cues, format, { speakerPrefix: a.withSpeaker === true && !!st?.list.length, labelOf });
      if (typeof a.path === "string" && a.path.trim()) {
        await api.writeTextFile(a.path.trim(), text);
        return { format, path: a.path.trim(), cues: cues.length, bytes: text.length };
      }
      const CAP = 12_000;
      return {
        format,
        ext: CAPTION_EXT[format],
        cues: cues.length,
        truncated: text.length > CAP,
        text: text.slice(0, CAP),
      };
    },
  },
  {
    name: "list_split_parts",
    description:
      "如果依章節分割輸出，會切成哪幾段、每段成品多長、檔名叫什麼（只是預覽，不會真的輸出）。沒有章節標記時回空陣列 —— 可以先用 set_chapters 標好。第一個章節不在 0 秒時會自動補一段開頭。",
    inputSchema: {
      type: "object",
      properties: { format: { type: "string", enum: [...RENDER_FORMATS] } },
      additionalProperties: false,
    },
    handler: (a) => {
      const m = ctxMedia();
      const ext = typeof a.format === "string" ? a.format : "mp3";
      const parts = splitByChapters(m.d.markers[m.media.id] ?? [], edlFor(m.media.id), {
        baseName: (m.media.name ?? "output").replace(/\.[^.]+$/, ""),
        ext,
        durationMs: m.media.probe?.duration_ms ?? 0,
        leadTitle: "開場",
      });
      return {
        parts: parts.map((p) => ({ index: p.index, title: p.title, startMs: Math.round(p.startMs), endMs: Math.round(p.endMs), outMs: Math.round(p.outMs), fileName: p.fileName })),
        totalOutMs: Math.round(totalOutMs(parts)),
        note: parts.length ? undefined : "這一集沒有章節標記，無法分割",
      };
    },
  },
  {
    name: "sync_mics",
    description:
      "多麥克風同步：用兩軌都聽得到的講話節奏（能量包絡）算出各軌的時間位移。預設只回報結果不動檔案；combine=true 才會併成一軌並開起來。信心低於 0.3 表示大概沒對上，這時要請使用者自己聽一下，不要硬合併。",
    inputSchema: {
      type: "object",
      properties: {
        mediaIds: { type: "array", items: { type: "string" }, minItems: 2, description: "第一個是基準軌；從 list_media 取得" },
        combine: { type: "boolean", default: false },
      },
      required: ["mediaIds"],
      additionalProperties: false,
    },
    handler: async (a) => {
      ctxMedia();
      const ids = Array.isArray(a.mediaIds) ? a.mediaIds.map(String) : [];
      if (ids.length < 2) throw new ToolError("至少要兩軌");
      const rows = await analyzeMicSync(ids);
      const weak = rows.filter((r) => r.offsetMs !== 0 && r.confidence < 0.3);
      const report = rows.map((r) => ({ name: r.name, offsetMs: r.offsetMs, delayMs: r.delayMs, confidence: Math.round(r.confidence * 100) / 100 }));
      if (a.combine !== true) return { rows: report, lowConfidence: weak.map((r) => r.name), combined: false };
      if (weak.length) throw new ToolError(`這些軌的信心太低，先讓使用者確認：${weak.map((r) => r.name).join("、")}`);
      const outPath = await combineMics(rows);
      return { rows: report, combined: true, outPath };
    },
  },
  {
    name: "set_selection",
    description: "設定時間選取（等同使用者在波形上拖一段）。設好之後可以用 lift_selection 提起，或叫使用者確認。傳 null 清除選取。",
    inputSchema: {
      type: "object",
      properties: {
        startMs: { type: "number" },
        endMs: { type: "number" },
        clear: { type: "boolean", description: "true = 清除選取" },
      },
      additionalProperties: false,
    },
    handler: (a) => {
      ctxMedia();
      if (a.clear === true) {
        useTimeline.getState().setSelection(null);
        return { cleared: true };
      }
      const s = num(a.startMs, -1);
      const e = num(a.endMs, -1);
      if (s < 0 || e <= s) throw new ToolError("startMs / endMs 不合法");
      useTimeline.getState().setSelection({ startMs: s, endMs: e });
      const sel = useTimeline.getState().selection;
      // 沒選起來就要明講。回一個 `selection: null` 看起來像成功，助手會照著往下走，
      // 然後在 lift_selection 那裡撞牆，而且不知道是哪一步出的錯。
      if (!sel) throw new ToolError("這段沒有被接受（太短？最短 20 毫秒），選取沒有建立");
      return { selection: sel, note: Math.abs(sel.startMs - s) > 1 || Math.abs(sel.endMs - e) > 1 ? "已吸附到最近的接縫 / 句界 / 拍點" : undefined };
    },
  },
  {
    name: "lift_selection",
    description: "提起（lift）：把目前選取換成靜音，但**不關洞** —— 後面的時間位置完全不動。拿掉咳嗽 / 關門聲又要保留節奏時用這個，不要用 add_cut。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      ctxMedia();
      const id = liftSelection();
      if (!id) throw new ToolError("目前沒有選取 —— 先用 set_selection，並且就在下一步呼叫 lift_selection");
      return { lifted: id };
    },
  },
  {
    name: "add_effect",
    description: "對目前選取加效果：靜音 / 增益（dB）/ 淡入 / 淡出（可選曲線）/ 反相。先用 set_selection 選好範圍。峰值正規化與響度對齊請用 normalize_selection。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["mute", "gain", "fade_in", "fade_out", "invert"] },
        db: { type: "number", minimum: -24, maximum: 12, description: "kind=gain 時的增益" },
        shape: { type: "string", enum: ["linear", "equal_power", "exponential"], description: "kind=fade_in / fade_out 的曲線（預設 linear）" },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    handler: (a) => {
      ctxMedia();
      const kind = String(a.kind) as EffectKind;
      const shape = a.shape === "equal_power" || a.shape === "exponential" ? a.shape : undefined;
      const id = addEffectOnSelection(kind, kind === "gain" ? num(a.db, 0) : undefined, shape);
      if (!id) throw new ToolError("目前沒有選取（先用 set_selection）");
      return { effectId: id, kind };
    },
  },
  {
    name: "normalize_selection",
    description: "把目前選取的音量拉齊：mode=peak 把最大聲拉到 −1 dBFS（峰值正規化）；mode=episode 把這段的響度對齊到整集平均。結果是一個增益效果，可 undo。回傳 confidence：measured / heuristic（太小聲、分析解析度不夠）。",
    inputSchema: {
      type: "object",
      properties: { mode: { type: "string", enum: ["peak", "episode"] } },
      required: ["mode"],
      additionalProperties: false,
    },
    handler: (a) => {
      const { media, d } = ctxMedia();
      const sel = useTimeline.getState().selection;
      if (!sel) throw new ToolError("目前沒有選取（先用 set_selection）");
      const local = useTranscript.getState().local[media.id] ?? null;
      const s = a.mode === "peak" ? peakNormalizeGainDb(local, sel.startMs, sel.endMs, -1) : matchLoudnessGainDb(local, sel.startMs, sel.endMs, "episode");
      if (!s) throw new ToolError("還沒有波形分析，量不到音量");
      const db = Math.round(s.db * 10) / 10;
      const id = fxEffectId("gain", sel.startMs, sel.endMs, db);
      d.addEffects(media.id, [{ id, kind: "gain", startMs: sel.startMs, endMs: sel.endMs, db, origin: a.mode === "peak" ? "peak_normalize" : "match_loudness" }], a.mode === "peak" ? "峰值正規化" : "響度對齊");
      return { effectId: id, gainDb: db, summary: s.summary, confidence: s.confidence };
    },
  },
  {
    name: "list_effects",
    description: "列出所有效果 / 修復（EffectSpec）：id、名稱、參數（範圍 / 預設）、預設組合、作用範圍、有沒有建議值。要套用請用 apply_effect。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () =>
      allEffectSpecs().map((s) => ({
        id: s.id,
        title: s.title,
        group: s.group,
        scope: s.scope,
        params: s.params.map((p) => ({ id: p.id, kind: p.kind, min: p.min, max: p.max, step: p.step, default: p.default, options: p.options?.map((o) => o.value), advanced: !!p.advanced })),
        presets: s.presets.map((p) => ({ id: p.id, values: p.values })),
        hasSuggest: !!s.suggest,
      })),
  },
  {
    name: "apply_effect",
    description:
      "套用一個效果 / 修復（specId 見 list_effects，例如 repair.denoise、effect.normalize、repair.declick）到目前選取（scope=selection 要先 set_selection）。values 省略的參數用建議值 / 預設；範圍濾波（repair.*）是輸出時才套，即時播放聽不到。可 undo。",
    inputSchema: {
      type: "object",
      properties: {
        specId: { type: "string" },
        values: { type: "object", additionalProperties: { type: ["number", "string", "boolean"] } },
      },
      required: ["specId"],
      additionalProperties: false,
    },
    handler: async (a) => {
      const { media } = ctxMedia();
      const spec = effectSpec(String(a.specId));
      if (!spec) throw new ToolError(`沒有這個效果：${String(a.specId)}（用 list_effects 看有哪些）`);
      const ctx = effectContext(media.id);
      const range = rangeFor(spec, ctx);
      if (!range) throw new ToolError("這個效果要先選一段（set_selection）");
      // 同步的 suggest 沒有就跑非同步的 analyze（去嗡聲要真的量頻譜）—— 跟對話框走同一條路，不用預設值硬套
      const sug = spec.suggest?.(ctx, range) ?? (spec.analyze ? await spec.analyze(ctx, range) : null);
      const raw = (a.values && typeof a.values === "object" ? (a.values as Record<string, ParamValue>) : {}) as Partial<Record<string, ParamValue>>;
      const overrides: Partial<Record<string, ParamValue>> = {};
      for (const [k, v] of Object.entries(raw)) {
        const p = spec.params.find((x) => x.id === k);
        if (!p) throw new ToolError(`${spec.id} 沒有參數 ${k}（有：${spec.params.map((x) => x.id).join(", ") || "無"}）`);
        if (p.kind === "select") {
          // select 的值是字串（"50" / "60"）；數字進來就轉成字串，不在選項裡就報錯而不是默默用預設
          const sv = String(v);
          if (!p.options?.some((o) => o.value === sv)) throw new ToolError(`${k} 只能是 ${p.options?.map((o) => o.value).join(" / ")}`);
          overrides[k] = sv;
        } else overrides[k] = v;
      }
      const values = resolveValues(spec, null, { ...(sug?.values ?? {}), ...overrides });
      const err = spec.validate?.(values, ctx);
      if (err) throw new ToolError(err);
      const app = spec.build(values, range, ctx);
      await applyEffect(app, media.id);
      return {
        label: app.label,
        values,
        range,
        suggestion: sug ? { summary: sug.summary, confidence: sug.confidence } : null,
        effects: app.kind === "effects" ? app.effects.map((e) => ({ id: e.id, kind: e.kind, startMs: e.startMs, endMs: e.endMs, params: e.params ?? null })) : [],
        appliedAt: app.kind === "effects" ? "輸出時（範圍濾波）或即時（增益類）" : app.kind,
      };
    },
  },
  {
    name: "align_tracks",
    description:
      "把一軌（dub）在時間上扭到另一軌（guide）對齊（VocALign 式 DTW，只做時間不做音高）。mode：adr 補錄一句對回原位 / drift 多麥時鐘漂移 / music 疊錄。render=true 會輸出 <dub>_aligned.wav 加進媒體清單並回驗收；信心 < 0.3 時拒絕渲染並說明。",
    inputSchema: {
      type: "object",
      properties: {
        guideId: { type: "string" },
        dubId: { type: "string" },
        mode: { type: "string", enum: ["adr", "drift", "music"] },
        tightness: { type: "number", minimum: 0, maximum: 100 },
        render: { type: "boolean" },
      },
      required: ["guideId", "dubId"],
      additionalProperties: false,
    },
    handler: async (a) => {
      const mode = (a.mode === "drift" || a.mode === "music" ? a.mode : "adr") as AlignMode;
      const r = await analyzeAlignment(String(a.guideId), String(a.dubId), { mode, tightness: typeof a.tightness === "number" ? a.tightness : undefined });
      const base = {
        offsetMs: Math.round(r.offsetMs),
        maxDeviationMs: Math.round(r.summary.maxDeviationMs),
        driftSecPerHour: Math.round((r.summary.slope - 1) * 3600 * 100) / 100,
        segments: r.segments.length,
        resampleOnly: r.resampleRatio != null,
        confidence: Math.round(r.confidence * 100) / 100,
      };
      if (!a.render) return base;
      if (r.confidence < ALIGN_LOW_CONFIDENCE) throw new ToolError(`信心只有 ${Math.round(r.confidence * 100)}%（< 30%），可能沒對上，不輸出。把 guide / dub 換成同一段內容再試。`);
      const out = await renderAlignment(r);
      return { ...base, outPath: out.outPath, mediaId: out.mediaId, verdict: out.verdict };
    },
  },
  {
    name: "set_noise_print",
    description: "把目前選取當噪音樣本（選一段沒人講話的純底噪，0.3–5 秒）。之後降噪的底噪值都以它為準。太短 / 太長 / 有講話會拒絕並說原因。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      const { media } = ctxMedia();
      const sel = useTimeline.getState().selection;
      if (!sel) throw new ToolError("目前沒有選取（先用 set_selection）");
      const r = makeNoisePrint(useTranscript.getState().local[media.id] ?? null, sel.startMs, sel.endMs);
      if ("error" in r) throw new ToolError(r.error);
      useCleanup.getState().setNoisePrint(media.id, r.print);
      return r.print;
    },
  },
];

export function toolDefs(): McpToolDef[] {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

/** 上一個還活著的監聽。多裝一次就把舊的拆掉 —— 同一個事件被聽兩次 = 每個工具跑兩次。 */
let activeBridge: (() => void) | null = null;

/** 登記工具並開始接工具呼叫事件；回 unlisten。 */
export async function installToolBridge(): Promise<() => void> {
  // 就算呼叫端漏了 cleanup（StrictMode 的非同步競態最容易漏），這裡也只會留下一個監聽
  activeBridge?.();
  activeBridge = null;
  try {
    await api.mcpSetTools(toolDefs());
  } catch {
    /* 非 Tauri 環境 */
  }
  const un = await listen<McpToolCall>("mcp-tool-call", async (ev) => {
    const { id, name, args } = ev.payload;
    const spec = TOOLS.find((t) => t.name === name);
    try {
      if (!spec) throw new ToolError(`未知工具 ${name}`);
      const result = await spec.handler((args && typeof args === "object" ? args : {}) as Record<string, unknown>);
      await api.mcpToolResult(id, result ?? { ok: true }, null);
    } catch (e) {
      await api.mcpToolResult(id, null, e instanceof Error ? e.message : String(e)).catch(() => {});
    }
  });
  activeBridge = () => {
    activeBridge = null;
    un();
  };
  return activeBridge;
}
