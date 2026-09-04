// EDL（Edit Decision List）：由已接受的候選算出「保留段」清單，含自然度守門。
// 純函式、無 DOM；probe 提供能量最低點（Rust 波形桶）供邊界貼齊，測試可用 midpoint 假件。
import type { Candidate, DecisionMap, Sentence, VadRegion, Word } from "../types";
import { isActiveState } from "../types";

export interface EdlOptions {
  /** 字邊界外的保護 pad（不切到字頭 / 字尾）。 */
  padPreMs: number;
  padPostMs: number;
  /** 邊界貼齊到 ±window 內能量最低點。 */
  snapWindowMs: number;
  /** 兩段剪除相距小於此 → 合併（中間無保留字才合）。 */
  mergeGapMs: number;
  /** 短於此且沒有字的保留段併入剪除。 */
  minKeepMs: number;
  /** 語音接語音的接點至少留這麼多呼吸（從剪除區找回）。 */
  minBreathGapMs: number;
  crossfadeMs: number;
  /** 單句最多剪除比例（超過就把最低分的 auto 降級為 pending）。 */
  maxSentenceRemovalRatio: number;
  /** 找不到呼吸時插 room tone（純音訊可；影片不行）。 */
  allowGapInsert: boolean;
}

export const DEFAULT_EDL_OPTIONS: EdlOptions = {
  padPreMs: 40,
  padPostMs: 60,
  snapWindowMs: 30,
  mergeGapMs: 120,
  minKeepMs: 80,
  minBreathGapMs: 150,
  crossfadeMs: 20,
  maxSentenceRemovalRatio: 0.475,
  allowGapInsert: true,
};

export interface EnergyProbe {
  /** [from,to] 內能量最低點（ms）。 */
  minEnergyPointMs(fromMs: number, toMs: number): number;
}

export const MIDPOINT_PROBE: EnergyProbe = { minEnergyPointMs: (a, b) => (a + b) / 2 };

export interface Removal {
  startMs: number;
  endMs: number;
  candidateIds: string[];
  /** 有字（語音）在裡面 → 接點是語音接語音。 */
  speech: boolean;
}

export interface KeepSegment {
  id: number;
  srcStartMs: number;
  srcEndMs: number;
  outStartMs: number;
  outEndMs: number;
  /** 由響度模組填；EDL 內為 0。 */
  gainDb: number;
}

export interface Join {
  afterKeepId: number;
  kind: "crossfade" | "gap";
  ms: number;
  removedCandidateIds: string[];
}

export interface EdlStats {
  removedMs: number;
  keptMs: number;
  cutCount: number;
  byKind: Record<string, { count: number; ms: number }>;
}

export interface Downgrade {
  candidateId: string;
  reason: string;
}

export interface Edl {
  keeps: KeepSegment[];
  joins: Join[];
  stats: EdlStats;
  downgrades: Downgrade[];
  removals: Removal[];
}

export interface EdlInput {
  words: Word[];
  sentences: Sentence[];
  vad: VadRegion[];
  durationMs: number;
}

const WORD_KINDS = new Set(["filler", "stutter", "restart", "unclear", "rambling", "off_topic", "redo"]);

/** 已接受（auto/accepted）的候選 → 合併後的剪除區間（不含 pad；供播放跳過 / 時間軸上色）。 */
export function activeRanges(candidates: Candidate[], decisions: DecisionMap): { startMs: number; endMs: number }[] {
  const rs = candidates.filter((c) => isActiveState(decisions[c.id]?.state)).map((c) => ({ startMs: c.startMs, endMs: c.endMs }));
  return mergeRanges(rs);
}

export function mergeRanges<T extends { startMs: number; endMs: number }>(rs: T[]): { startMs: number; endMs: number }[] {
  const sorted = rs.slice().sort((a, b) => a.startMs - b.startMs);
  const out: { startMs: number; endMs: number }[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.startMs <= last.endMs) last.endMs = Math.max(last.endMs, r.endMs);
    else out.push({ startMs: r.startMs, endMs: r.endMs });
  }
  return out;
}

function silenceFraction(vad: VadRegion[], fromMs: number, toMs: number): number {
  if (toMs <= fromMs) return 1;
  if (!vad.length) return 1;
  let speech = 0;
  for (const r of vad) {
    if (r.endMs <= fromMs) continue;
    if (r.startMs >= toMs) break;
    speech += Math.min(toMs, r.endMs) - Math.max(fromMs, r.startMs);
  }
  return 1 - speech / (toMs - fromMs);
}

