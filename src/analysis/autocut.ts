import type { CandidateKind, Transcript } from "./types";
import { fillerCandidates, findText, totalMs, type TextHit } from "./textSearch";

/**
 * 一鍵粗剪要做哪些事 —— **判斷的部分**（純函式，這裡是唯一會出錯的地方）。
 * 真正去做的流程在 `pipeline/autocut.ts`。
 *
 * 實測一集 57 分鐘的真實 podcast（10730 字、1651 個候選）：
 * 規則層自動剪省 2.73 分；接受「可靠類別」再省 2.0 分；
 * 批次剪掉前三名口頭禪（然後 198 / 就是 194 / 那個 108）再省 1.5 分 ——
 * 合計 6.2 分（10.9%），全部加起來 1.6 秒跑完。
 *
 * 但**真正的時間都花在別的地方**：那一集有 1445 筆候選是「待決」的，
 * 其中 1011 筆是 unclear（低信心字）。一筆一筆審完要好幾個小時，
 * 遠遠超過剪掉的 6 分鐘。所以一鍵粗剪的價值不只是「剪得快」，
 * 是**讓人不用面對那 1445 筆**：能自動決定的自動決定，剩下的才問人。
 */

/** 規則層有把握、可以自動接受的類別。 */
export const RELIABLE_KINDS: readonly CandidateKind[] = ["filler", "stutter", "long_pause", "restart"];

/** 只建議、永遠不自動剪的類別（拿掉這些等於替使用者決定內容）。 */
export const SUGGEST_ONLY_KINDS: readonly CandidateKind[] = ["unclear", "rambling", "off_topic", "redo", "noise"];

export interface FillerPlanOptions {
  /** 出現幾次以上才值得批次剪。太低會把正常用語一起剪掉。 */
  minCount: number;
  /** 最多剪幾種。 */
  maxQueries: number;
  /** 單一口頭禪最多佔節目多少比例；超過表示它可能是內容的一部分，不要碰。 */
  maxShareOfDuration: number;
}

export const DEFAULT_FILLER_PLAN: FillerPlanOptions = { minCount: 8, maxQueries: 5, maxShareOfDuration: 0.03 };

export interface FillerPlanItem {
  query: string;
  count: number;
  totalMs: number;
  hits: TextHit[];
}

/**
 * 挑出值得批次剪的口頭禪。
 *
 * 兩道守門，缺一不可：
 * - **次數**：出現 8 次以上才算口頭禪。講兩次的是講話，不是習慣。
 * - **佔比**：任何一個詞如果佔掉節目 3% 以上的時間，八成是這一集的主題詞
 *   （談「那個東西」的一集裡「那個」會爆量），剪掉會把內容剪爛。
 */
export function planFillerCuts(tr: Transcript | null, durationMs: number, opts: FillerPlanOptions = DEFAULT_FILLER_PLAN): FillerPlanItem[] {
  if (!tr || durationMs <= 0) return [];
  const out: FillerPlanItem[] = [];
  for (const f of fillerCandidates(tr, opts.minCount)) {
    const hits = findText(tr, f.query);
    if (hits.length < opts.minCount) continue;
    const ms = totalMs(hits);
    if (ms / durationMs > opts.maxShareOfDuration) continue; // 這個詞是內容，不是雜訊
    out.push({ query: f.query, count: hits.length, totalMs: ms, hits });
    if (out.length >= opts.maxQueries) break;
  }
  return out;
}

export interface AutoCutSteps {
  /** 接受規則層有把握的類別。 */
  reliable: boolean;
  /** 批次剪重複的口頭禪。 */
  fillers: boolean;
  /** 依量測結果套用修聲。 */
  cleanup: boolean;
  /** 讓 claude 逐段判讀（慢，但會處理 unclear / 離題）。 */
  judge: boolean;
  /** 讓 claude 寫節目筆記與章節。 */
  notes: boolean;
}

export const DEFAULT_STEPS: AutoCutSteps = { reliable: true, fillers: true, cleanup: true, judge: false, notes: false };

export interface AutoCutReport {
  /** 每一步做了什麼（給人看的一行）。 */
  lines: string[];
  srcMs: number;
  outMs: number;
  /** 各步驟各省了多少（ms）。 */
  savedByStep: { label: string; savedMs: number }[];
  acceptedCount: number;
  fillerCuts: number;
  cleanupApplied: boolean;
  judged: boolean;
  notesWritten: boolean;
  /** 還需要人看的筆數。 */
  pendingCount: number;
}

/** 省下多少（ms）與百分比。 */
export function savedOf(r: Pick<AutoCutReport, "srcMs" | "outMs">): { ms: number; percent: number } {
  const ms = Math.max(0, r.srcMs - r.outMs);
  return { ms, percent: r.srcMs > 0 ? (ms / r.srcMs) * 100 : 0 };
}
