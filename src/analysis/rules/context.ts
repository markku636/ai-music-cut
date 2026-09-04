// 規則共用的上下文與候選建構 helper。
import { sentenceOfWord } from "../normalize";
import type { Thresholds } from "../thresholds";
import type { Candidate, CandidateKind, LoudnessWindow, Segment, Sentence, Transcript, VadRegion, Word } from "../types";
import { candidateId } from "../types";

export interface AnalysisInput {
  transcript: Transcript;
  loudness: LoudnessWindow[];
  loudnessHopMs: number;
}

export class RuleContext {
  readonly words: Word[];
  readonly segments: Segment[];
  readonly sentences: Sentence[];
  readonly vad: VadRegion[];
  readonly loudness: LoudnessWindow[];
  readonly hopMs: number;
  readonly durationMs: number;
  readonly th: Thresholds;
  readonly sentenceOf: Int32Array;
  /** 幻覺段落的字：字規則一律跳過（時間仍算靜音）。 */
  readonly hallucinated: Set<number>;

  constructor(input: AnalysisInput, th: Thresholds) {
    const tr = input.transcript;
    this.words = tr.words;
    this.segments = tr.segments;
    this.sentences = tr.sentences;
    this.vad = tr.vad;
    this.loudness = input.loudness;
    this.hopMs = input.loudnessHopMs || 100;
    this.durationMs = tr.durationMs;
    this.th = th;
    this.sentenceOf = sentenceOfWord(tr.sentences, tr.words.length);
    this.hallucinated = new Set();
    for (const s of tr.segments) if (s.hallucination) for (const id of s.wordIds) this.hallucinated.add(id);
  }

  word(i: number): Word | undefined {
    return this.words[i];
  }

  skip(i: number): boolean {
    return this.hallucinated.has(i);
  }

  gapBefore(i: number): number {
    const w = this.words[i];
    const p = this.words[i - 1];
    return p ? w.startMs - p.endMs : w.startMs;
  }

  gapAfter(i: number): number {
    const w = this.words[i];
    const n = this.words[i + 1];
    return n ? n.startMs - w.endMs : this.durationMs - w.endMs;
  }

  isStandalone(i: number, gapMs = 120): boolean {
    return this.gapBefore(i) >= gapMs && this.gapAfter(i) >= gapMs;
  }

  sentenceId(i: number): number {
    return this.sentenceOf[i] ?? -1;
  }

  sentence(i: number): Sentence | undefined {
    const sid = this.sentenceId(i);
    return sid >= 0 ? this.sentences[sid] : undefined;
  }

  isSentenceStart(i: number): boolean {
    const s = this.sentence(i);
    return !!s && s.wordIds[0] === i;
  }

  isSentenceEnd(i: number): boolean {
    const s = this.sentence(i);
    return !!s && s.wordIds[s.wordIds.length - 1] === i;
  }

  prevSentenceIsQuestion(i: number): boolean {
    const sid = this.sentenceId(i);
    return sid > 0 ? this.sentences[sid - 1].endsWithQuestion : false;
  }

  /** 句子的「實詞」數（排除贅字與標點 only）。 */
  contentWordCount(sid: number, isFiller: (norm: string) => boolean): number {
    const s = this.sentences[sid];
    if (!s) return 0;
    return s.wordIds.filter((id) => {
      const n = this.words[id].norm;
      return n.length > 0 && !isFiller(n);
    }).length;
  }

  /** [fromMs,toMs] 內不在 VAD 語音區的比例（無 VAD 資料回 1）。 */
  silenceFraction(fromMs: number, toMs: number): number {
    if (toMs <= fromMs) return 1;
    if (!this.vad.length) return 1;
    let speech = 0;
    for (const r of this.vad) {
      if (r.endMs <= fromMs) continue;
      if (r.startMs >= toMs) break;
      speech += Math.min(toMs, r.endMs) - Math.max(fromMs, r.startMs);
    }
    return 1 - speech / (toMs - fromMs);
  }

  /** [fromMs,toMs] 內響度視窗的平均 momentary LUFS（無資料回 null）。 */
  meanMomentary(fromMs: number, toMs: number): number | null {
    if (!this.loudness.length) return null;
    const a = Math.max(0, Math.floor(fromMs / this.hopMs));
    const b = Math.min(this.loudness.length - 1, Math.floor(toMs / this.hopMs));
    let sum = 0;
    let n = 0;
    for (let i = a; i <= b; i++) {
      const v = this.loudness[i].momentary;
      if (v > -90) {
        sum += v;
        n += 1;
      }
    }
    return n ? sum / n : null;
  }

  wordsCandidate(kind: CandidateKind, ids: number[], score: number, reason: string, meta?: Record<string, unknown>): Candidate {
    const first = this.words[ids[0]];
    const last = this.words[ids[ids.length - 1]];
    return {
      id: candidateId(kind, first.startMs, last.endMs),
      kind,
      startMs: first.startMs,
      endMs: last.endMs,
      wordIds: ids.slice(),
      reason,
      score: Math.max(0, Math.min(0.98, score)),
      source: "rule",
      sentenceId: this.sentenceId(ids[0]),
      meta,
    };
  }

  rangeCandidate(kind: CandidateKind, startMs: number, endMs: number, score: number, reason: string, meta?: Record<string, unknown>): Candidate {
    // 落在區間內的字（給 UI 劃線）；句子取區間起點所屬
    const ids: number[] = [];
    for (const w of this.words) {
      if (w.endMs <= startMs) continue;
      if (w.startMs >= endMs) break;
      ids.push(w.id);
    }
    const sid = ids.length ? this.sentenceId(ids[0]) : this.sentenceAt(startMs);
    return {
      id: candidateId(kind, startMs, endMs),
      kind,
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      wordIds: ids,
      reason,
      score: Math.max(0, Math.min(0.98, score)),
      source: "rule",
      sentenceId: sid,
      meta,
    };
  }

  sentenceAt(ms: number): number {
    let best = -1;
    for (const s of this.sentences) {
      if (s.endMs <= ms) best = s.id;
      else break;
    }
    return best;
  }
}

export function fmtSec(ms: number): string {
  return (ms / 1000).toFixed(1);
}
