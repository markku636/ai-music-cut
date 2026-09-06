// AI 助手的工具目錄（MCP tools）：名稱 / JSON schema / handler。
// Rust 端只當 JSON-RPC 轉發器：claude 呼叫 → `mcp-tool-call` 事件 → 這裡執行 → `mcp_tool_result` 回寫。
import { listen } from "@tauri-apps/api/event";
import { api, type McpToolCall, type McpToolDef } from "../api";
import { KIND_LABEL, isActiveState, type Candidate, type CandidateKind, type DecisionState, type MarkerKind } from "../analysis/types";
import { buildChapters } from "../analysis/chapters";
import { fillerCandidates, findText, totalMs } from "../analysis/textSearch";
import { DEFAULT_DUCK, DEFAULT_MUSIC, DEFAULT_SFX, planDuck, voiceRegionsInOutput } from "../analysis/overlays";
import { analyzeMicSync, combineMics } from "../pipeline/syncMics";
import type { EffectKind } from "../analysis/effects";
import { edlFor, runRulesFor } from "../pipeline/rules";
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
      return { query: q, cut: picked.length, added, removedMs: Math.round(totalMs(picked)) };
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
    description: "復原上一筆決策變更。",
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
    description: "重做上一筆被復原的變更。",
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
          removedMs: Math.round(s.srcAfterMs - s.srcBeforeMs),
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
      return { selection: sel, note: sel && (Math.abs(sel.startMs - s) > 1 || Math.abs(sel.endMs - e) > 1) ? "已吸附到最近的接縫 / 句界 / 拍點" : undefined };
    },
  },
  {
    name: "lift_selection",
    description: "提起（lift）：把目前選取換成靜音，但**不關洞** —— 後面的時間位置完全不動。拿掉咳嗽 / 關門聲又要保留節奏時用這個，不要用 add_cut。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      ctxMedia();
      const id = liftSelection();
      if (!id) throw new ToolError("目前沒有選取（先用 set_selection）");
      return { lifted: id };
    },
  },
  {
    name: "add_effect",
    description: "對目前選取加效果：靜音 / 增益（dB）/ 淡入 / 淡出。先用 set_selection 選好範圍。",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["mute", "gain", "fade_in", "fade_out"] },
        db: { type: "number", minimum: -24, maximum: 12, description: "kind=gain 時的增益" },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    handler: (a) => {
      ctxMedia();
      const kind = String(a.kind) as EffectKind;
      const id = addEffectOnSelection(kind, kind === "gain" ? num(a.db, 0) : undefined);
      if (!id) throw new ToolError("目前沒有選取（先用 set_selection）");
      return { effectId: id, kind };
    },
  },
];

export function toolDefs(): McpToolDef[] {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

/** 登記工具並開始接工具呼叫事件；回 unlisten。 */
export async function installToolBridge(): Promise<() => void> {
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
  return un;
}