export function buildEdl(input: EdlInput, candidates: Candidate[], decisions: DecisionMap, opts: EdlOptions = DEFAULT_EDL_OPTIONS, probe: EnergyProbe = MIDPOINT_PROBE): Edl {
  const { words, sentences, vad, durationMs } = input;
  const active = candidates.filter((c) => isActiveState(decisions[c.id]?.state));
  const activeIds = new Set(active.map((c) => c.id));
  const cutWordIds = new Set<number>();
  for (const c of active) if (WORD_KINDS.has(c.kind) || c.kind === "manual") for (const id of c.wordIds) cutWordIds.add(id);

  // 1) 每個候選 → 剪除區間（字類型加 pad、夾在相鄰保留字內）
  let removals: Removal[] = [];
  for (const c of active) {
    let start = c.startMs;
    let end = c.endMs;
    const wordBased = (WORD_KINDS.has(c.kind) || c.kind === "manual") && c.wordIds.length > 0;
    if (wordBased) {
      const first = words[c.wordIds[0]];
      const last = words[c.wordIds[c.wordIds.length - 1]];
      start = first.startMs - opts.padPreMs;
      end = last.endMs + opts.padPostMs;
      // 相鄰保留字：往前 / 往後找第一個不被剪的字
      let p = first.id - 1;
      while (p >= 0 && cutWordIds.has(p)) p -= 1;
      let n = last.id + 1;
      while (n < words.length && cutWordIds.has(n)) n += 1;
      if (p >= 0) start = Math.max(start, words[p].endMs + 20);
      if (n < words.length) end = Math.min(end, words[n].startMs - 20);
      start = Math.min(start, first.startMs);
      end = Math.max(end, last.endMs);
    }
    start = Math.max(0, start);
    end = Math.min(durationMs, end);
    if (end <= start) continue;
    removals.push({ startMs: start, endMs: end, candidateIds: [c.id], speech: wordBased });
  }

  // 2) 邊界貼齊到低能量點（±snap），但不越過候選本身的字
  for (const r of removals) {
    const s2 = probe.minEnergyPointMs(r.startMs - opts.snapWindowMs, r.startMs + opts.snapWindowMs);
    const e2 = probe.minEnergyPointMs(r.endMs - opts.snapWindowMs, r.endMs + opts.snapWindowMs);
    if (Number.isFinite(s2) && s2 < r.endMs) r.startMs = Math.max(0, s2);
    if (Number.isFinite(e2) && e2 > r.startMs) r.endMs = Math.min(durationMs, e2);
  }

  // 3) 合併：重疊一律合；間隙 < mergeGap 且中間沒有保留字才合
  removals.sort((a, b) => a.startMs - b.startMs);
  const merged: Removal[] = [];
  for (const r of removals) {
    const last = merged[merged.length - 1];
    if (last && r.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, r.endMs);
      last.candidateIds.push(...r.candidateIds);
      last.speech = last.speech || r.speech;
    } else if (last && r.startMs - last.endMs < opts.mergeGapMs && !hasKeptWordBetween(words, cutWordIds, last.endMs, r.startMs)) {
      last.endMs = r.endMs;
      last.candidateIds.push(...r.candidateIds);
      last.speech = last.speech || r.speech;
    } else merged.push({ ...r, candidateIds: r.candidateIds.slice() });
  }
  removals = merged;

  // 4) 單句剪除比守門：超標 → 把該句最低分的 auto（非 user）候選降級，重算
  const downgrades: Downgrade[] = [];
  const byId = new Map(candidates.map((c) => [c.id, c]));
  for (const s of sentences) {
    const dur = s.endMs - s.startMs;
    if (dur <= 0) continue;
    for (let guard = 0; guard < 20; guard++) {
      let removed = 0;
      const inSentence: Candidate[] = [];
      for (const c of active) {
        if (!activeIds.has(c.id) || c.kind === "long_pause" || c.sentenceId !== s.id) continue;
        inSentence.push(c);
        removed += Math.min(c.endMs, s.endMs) - Math.max(c.startMs, s.startMs);
      }
      if (removed / dur <= opts.maxSentenceRemovalRatio) break;
      const victims = inSentence.filter((c) => decisions[c.id]?.state === "auto").sort((a, b) => a.score - b.score);
      if (!victims.length) break;
      const v = victims[0];
      activeIds.delete(v.id);
      downgrades.push({ candidateId: v.id, reason: `單句剪除比例 ${Math.round((removed / dur) * 100)}% 超過上限 ${Math.round(opts.maxSentenceRemovalRatio * 100)}%，改為建議` });
    }
  }
  if (downgrades.length) {
    const dropped = new Set(downgrades.map((d) => d.candidateId));
    removals = removals
      .map((r) => ({ ...r, candidateIds: r.candidateIds.filter((id) => !dropped.has(id)) }))
      .filter((r) => r.candidateIds.length > 0);
    // 被降級的候選可能是合併區間的一部分：保守做法是重建（遞迴一次，去掉已降級者）
    if (removals.some((r) => r.candidateIds.some((id) => !byId.has(id)))) {
      /* unreachable */
    }
    const filteredDecisions: DecisionMap = { ...decisions };
    for (const id of dropped) filteredDecisions[id] = { ...(decisions[id] ?? { origin: "rule", at: "" }), state: "pending" };
    const rebuilt = buildEdl(input, candidates, filteredDecisions, { ...opts, maxSentenceRemovalRatio: 1 }, probe);
    return { ...rebuilt, downgrades };
  }

  // 5) 呼吸回填：語音接語音的剪除區，兩端若有 VAD 靜音，各還最多 minBreathGap/2… 簡化：從剪除區頭尾找回靜音
  const joinsMeta: { removal: Removal; gapInsert: boolean }[] = [];
  for (const r of removals) {
    if (!r.speech) {
      joinsMeta.push({ removal: r, gapInsert: false });
      continue;
    }
    const want = opts.minBreathGapMs;
    // 尾端（靠後一段語音）先找：剪除區最後 want ms 是否靜音
    const tailSilent = silenceFraction(vad, r.endMs - want, r.endMs) >= 0.8 && r.endMs - want > r.startMs;
    const headSilent = silenceFraction(vad, r.startMs, r.startMs + want) >= 0.8 && r.startMs + want < r.endMs;
    if (tailSilent) r.endMs -= want;
    else if (headSilent) r.startMs += want;
    joinsMeta.push({ removal: r, gapInsert: !tailSilent && !headSilent && opts.allowGapInsert });
  }
  removals = removals.filter((r) => r.endMs > r.startMs);

  // 6) 補集 → keeps；太短且無字的 keep 併入剪除
  const keeps: KeepSegment[] = [];
  let cursor = 0;
  const pushKeep = (a: number, b: number) => {
    if (b - a <= 0) return;
    if (b - a < opts.minKeepMs && !hasKeptWordBetween(words, cutWordIds, a, b)) {
      // 併入前一個剪除區
      return;
    }
    keeps.push({ id: keeps.length, srcStartMs: a, srcEndMs: b, outStartMs: 0, outEndMs: 0, gainDb: 0 });
  };
  for (const r of removals) {
    pushKeep(cursor, r.startMs);
    cursor = Math.max(cursor, r.endMs);
  }
  pushKeep(cursor, durationMs);

  // 7) joins + 輸出時間
  const joins: Join[] = [];
  let out = 0;
  for (let i = 0; i < keeps.length; i++) {
    const k = keeps[i];
    k.outStartMs = out;
    out += k.srcEndMs - k.srcStartMs;
    k.outEndMs = out;
    if (i < keeps.length - 1) {
      const next = keeps[i + 1];
      const between = joinsMeta.filter((m) => m.removal.startMs >= k.srcEndMs - 1 && m.removal.endMs <= next.srcStartMs + 1);
      const gap = between.some((m) => m.gapInsert);
      const ids = between.flatMap((m) => m.removal.candidateIds);
      if (gap) {
        joins.push({ afterKeepId: k.id, kind: "gap", ms: opts.minBreathGapMs, removedCandidateIds: ids });
        out += opts.minBreathGapMs;
      } else joins.push({ afterKeepId: k.id, kind: "crossfade", ms: opts.crossfadeMs, removedCandidateIds: ids });
    }
  }

  // 8) 統計
  const byKind: Record<string, { count: number; ms: number }> = {};
  let removedMs = 0;
  for (const r of removals) {
    removedMs += r.endMs - r.startMs;
    for (const id of r.candidateIds) {
      const c = byId.get(id);
      if (!c) continue;
      const k = (byKind[c.kind] ??= { count: 0, ms: 0 });
      k.count += 1;
      k.ms += Math.min(c.endMs, r.endMs) - Math.max(c.startMs, r.startMs);
    }
  }
  const keptMs = keeps.reduce((s, k) => s + (k.srcEndMs - k.srcStartMs), 0);
  return { keeps, joins, stats: { removedMs, keptMs, cutCount: Math.max(0, keeps.length - 1), byKind }, downgrades, removals };
}

function hasKeptWordBetween(words: Word[], cutWordIds: Set<number>, fromMs: number, toMs: number): boolean {
  // 二分找第一個 startMs >= fromMs 的字
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].startMs < fromMs) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < words.length && words[i].startMs < toMs; i++) {
    if (!cutWordIds.has(i) && words[i].endMs <= toMs + 1) return true;
  }
  return false;
}

/** 來源時間 → 輸出時間；落在剪除區回 null。 */
export function mapSrcToOut(edl: Edl, srcMs: number): number | null {
  for (const k of edl.keeps) {
    if (srcMs >= k.srcStartMs && srcMs <= k.srcEndMs) return k.outStartMs + (srcMs - k.srcStartMs);
  }
  return null;
}

/** 輸出時間 → 來源時間（gap 內回下一段起點）。 */
export function mapOutToSrc(edl: Edl, outMs: number): number {
  for (const k of edl.keeps) {
    if (outMs < k.outStartMs) return k.srcStartMs;
    if (outMs <= k.outEndMs) return k.srcStartMs + (outMs - k.outStartMs);
  }
  const last = edl.keeps[edl.keeps.length - 1];
  return last ? last.srcEndMs : 0;
}
