// AI 判讀的結構化輸出 schema（claude -p --json-schema）。additionalProperties:false 讓輸出可嚴格驗證。
export const JUDGE_SCHEMA_VERSION = 2;

export const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["window_id", "decisions", "new_candidates"],
  properties: {
    window_id: { type: "string" },
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "action", "reason"],
        properties: {
          id: { type: "string", description: "候選代號（c1、c2…）" },
          action: { type: "string", enum: ["apply", "suggest", "drop"], description: "apply=剪；suggest=留給使用者決定；drop=不剪" },
          reason: { type: "string", maxLength: 60 },
        },
      },
    },
    new_candidates: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "sentence_id", "text", "action", "reason"],
        properties: {
          kind: { type: "string", enum: ["unclear", "rambling", "off_topic", "redo", "filler", "restart"] },
          sentence_id: { type: "integer", minimum: 0 },
          text: { type: "string", description: "該句中要標記的連續文字（逐字複製，不含標點也可）" },
          action: { type: "string", enum: ["suggest", "apply"] },
          reason: { type: "string", maxLength: 80 },
        },
      },
    },
    notes: { type: "string", maxLength: 200 },
  },
} as const;

export interface JudgeOutput {
  window_id: string;
  decisions: { id: string; action: "apply" | "suggest" | "drop"; reason: string }[];
  new_candidates: { kind: "unclear" | "rambling" | "off_topic" | "redo" | "filler" | "restart"; sentence_id: number; text: string; action: "suggest" | "apply"; reason: string }[];
  notes?: string;
}

/** 審核 agent 的 schema：只覆核既有候選，**不允許新增**。 */
export const REVIEW_SCHEMA_VERSION = 1;

export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["window_id", "reviews"],
  properties: {
    window_id: { type: "string" },
    reviews: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "verdict", "reason"],
        properties: {
          id: { type: "string", description: "候選代號（c1、c2…）" },
          verdict: { type: "string", enum: ["cut", "keep", "unsure"], description: "cut=同意剪；keep=不該剪；unsure=不確定" },
          reason: { type: "string", maxLength: 60 },
        },
      },
    },
  },
} as const;

export interface ReviewOutput {
  window_id: string;
  reviews: { id: string; verdict: "cut" | "keep" | "unsure"; reason: string }[];
}
