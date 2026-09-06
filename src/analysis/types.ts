// 分析核心共用型別。時間一律 ms（整數）、來源時間軸。
// 伺服器（/v1/transcribe）回的是秒，經 normalize.ts 轉成這裡的形狀。

export interface Word {
  id: number;
  segId: number;
  /** 原字（含 Whisper 黏在字尾的標點）。 */
  text: string;
  /** NFKC + 小寫 + 去標點 / 空白（規則比對用）。 */
  norm: string;
  startMs: number;
  endMs: number;
  /** 字級信心 0–1。 */
  prob: number;
}

export interface Segment {
  id: number;
  startMs: number;
  endMs: number;
  text: string;
  avgLogprob: number;
  noSpeechProb: number;
  compressionRatio: number;
  hallucination: boolean;
  wordIds: number[];
}

export interface Sentence {
  id: number;
  wordIds: number[];
  startMs: number;
  endMs: number;
  endsWithQuestion: boolean;
}

export interface VadRegion {
  startMs: number;
  endMs: number;
}

/** 100 ms hop 的響度視窗（本機 ebur128）。 */
export interface LoudnessWindow {
  tMs: number;
  momentary: number;
  shortTerm: number;
  rmsDb: number;
}

export interface Transcript {
  words: Word[];
  segments: Segment[];
  sentences: Sentence[];
  vad: VadRegion[];
  durationMs: number;
  language: string;
  model: string;
}

export type CandidateKind =
  | "filler"
  | "stutter"
  | "restart"
  | "long_pause"
  | "unclear"
  | "noise"
  | "rambling"
  | "off_topic"
  | "redo"
  | "manual";

export type CandidateSource = "rule" | "llm" | "user";

export interface Candidate {
  /** 內容導出、跨次重跑穩定：`${kind}:${startMs}-${endMs}`（llm/user 前綴 `llm:` / `user:`）。 */
  id: string;
  kind: CandidateKind;
  startMs: number;
  endMs: number;
  wordIds: number[];
  /** 繁中理由（UI 直接顯示）。 */
  reason: string;
  /** 0–1；越高越該剪。 */
  score: number;
  source: CandidateSource;
  sentenceId: number;
  meta?: Record<string, unknown>;
}

export type DecisionState = "auto" | "accepted" | "rejected" | "pending";

/** 一個 agent 對某個候選的看法。 */
export interface Opinion {
  verdict: "cut" | "keep" | "unsure";
  /** 繁中，≤60 字。 */
  reason: string;
  at: string;
  /** 用哪個模型跑的（審核通常用比較便宜的）。 */
  model?: string;
}

export type AgentRole = "editor" | "reviewer";

export interface Decision {
  state: DecisionState;
  origin: CandidateSource;
  reason?: string;
  at: string;
  /**
   * 各 agent 的意見（剪輯 / 審核）。刻意是 optional 附加欄位：
   * state / origin / isActiveState 完全不動 → EDL、CLI、驗收路徑零改動，
   * 舊專案檔讀進來也不會壞。
   */
  opinions?: Partial<Record<AgentRole, Opinion>>;
  /** 兩個 agent 意見相反 → 送人裁決（審核佇列會收）。 */
  conflict?: boolean;
}

export type DecisionMap = Record<string, Decision>;

/** 是否會實際剪除（auto / accepted）。 */
export function isActiveState(s: DecisionState | undefined): boolean {
  return s === "auto" || s === "accepted";
}

export function candidateId(kind: CandidateKind, startMs: number, endMs: number, source: CandidateSource = "rule"): string {
  const prefix = source === "rule" ? "" : `${source}:`;
  return `${prefix}${kind}:${Math.round(startMs)}-${Math.round(endMs)}`;
}

/** 候選類型的顯示名。 */
export const KIND_LABEL: Record<CandidateKind, string> = {
  filler: "贅字",
  stutter: "口吃 / 重複",
  restart: "重講",
  long_pause: "長停頓",
  unclear: "含糊",
  noise: "雜音",
  rambling: "冗長",
  off_topic: "離題",
  redo: "重錄段",
  manual: "手動",
};

/** 這些類型永遠只當「建議」，不自動套用（需求 3：讓使用者決定）。 */
export const SUGGEST_ONLY_KINDS: ReadonlySet<CandidateKind> = new Set(["unclear", "rambling", "off_topic", "redo"]);

/**
 * 刀片切點：在來源時間軸上「切一刀」。
 *
 * 切點本身**不剪掉任何東西** —— 它把一個保留段斷成兩個，接縫用 butt join（seam），
 * 聽起來與沒切一樣。它的用途是「先立一個可以抓的把手」：切完才能對這一刀做漣漪 /
 * 捲動修剪，或在這裡插一段留白當呼吸。跟 Final Cut 的刀片同一個意思。
 *
 * 刻意不做成 Candidate：候選那一套背後接著規則層、雙 agent 判讀、審核佇列與驗收，
 * 而切點沒有「要不要剪」的語意，混進去只會讓那些流程多長出一堆例外。
 */
export interface SplitPoint {
  id: string;
  /** 來源時間（ms）。 */
  ms: number;
  /** > 0 時在此插入留白（room tone），走 Join.kind = "gap"。 */
  gapMs?: number;
}

export function splitPointId(ms: number): string {
  return `split:${Math.round(ms)}`;
}
