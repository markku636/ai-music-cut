import { create } from "zustand";
import { effectLabel, type AudioEffect } from "../analysis/effects";
import { thresholdsFor } from "../analysis/thresholds";
import { SUGGEST_ONLY_KINDS, candidateId, isActiveState, splitPointId, type Candidate, type CandidateKind, type Decision, type DecisionMap, type DecisionState, type Opinion, type SplitPoint } from "../analysis/types";
import { resolveOpinions } from "../analysis/llm/resolve";
import { useProject } from "./project";

/** 一筆可復原的變更：某媒體的候選 + 決策整份快照（幾千筆內複製成本可忽略）。 */
interface Snapshot {
  candidates: Candidate[];
  decisions: DecisionMap;
  effects: AudioEffect[];
  splits: SplitPoint[];
}

interface Patch {
  label: string;
  mediaId: string;
  before: Snapshot;
  after: Snapshot;
}

const MAX_HISTORY = 200;

export interface DecisionFilter {
  kinds: CandidateKind[] | null;
  states: DecisionState[] | null;
}

interface DecisionsStore {
  candidates: Record<string, Candidate[]>;
  decisions: Record<string, DecisionMap>;
  /** 區段效果（靜音 / 增益 / 淡入淡出），與候選共用 undo 歷史。 */
  effects: Record<string, AudioEffect[]>;
  /** 刀片切點，同樣共用 undo 歷史。 */
  splits: Record<string, SplitPoint[]>;
  selectedIds: string[];
  filter: DecisionFilter;
  /** 審核模式（一次一筆、鍵盤決定並自動前進）。 */
  reviewing: boolean;
  past: Patch[];
  future: Patch[];

  /** 規則重跑 / LLM 合併：換掉候選；user 決策依 id 保留、rule 決策重算預設。 */
  setCandidates: (mediaId: string, cands: Candidate[], opts: { label: string; aggressiveness: number; keepLlm?: boolean; record?: boolean }) => void;
  /** LLM 判讀結果：對既有 id 設狀態（不覆寫 user）、加入新候選。 */
  applyJudge: (mediaId: string, updates: { id: string; state: DecisionState; reason?: string }[], added: Candidate[], aggressiveness: number) => void;
  /**
   * 兩個 agent 的意見一起併入（剪輯 + 審核）。收斂規則全在 analysis/llm/resolve.ts。
   * `applyJudge` 變成「只有剪輯意見」的薄包裝 —— CLI / MCP 不必改。
   */
  applyOpinions: (
    mediaId: string,
    editor: { id: string; state: DecisionState; reason?: string }[],
    added: Candidate[],
    reviewer: Record<string, Opinion>,
    aggressiveness: number,
    label?: string,
  ) => void;
  decide: (mediaId: string, ids: string[], state: DecisionState, opts?: { origin?: Decision["origin"]; label?: string; reason?: string }) => void;
  toggleWordCut: (mediaId: string, wordId: number, word: { startMs: number; endMs: number; text: string }, sentenceId: number) => void;
  addManualCut: (mediaId: string, startMs: number, endMs: number, wordIds: number[], reason?: string, sentenceId?: number) => string;
  /** 人工拉邊界：改候選的時間範圍（id 不變）；標記 meta.userRange 讓規則重跑時保留人工調整。 */
  updateCandidateRange: (mediaId: string, id: string, startMs: number, endMs: number, wordIds?: number[]) => void;
  removeCandidate: (mediaId: string, id: string) => void;
  /** 刀片：在 ms 切一刀。同位置（±toleranceMs）已有切點則移除，等於 toggle。回傳切完之後那裡有沒有切點。 */
  toggleSplit: (mediaId: string, ms: number, toleranceMs?: number) => boolean;
  /** 移動切點（修剪工具拖切點用）。 */
  moveSplit: (mediaId: string, id: string, ms: number) => void;
  /** 設定這一刀要插多長的留白（0 = 純對接）。 */
  setSplitGap: (mediaId: string, id: string, gapMs: number) => void;
  removeSplit: (mediaId: string, id: string) => void;
  addEffect: (mediaId: string, e: AudioEffect) => void;
  updateEffect: (mediaId: string, id: string, patch: Partial<Omit<AudioEffect, "id">>) => void;
  removeEffect: (mediaId: string, id: string) => void;
  bulk: (mediaId: string, pred: (c: Candidate, d: Decision | undefined) => boolean, state: DecisionState, label?: string) => number;
  /**
   * 直接對一串 id 下決定。取代 `bulk(c => visible.includes(c))` —— 那個寫法每筆都要掃一次
   * visible 陣列，80 個候選就是 6400 次比較，而且呼叫端還得先算出整個 visible。
   * 一樣走 commit()，所以整批仍然是「一筆 undo」。
   */
  bulkIds: (mediaId: string, ids: string[], state: DecisionState, label?: string) => number;
  select: (ids: string[]) => void;
  setFilter: (f: Partial<DecisionFilter>) => void;
  setReviewing: (v: boolean) => void;
  undo: () => void;
  redo: () => void;
  clear: (mediaId: string) => void;
  /** 專案載入：直接放入（不記 undo）。 */
  load: (mediaId: string, candidates: Candidate[], decisions: DecisionMap, effects?: AudioEffect[], splits?: SplitPoint[]) => void;
}

