// 伺服器 /v1/transcribe 結果 → Transcript（ms、字 id、句子切分）。
import type { Segment, Sentence, Transcript, VadRegion, Word } from "./types";

/** ttls `/v1/transcribe` 回應（秒）。 */
export interface ServerTranscript {
  model?: string | null;
  language?: string | null;
  duration_sec: number;
  segments: {
    id: number;
    start: number;
    end: number;
    text: string;
    avg_logprob?: number;
    no_speech_prob?: number;
    compression_ratio?: number;
    hallucination?: boolean;
    words: { start: number; end: number; word: string; probability: number }[];
  }[];
  vad?: { start: number; end: number }[];
}

const PUNCT_RE = /[\p{P}\p{S}\s]+/gu;

/** NFKC → 小寫 → 去標點 / 符號 / 空白。 */
export function normText(s: string): string {
  return s.normalize("NFKC").toLowerCase().replace(PUNCT_RE, "");
}

const SENTENCE_END_RE = /[。！？!?…]\s*$/;
const QUESTION_END_RE = /[？?]\s*$/;
const QUESTION_TAIL = ["嗎", "呢", "對不對", "是不是", "好不好", "行不行", "對嗎", "是嗎", "好嗎"];

export const SENTENCE_GAP_MS = 500;

function msOf(sec: number): number {
  return Math.round(sec * 1000);
}

/**
 * 切句：句末標點、字間間隔 ≥ 500 ms、或跨 VAD 區段邊界。
 * 幻覺段落的字仍保留（時間軸要用），但 segment.hallucination=true 讓規則層排除。
 */
export function normalizeTranscript(src: ServerTranscript): Transcript {
  const words: Word[] = [];
  const segments: Segment[] = [];
  for (const s of src.segments) {
    const wordIds: number[] = [];
    for (const w of s.words ?? []) {
      const startMs = msOf(w.start);
      const endMs = Math.max(startMs + 1, msOf(w.end));
      const id = words.length;
      words.push({ id, segId: s.id, text: w.word, norm: normText(w.word), startMs, endMs, prob: clamp01(w.probability) });
      wordIds.push(id);
    }
    segments.push({
      id: s.id,
      startMs: msOf(s.start),
      endMs: msOf(s.end),
      text: s.text,
      avgLogprob: s.avg_logprob ?? 0,
      noSpeechProb: s.no_speech_prob ?? 0,
      compressionRatio: s.compression_ratio ?? 0,
      hallucination: !!s.hallucination,
      wordIds,
    });
  }
  // 依時間排序（跨 chunk 已按序，但保險）。
  words.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  words.forEach((w, i) => (w.id = i));
  for (const seg of segments) seg.wordIds = words.filter((w) => w.segId === seg.id).map((w) => w.id);

  const vad: VadRegion[] = (src.vad ?? []).map((r) => ({ startMs: msOf(r.start), endMs: msOf(r.end) }));
  const sentences = splitSentences(words, vad);
  return {
    words,
    segments,
    sentences,
    vad,
    durationMs: msOf(src.duration_sec),
    language: src.language ?? "zh",
    model: src.model ?? "",
  };
}

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}

function vadIndexAt(vad: VadRegion[], ms: number): number {
  // 回包含 ms 的 VAD 區段索引；不在任何區段回 -1（用 binary search）
  let lo = 0;
  let hi = vad.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = vad[mid];
    if (ms < r.startMs) hi = mid - 1;
    else if (ms > r.endMs) lo = mid + 1;
    else return mid;
  }
  return -1;
}

export function splitSentences(words: Word[], vad: VadRegion[]): Sentence[] {
  const out: Sentence[] = [];
  let cur: number[] = [];
  const flush = () => {
    if (!cur.length) return;
    const first = words[cur[0]];
    const last = words[cur[cur.length - 1]];
    const tailNorm = cur
      .slice(-3)
      .map((i) => words[i].norm)
      .join("");
    const endsWithQuestion = QUESTION_END_RE.test(last.text) || QUESTION_TAIL.some((q) => tailNorm.endsWith(normText(q)));
    out.push({ id: out.length, wordIds: cur, startMs: first.startMs, endMs: last.endMs, endsWithQuestion });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    cur.push(w.id);
    const next = words[i + 1];
    if (!next) break;
    const gap = next.startMs - w.endMs;
    const punct = SENTENCE_END_RE.test(w.text);
    const crossVad = vad.length > 0 && vadIndexAt(vad, w.endMs - 1) !== vadIndexAt(vad, next.startMs + 1) && gap >= 250;
    if (punct || gap >= SENTENCE_GAP_MS || crossVad) flush();
  }
  flush();
  return out;
}

/** 字 id → 所在句子 id 的查表。 */
export function sentenceOfWord(sentences: Sentence[], nWords: number): Int32Array {
  const map = new Int32Array(nWords).fill(-1);
  for (const s of sentences) for (const id of s.wordIds) map[id] = s.id;
  return map;
}
