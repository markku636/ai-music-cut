// 把逐字稿切成判讀視窗：核心句（要判的候選）+ 前後幾句語境（只讀不判）。視窗不重疊 → 結果不用合併衝突。
import type { Candidate, Transcript } from "../types";
import { JUDGE_SCHEMA_VERSION } from "./schema";

export interface JudgeWindow {
  id: string;
  coreSentenceIds: number[];
  contextBefore: number[];
  contextAfter: number[];
  candidateIds: string[];
  /** 內容雜湊（文字 + 候選 id + schema 版本）：同雜湊可沿用快取結果。 */
  hash: string;
}

export interface WindowOpts {
  maxSentences: number;
  maxChars: number;
  context: number;
}

export const DEFAULT_WINDOW_OPTS: WindowOpts = { maxSentences: 40, maxChars: 2500, context: 3 };

/** FNV-1a 32-bit（夠用來做快取鍵）。 */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function sentenceText(tr: Transcript, sid: number): string {
  const s = tr.sentences[sid];
  return s ? s.wordIds.map((id) => tr.words[id].text).join("") : "";
}

/** 只判有候選的句子；沒有任何候選的長段落會被跳過（省 token）。 */
export function makeWindows(tr: Transcript, candidates: Candidate[], opts: WindowOpts = DEFAULT_WINDOW_OPTS): JudgeWindow[] {
  const bySentence = new Map<number, Candidate[]>();
  for (const c of candidates) {
    const sid = c.sentenceId >= 0 ? c.sentenceId : sentenceAt(tr, c.startMs);
    if (sid < 0) continue;
    const arr = bySentence.get(sid) ?? [];
    arr.push(c);
    bySentence.set(sid, arr);
  }
  const out: JudgeWindow[] = [];
  let core: number[] = [];
  let chars = 0;
  const flush = () => {
    if (!core.length) return;
    const first = core[0];
    const last = core[core.length - 1];
    const before = [];
    for (let i = Math.max(0, first - opts.context); i < first; i++) before.push(i);
    const after = [];
    for (let i = last + 1; i <= Math.min(tr.sentences.length - 1, last + opts.context); i++) after.push(i);
    const candidateIds = core.flatMap((sid) => (bySentence.get(sid) ?? []).map((c) => c.id));
    const text = [...before, ...core, ...after].map((sid) => sentenceText(tr, sid)).join("|");
    const hash = hashString(`${JUDGE_SCHEMA_VERSION}|${text}|${candidateIds.join(",")}`);
    out.push({ id: `W${out.length + 1}`, coreSentenceIds: core, contextBefore: before, contextAfter: after, candidateIds, hash });
    core = [];
    chars = 0;
  };
  for (const s of tr.sentences) {
    const len = sentenceText(tr, s.id).length;
    // 沒候選的句子：若目前視窗已開始就當語境帶著（維持連貫），否則跳過
    if (!bySentence.has(s.id) && !core.length) continue;
    if (core.length >= opts.maxSentences || (chars + len > opts.maxChars && core.length > 0)) flush();
    core.push(s.id);
    chars += len;
  }
  flush();
  // 去掉尾端沒有候選的句子（純語境已由 contextAfter 提供）
  for (const w of out) {
    while (w.coreSentenceIds.length && !bySentence.has(w.coreSentenceIds[w.coreSentenceIds.length - 1])) w.coreSentenceIds.pop();
  }
  return out.filter((w) => w.candidateIds.length > 0);
}

function sentenceAt(tr: Transcript, ms: number): number {
  let best = -1;
  for (const s of tr.sentences) {
    if (s.startMs <= ms) best = s.id;
    else break;
  }
  return best;
}