function now(): string {
  return new Date().toISOString();
}

/** 規則候選的預設狀態：只建議的類型 → pending；其餘依分數門檻 → auto / pending。 */
export function defaultStateFor(c: Candidate, aggressiveness: number): DecisionState {
  if (c.source === "user") return "accepted";
  if (SUGGEST_ONLY_KINDS.has(c.kind)) return "pending";
  const th = thresholdsFor(aggressiveness);
  return c.score >= th.fillerAutoScore ? "auto" : "pending";
}

export const useDecisions = create<DecisionsStore>((set, get) => {
  const snapshot = (mediaId: string): Snapshot => ({
    candidates: get().candidates[mediaId] ?? [],
    decisions: get().decisions[mediaId] ?? {},
    effects: get().effects[mediaId] ?? [],
    splits: get().splits[mediaId] ?? [],
  });
  const commit = (mediaId: string, label: string, next: { candidates?: Candidate[]; decisions?: DecisionMap; effects?: AudioEffect[]; splits?: SplitPoint[] }, record = true) => {
    const before = snapshot(mediaId);
    const after: Snapshot = {
      candidates: next.candidates ?? before.candidates,
      decisions: next.decisions ?? before.decisions,
      effects: next.effects ?? before.effects,
      splits: next.splits ?? before.splits,
    };
    set((s) => ({
      candidates: { ...s.candidates, [mediaId]: after.candidates },
      decisions: { ...s.decisions, [mediaId]: after.decisions },
      effects: { ...s.effects, [mediaId]: after.effects },
      splits: { ...s.splits, [mediaId]: after.splits },
      past: record ? [...s.past.slice(-(MAX_HISTORY - 1)), { label, mediaId, before, after }] : s.past,
      future: record ? [] : s.future,
    }));
    useProject.getState().markDirty();
  };

  return {
    candidates: {},
    decisions: {},
    effects: {},
    splits: {},
    selectedIds: [],
    filter: { kinds: null, states: null },
    reviewing: false,
    past: [],
    future: [],

    setCandidates: (mediaId, incoming, opts) => {
      const prev = get().decisions[mediaId] ?? {};
      const next: DecisionMap = {};
      // 人工拉過邊界的候選：時間範圍以使用者版本為準
      const adjusted = new Map((get().candidates[mediaId] ?? []).filter((c) => c.meta?.userRange).map((c) => [c.id, c] as const));
      const cands = incoming.map((c) => adjusted.get(c.id) ?? c);
      for (const c of cands) {
        const old = prev[c.id];
        if (old && (old.origin === "user" || (opts.keepLlm !== false && old.origin === "llm"))) next[c.id] = old;
        else next[c.id] = { state: defaultStateFor(c, opts.aggressiveness), origin: c.source === "user" ? "user" : "rule", at: now() };
      }
      // 使用者手動加的候選（manual）要保留在清單裡
      const manual = (get().candidates[mediaId] ?? []).filter((c) => c.source === "user" && !cands.some((x) => x.id === c.id));
      for (const m of manual) next[m.id] = prev[m.id] ?? { state: "accepted", origin: "user", at: now() };
      commit(mediaId, opts.label, { candidates: [...cands, ...manual].sort((a, b) => a.startMs - b.startMs), decisions: next }, opts.record !== false);
    },

    applyJudge: (mediaId, updates, added, aggressiveness) => {
      get().applyOpinions(mediaId, updates, added, {}, aggressiveness, "AI 判讀");
    },

    applyOpinions: (mediaId, editor, added, reviewer, aggressiveness, label) => {
      const cands = (get().candidates[mediaId] ?? []).slice();
      const dec: DecisionMap = { ...(get().decisions[mediaId] ?? {}) };
      const ids = new Set(cands.map((c) => c.id));
      const at = now();

      // 先把新候選加進來，後面的收斂才看得到它們
      for (const c of added) {
        if (ids.has(c.id)) continue;
        cands.push(c);
        ids.add(c.id);
        dec[c.id] = { state: SUGGEST_ONLY_KINDS.has(c.kind) ? "pending" : defaultStateFor(c, aggressiveness), origin: "llm", reason: c.reason, at };
      }
      const kindOf = new Map(cands.map((c) => [c.id, c.kind] as const));

      // 剪輯的 state 換算成 verdict：apply→cut、drop→keep、suggest→unsure
      const editorOpinions = new Map<string, Opinion>();
      for (const u of editor) {
        if (!ids.has(u.id)) continue;
        const verdict: Opinion["verdict"] = u.state === "auto" ? "cut" : u.state === "rejected" ? "keep" : "unsure";
        editorOpinions.set(u.id, { verdict, reason: u.reason ?? "", at });
      }

      for (const id of new Set([...editorOpinions.keys(), ...Object.keys(reviewer)])) {
        if (!ids.has(id)) continue;
        const kind = kindOf.get(id);
        const r = resolveOpinions({
          current: dec[id],
          editor: editorOpinions.get(id),
          reviewer: reviewer[id],
          suggestOnly: !!kind && SUGGEST_ONLY_KINDS.has(kind),
        });
        if (!r.changed) continue;
        const prev = dec[id];
        dec[id] = {
          // origin=user 的決定不能被覆蓋，resolveOpinions 已經保證 state 不變
          state: r.state,
          origin: prev?.origin === "user" ? "user" : "llm",
          reason: prev?.origin === "user" ? prev.reason : r.reason,
          at,
          opinions: r.opinions,
          ...(r.conflict ? { conflict: true } : {}),
        };
      }
      commit(mediaId, label ?? "AI 判讀（剪輯＋審核）", { candidates: cands.sort((a, b) => a.startMs - b.startMs), decisions: dec });
    },

    decide: (mediaId, ids, state, opts = {}) => {
      if (!ids.length) return;
      const dec: DecisionMap = { ...(get().decisions[mediaId] ?? {}) };
      for (const id of ids) dec[id] = { state, origin: opts.origin ?? "user", reason: opts.reason, at: now() };
      commit(mediaId, opts.label ?? (state === "accepted" ? "接受" : state === "rejected" ? "拒絕" : "改為建議"), { decisions: dec });
    },

    toggleWordCut: (mediaId, wordId, word, sentenceId) => {
      const cands = get().candidates[mediaId] ?? [];
      const dec = get().decisions[mediaId] ?? {};
      const covering = cands.filter((c) => c.wordIds.includes(wordId));
      if (covering.length) {
        const anyActive = covering.some((c) => dec[c.id]?.state === "auto" || dec[c.id]?.state === "accepted");
        get().decide(mediaId, covering.map((c) => c.id), anyActive ? "rejected" : "accepted", { label: anyActive ? "還原字" : "剪除字" });
        return;
      }
      get().addManualCut(mediaId, word.startMs, word.endMs, [wordId], `手動剪除「${word.text.trim()}」`, sentenceId);
    },

    addManualCut: (mediaId, startMs, endMs, wordIds, reason = "手動剪除", sentenceId = -1) => {
      const id = candidateId("manual", startMs, endMs, "user");
      const cands = (get().candidates[mediaId] ?? []).filter((c) => c.id !== id);
      const c: Candidate = { id, kind: "manual", startMs, endMs, wordIds, reason, score: 1, source: "user", sentenceId };
      const dec: DecisionMap = { ...(get().decisions[mediaId] ?? {}), [id]: { state: "accepted", origin: "user", at: now() } };
      commit(mediaId, "手動剪除", { candidates: [...cands, c].sort((a, b) => a.startMs - b.startMs), decisions: dec });
      return id;
    },

    updateCandidateRange: (mediaId, id, startMs, endMs, wordIds) => {
      const s0 = Math.round(Math.min(startMs, endMs));
      const e0 = Math.round(Math.max(startMs, endMs));
      if (e0 - s0 < 20) return;
      const list = get().candidates[mediaId] ?? [];
      if (!list.some((c) => c.id === id)) return;
      const cands = list.map((c) =>
        c.id === id ? { ...c, startMs: s0, endMs: e0, wordIds: wordIds ?? c.wordIds, meta: { ...(c.meta ?? {}), userRange: true } } : c,
      );
      const old = get().decisions[mediaId]?.[id];
      const state = !old || isActiveState(old.state) ? "accepted" : old.state;
      const dec: DecisionMap = { ...(get().decisions[mediaId] ?? {}), [id]: { state, origin: "user", reason: old?.reason, at: now() } };
      commit(mediaId, "調整範圍", { candidates: cands.sort((a, b) => a.startMs - b.startMs), decisions: dec });
    },

    removeCandidate: (mediaId, id) => {
      const cands = (get().candidates[mediaId] ?? []).filter((c) => c.id !== id);
      const dec: DecisionMap = { ...(get().decisions[mediaId] ?? {}) };
      delete dec[id];
      commit(mediaId, "移除候選", { candidates: cands, decisions: dec });
      set((s) => ({ selectedIds: s.selectedIds.filter((x) => x !== id) }));
    },

    toggleSplit: (mediaId, ms, toleranceMs = 20) => {
      const list = get().splits[mediaId] ?? [];
      const at = Math.max(0, Math.round(ms));
      const hit = list.find((s) => Math.abs(s.ms - at) <= toleranceMs);
      if (hit) {
        commit(mediaId, "移除切點", { splits: list.filter((s) => s.id !== hit.id) });
        return false;
      }
      // id 帶位置只是為了看得懂；真正的唯一性靠下面的去重（同一毫秒不會有兩刀）
      let id = splitPointId(at);
      for (let n = 2; list.some((s) => s.id === id); n++) id = `${splitPointId(at)}#${n}`;
      commit(mediaId, "切一刀", { splits: [...list, { id, ms: at }].sort((a, b) => a.ms - b.ms) });
      return true;
    },
    moveSplit: (mediaId, id, ms) => {
      const list = get().splits[mediaId] ?? [];
      if (!list.some((s) => s.id === id)) return;
      const next = list.map((s) => (s.id === id ? { ...s, ms: Math.max(0, Math.round(ms)) } : s)).sort((a, b) => a.ms - b.ms);
      commit(mediaId, "移動切點", { splits: next });
    },
    setSplitGap: (mediaId, id, gapMs) => {
      const list = get().splits[mediaId] ?? [];
      if (!list.some((s) => s.id === id)) return;
      const g = Math.max(0, Math.round(gapMs));
      commit(mediaId, g > 0 ? `插入留白 ${g} ms` : "移除留白", { splits: list.map((s) => (s.id === id ? { ...s, gapMs: g } : s)) });
    },
    removeSplit: (mediaId, id) => {
      const list = get().splits[mediaId] ?? [];
      if (!list.some((s) => s.id === id)) return;
      commit(mediaId, "移除切點", { splits: list.filter((s) => s.id !== id) });
    },

    addEffect: (mediaId, e) => {
      const list = (get().effects[mediaId] ?? []).filter((x) => x.id !== e.id);
      commit(mediaId, `效果：${effectLabel(e)}`, { decisions: get().decisions[mediaId] ?? {}, effects: [...list, e].sort((a, b) => a.startMs - b.startMs) });
    },
    updateEffect: (mediaId, id, patch) => {
      const list = get().effects[mediaId] ?? [];
      if (!list.some((x) => x.id === id)) return;
      const next = list.map((x) => (x.id === id ? { ...x, ...patch } : x)).sort((a, b) => a.startMs - b.startMs);
      commit(mediaId, "調整效果", { decisions: get().decisions[mediaId] ?? {}, effects: next });
    },
    removeEffect: (mediaId, id) => {
      const list = get().effects[mediaId] ?? [];
      if (!list.some((x) => x.id === id)) return;
      commit(mediaId, "移除效果", { decisions: get().decisions[mediaId] ?? {}, effects: list.filter((x) => x.id !== id) });
    },

    bulk: (mediaId, pred, state, label) => {
      const cands = get().candidates[mediaId] ?? [];
      const dec = get().decisions[mediaId] ?? {};
      const ids = cands.filter((c) => pred(c, dec[c.id])).map((c) => c.id);
      if (ids.length) get().decide(mediaId, ids, state, { label: label ?? `批次${state === "accepted" ? "接受" : "拒絕"} ${ids.length} 筆` });
      return ids.length;
    },

    bulkIds: (mediaId, ids, state, label) => {
      if (!ids.length) return 0;
      const known = new Set((get().candidates[mediaId] ?? []).map((c) => c.id));
      const use = ids.filter((id) => known.has(id));
      if (!use.length) return 0;
      get().decide(mediaId, use, state, { label: label ?? `批次${state === "accepted" ? "接受" : "拒絕"} ${use.length} 筆` });
      return use.length;
    },

    select: (ids) => set({ selectedIds: ids }),
    setFilter: (f) => set((s) => ({ filter: { ...s.filter, ...f } })),
    setReviewing: (v) => set({ reviewing: v }),

    undo: () => {
      const p = get().past[get().past.length - 1];
      if (!p) return;
      set((s) => ({
        candidates: { ...s.candidates, [p.mediaId]: p.before.candidates },
        decisions: { ...s.decisions, [p.mediaId]: p.before.decisions },
        effects: { ...s.effects, [p.mediaId]: p.before.effects },
        splits: { ...s.splits, [p.mediaId]: p.before.splits ?? [] },
        past: s.past.slice(0, -1),
        future: [...s.future, p],
      }));
      useProject.getState().markDirty();
    },
    redo: () => {
      const p = get().future[get().future.length - 1];
      if (!p) return;
      set((s) => ({
        candidates: { ...s.candidates, [p.mediaId]: p.after.candidates },
        decisions: { ...s.decisions, [p.mediaId]: p.after.decisions },
        effects: { ...s.effects, [p.mediaId]: p.after.effects },
        splits: { ...s.splits, [p.mediaId]: p.after.splits ?? [] },
        future: s.future.slice(0, -1),
        past: [...s.past, p],
      }));
      useProject.getState().markDirty();
    },
    load: (mediaId, candidates, decisions, effects = [], splits = []) =>
      set((s) => ({
        candidates: { ...s.candidates, [mediaId]: candidates },
        decisions: { ...s.decisions, [mediaId]: decisions },
        effects: { ...s.effects, [mediaId]: effects },
        splits: { ...s.splits, [mediaId]: splits },
      })),
    clear: (mediaId) =>
      set((s) => {
        const candidates = { ...s.candidates };
        const decisions = { ...s.decisions };
        const effects = { ...s.effects };
        const splits = { ...s.splits };
        delete candidates[mediaId];
        delete decisions[mediaId];
        delete effects[mediaId];
        delete splits[mediaId];
        return { candidates, decisions, effects, splits, past: s.past.filter((p) => p.mediaId !== mediaId), future: s.future.filter((p) => p.mediaId !== mediaId) };
      }),
  };
});

/** 統計：各狀態 / 類型數量。 */
export function decisionCounts(cands: Candidate[], dec: DecisionMap) {
  const byState: Record<DecisionState, number> = { auto: 0, accepted: 0, rejected: 0, pending: 0 };
  const byKind: Partial<Record<CandidateKind, number>> = {};
  for (const c of cands) {
    const s = dec[c.id]?.state ?? "pending";
    byState[s] += 1;
    byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
  }
  return { byState, byKind, total: cands.length };
}
