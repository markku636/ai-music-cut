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

export interface Decision {
  state: DecisionState;
  origin: CandidateSource;
  reason?: string;
  at: string;
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
