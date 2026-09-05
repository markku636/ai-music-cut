// EDL（Edit Decision List）：由已接受的候選算出「保留段」清單，含自然度守門。
// 純函式、無 DOM；probe 提供能量最低點（Rust 波形桶）供邊界貼齊，測試可用 midpoint 假件。
import type { Candidate, DecisionMap, Sentence, VadRegion, Word } from "../types";
import { effectiveXfFrames, effectiveXfMs, framesToMs, msToFrames } from "./joins";
import { DEFAULT_BREATH_OPTIONS, planBreath, type BreathContext, type BreathOptions } from "./breath";
import { chooseJoin, DEFAULT_FADE_POLICY, type FadePolicy } from "./fade";
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
  /**
   * 語音接語音的接點至少留這麼多呼吸（從剪除區找回）。
   * @deprecated 由 `breath` 取代；仍保留是為了讀得懂舊專案檔存下來的選項。
   */
  minBreathGapMs: number;
  /** 呼吸感：句中 / 句尾 / 段落各自的目標留白。 */
  breath: BreathOptions;
  /** 剪點淡化長度策略。 */
  fade: FadePolicy;
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
  breath: DEFAULT_BREATH_OPTIONS,
  fade: DEFAULT_FADE_POLICY,
  crossfadeMs: 20,
  maxSentenceRemovalRatio: 0.475,
  allowGapInsert: true,
};

export interface EnergyProbe {
  /** [from,to] 內能量最低點（ms）。 */
  minEnergyPointMs(fromMs: number, toMs: number): number;
  /** [from,to] 的 RMS（dBFS）。沒有實作時淡化策略一律當成語音接語音（最保守）。 */
  rmsDbAt?(fromMs: number, toMs: number): number;
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
  /** crossfade：實際重疊長度（已夾過）；gap：room tone 長度。 */
  ms: number;
  /** gap 接點的前段淡出 / 後段淡入（crossfade 不用）。 */
  fadeOutMs?: number;
  fadeInMs?: number;
  removedCandidateIds: string[];
}

export interface EdlStats {
  removedMs: number;
  /** 保留段的來源總長（不含接點重疊與 room tone）—— 不是成品長度。 */
  keptMs: number;
  /** 成品長度：keptMs 扣掉 crossfade 重疊、加上 gap 的 room tone。 */
  outMs: number;
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

  // 5) 呼吸回填：依「句中 / 句尾 / 段落」給不同的目標留白，能還多少還多少。
  //    先還尾端（靠近下一段語音，像講者開口前換氣），不足再還頭端，仍不足才插 room tone。
  const joinsMeta: { removal: Removal; gapMs: number; context: BreathContext }[] = [];
  const breathOpts: BreathOptions = { ...opts.breath, allowGapInsert: opts.allowGapInsert };
  for (const r of removals) {
    const b = planBreath(vad, sentences, words, r, breathOpts);
    r.startMs = b.startMs;
    r.endMs = b.endMs;
    joinsMeta.push({ removal: r, gapMs: b.gapMs, context: b.context });
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
  //
  // 兩趟：先決定每個接點的種類，再用 joins.ts 的公式算重疊與輸出時間。
  // crossfade 是「重疊」不是「插入」—— 一趟做完會漏扣重疊，每刀累積約 20 ms 漂移。
  const joins: Join[] = [];
  for (let i = 0; i + 1 < keeps.length; i++) {
    const k = keeps[i];
    const next = keeps[i + 1];
    const between = joinsMeta.filter((m) => m.removal.startMs >= k.srcEndMs - 1 && m.removal.endMs <= next.srcStartMs + 1);
    const ids = between.flatMap((m) => m.removal.candidateIds);
    const gapMs = Math.max(0, ...between.map((m) => m.gapMs));
    const shape = chooseJoin(probe, k.srcEndMs, next.srcStartMs, opts.fade, gapMs);
    if (shape.kind === "gap") {
      joins.push({ afterKeepId: k.id, kind: "gap", ms: shape.ms, removedCandidateIds: ids, fadeOutMs: shape.fadeOutMs, fadeInMs: shape.fadeInMs });
    } else {
      // 存「實際生效」的長度而不是規格值：EDL 要能自我描述，讀 Join.ms 的人看到的就是真的。
      // Rust 端會用同一條公式再夾一次（冪等），舊 plan 也就自動安全。
      const ms = effectiveXfMs(shape.ms, k.srcEndMs - k.srcStartMs, next.srcEndMs - next.srcStartMs);
      joins.push({ afterKeepId: k.id, kind: "crossfade", ms, removedCandidateIds: ids });
    }
  }
  {
    // 輸出時間軸一律走 frame，四捨五入的位置才會跟 Rust 一致。
    let outFrames = 0;
    for (let i = 0; i < keeps.length; i++) {
      const k = keeps[i];
      k.outStartMs = framesToMs(outFrames);
      outFrames += msToFrames(k.srcEndMs) - msToFrames(k.srcStartMs);
      k.outEndMs = framesToMs(outFrames);
      const j = joins[i];
      if (!j) continue;
      if (j.kind === "gap") outFrames += msToFrames(j.ms);
      else outFrames -= effectiveXfFrames(j.ms, msToFrames(k.srcEndMs) - msToFrames(k.srcStartMs), msToFrames(keeps[i + 1].srcEndMs) - msToFrames(keeps[i + 1].srcStartMs));
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
  const outMs = keeps.length ? keeps[keeps.length - 1].outEndMs : 0;
  return { keeps, joins, stats: { removedMs, keptMs, outMs, cutCount: Math.max(0, keeps.length - 1), byKind }, downgrades, removals };
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
