// AI 助手的工具目錄（MCP tools）：名稱 / JSON schema / handler。
// Rust 端只當 JSON-RPC 轉發器：claude 呼叫 → `mcp-tool-call` 事件 → 這裡執行 → `mcp_tool_result` 回寫。
import { listen } from "@tauri-apps/api/event";
import { api, type McpToolCall, type McpToolDef } from "../api";
import { KIND_LABEL, isActiveState, type Candidate, type CandidateKind, type DecisionState } from "../analysis/types";
import { edlFor, runRulesFor } from "../pipeline/rules";
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

function ctx() {
  const proj = useProject.getState();
  const media = selectActiveMedia(proj);
  if (!media) throw new ToolError("目前沒有開啟的音檔");
  const tr = useTranscript.getState().byMedia[media.id];
  if (!tr) throw new ToolError(`「${media.name}」尚未分析（請先按「分析」）`);
  const d = useDecisions.getState();
  return { proj, media, tr, cands: d.candidates[media.id] ?? [], dec: d.decisions[media.id] ?? {}, d };
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
    description: "目前開啟音檔的總覽：長度、逐字稿字數、候選各狀態/類型數量、目前會剪掉幾秒、激進度。任何操作前先呼叫。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => {
      const x = ctx();
      const counts = decisionCounts(x.cands, x.dec);
      const edl = edlFor(x.media.id);
      return {
        media: { id: x.media.id, name: x.media.name, durationMs: x.media.probe?.duration_ms ?? x.tr.durationMs },
        transcript: { words: x.tr.words.length, sentences: x.tr.sentences.length, model: x.tr.model, language: x.tr.language },
        counts,
        removedMs: edl?.stats.removedMs ?? 0,
        keptMs: edl?.stats.keptMs ?? 0,
        cutCount: edl?.stats.cutCount ?? 0,
        aggressiveness: x.proj.aggressiveness,
        targetLufs: x.proj.targetLufs,
        stateMeaning: { auto: "規則自動剪（可 undo）", accepted: "使用者/AI 接受，會剪", pending: "待決建議，不剪", rejected: "不剪" },
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
