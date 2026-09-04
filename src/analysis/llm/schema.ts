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
