// ASR 驗證：把剪好的成品再轉寫一次，跟「EDL 說應該留下來的字」逐字比對。
// 目的不是算 WER，而是回答人機協作最在意的三個問題：
//   1) 有沒有把不該剪的字剪掉（漏字 / 半個字被吃掉）
//   2) 該剪的字是不是還留著（沒剪乾淨）
//   3) 接縫附近有沒有出問題（最容易聽出破綻的地方）
// 純函式、無 DOM / 無 I/O，可在 App、CLI、測試共用。
import type { Edl } from "./edl/build";
import { normText } from "./normalize";
import type { Transcript, Word } from "./types";

export interface ExpectedWord {
  wordId: number;
  text: string;
  norm: string;
  srcStartMs: number;
  srcEndMs: number;
  /** 在成品時間軸上的位置。 */
  outStartMs: number;
  /** 這個字之後緊接著一個接縫（剪點）。 */
  seamAfter: boolean;
}

export interface ActualWord {
  text: string;
  norm: string;
  startMs: number;
  endMs: number;
  prob: number;
}

export type FindingKind = "missing" | "extra" | "mismatch";

export interface VerifyFinding {
  kind: FindingKind;
  /** 期待的字（missing / mismatch）。 */
  expected?: string;
  /** 成品聽到的字（extra / mismatch）。 */
  actual?: string;
  /** 原始時間軸位置（可跳過去聽）。 */
  srcMs: number;
  /** 成品時間軸位置。 */
  outMs: number;
  /** 是否落在接縫 ±window 內。 */
  nearSeam: boolean;
  /** 低信心（ASR 自己也不確定）→ 可能只是辨識誤差，不一定是剪壞。 */
  lowConfidence: boolean;
}

export interface SeamCheck {
  /** 接縫在成品時間軸的位置。 */
  outMs: number;
  /** 接縫兩側的原始時間。 */
  srcBeforeMs: number;
  srcAfterMs: number;
  ok: boolean;
  findings: number;
  note: string;
}

export interface VerifyReport {
  /** 逐字對齊率 0–1（1 = 成品逐字等於預期）。 */
  matchRate: number;
  expectedChars: number;
  actualChars: number;
  findings: VerifyFinding[];
  seams: SeamCheck[];
  /** 成品實際時長 vs EDL 預估（ms）。 */
  durationDeltaMs: number | null;
  /** 一句話總結（UI 直接顯示）。 */
  summary: string;
}

/** 接縫附近多少毫秒內的問題算「接縫問題」。 */
export const SEAM_WINDOW_MS = 600;
/** 字級信心低於此值 → 標成 ASR 不確定，不算硬錯。 */
export const LOW_PROB = 0.45;

/** EDL 的保留段 → 預期留下來的字（含成品時間軸位置與接縫標記）。 */
export function expectedWords(tr: Transcript, edl: Edl): ExpectedWord[] {
  const out: ExpectedWord[] = [];
  const keeps = edl.keeps;
  for (const w of tr.words) {
    const mid = (w.startMs + w.endMs) / 2;
    const k = keeps.find((x) => mid >= x.srcStartMs && mid <= x.srcEndMs);
    if (!k) continue;
    if (!w.norm) continue;
    out.push({
      wordId: w.id,
      text: w.text,
      norm: w.norm,
      srcStartMs: w.startMs,
      srcEndMs: w.endMs,
      outStartMs: k.outStartMs + (w.startMs - k.srcStartMs),
      // 這個字是這段裡最後一個字 → 後面就是接縫（最後一段除外）
      seamAfter: w.endMs > k.srcEndMs - 120 && k !== keeps[keeps.length - 1],
    });
  }
  return out.sort((a, b) => a.outStartMs - b.outStartMs);
}

/** 成品逐字稿 → 比對用的字序列。 */
export function actualWords(tr: Transcript): ActualWord[] {
  return tr.words
    .filter((w: Word) => !!w.norm)
    .map((w) => ({ text: w.text, norm: w.norm, startMs: w.startMs, endMs: w.endMs, prob: w.prob }));
}

interface CharRef<T> {
  ch: string;
  owner: T;
}

function toChars<T extends { norm: string }>(words: T[]): CharRef<T>[] {
  const out: CharRef<T>[] = [];
  for (const w of words) for (const ch of w.norm) out.push({ ch, owner: w });
  return out;
}

export type AlignOp = { op: "eq" | "sub" | "del" | "ins"; i: number; j: number };

/**
 * 帶狀 Levenshtein 對齊（兩序列高度相似 → 只算對角線附近 band 格）。
 * band 不夠時自動加倍重試，避免長檔全 DP 爆記憶體。
 */
export function bandedAlign(a: string[], b: string[], band = 128): AlignOp[] {
  const n = a.length;
  const m = b.length;
  if (!n || !m) {
    const ops: AlignOp[] = [];
    for (let i = 0; i < n; i++) ops.push({ op: "del", i, j: -1 });
    for (let j = 0; j < m; j++) ops.push({ op: "ins", i: -1, j });
    return ops;
  }
  const maxBand = Math.max(n, m);
  let w = Math.max(band, Math.abs(n - m) + 8);
  for (;;) {
    const res = tryBand(a, b, w);
    if (res) return res;
    if (w >= maxBand) return tryBand(a, b, maxBand) ?? [];
    w = Math.min(maxBand, w * 2);
  }
}

function tryBand(a: string[], b: string[], w: number): AlignOp[] | null {
  const n = a.length;
  const m = b.length;
  const INF = Number.MAX_SAFE_INTEGER / 4;
  const width = 2 * w + 1;
  // dp[i][k]，k = j - i + w
  const dp = new Int32Array((n + 1) * width).fill(INF);
  const at = (i: number, k: number) => i * width + k;
  const setD = (i: number, j: number, v: number) => {
    const k = j - i + w;
    if (k < 0 || k >= width) return;
    dp[at(i, k)] = v;
  };
  const getD = (i: number, j: number): number => {
    const k = j - i + w;
    if (k < 0 || k >= width) return INF;
    return dp[at(i, k)];
  };
  setD(0, 0, 0);
  for (let j = 1; j <= Math.min(m, w); j++) setD(0, j, j);
  for (let i = 1; i <= n; i++) {
    const lo = Math.max(0, i - w);
    const hi = Math.min(m, i + w);
    for (let j = lo; j <= hi; j++) {
      if (j === 0) {
        setD(i, 0, i <= w ? i : INF);
        continue;
      }
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const best = Math.min(getD(i - 1, j - 1) + cost, getD(i - 1, j) + 1, getD(i, j - 1) + 1);
      setD(i, j, best);
    }
  }
  if (getD(n, m) >= INF) return null;
  // 回溯
  const ops: AlignOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const cur = getD(i, j);
    if (i > 0 && j > 0) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      if (getD(i - 1, j - 1) + cost === cur) {
        ops.push({ op: cost === 0 ? "eq" : "sub", i: i - 1, j: j - 1 });
        i--;
        j--;
        continue;
      }
    }
    if (i > 0 && getD(i - 1, j) + 1 === cur) {
      ops.push({ op: "del", i: i - 1, j: -1 });
      i--;
      continue;
    }
    if (j > 0 && getD(i, j - 1) + 1 === cur) {
      ops.push({ op: "ins", i: -1, j: j - 1 });
      j--;
      continue;
    }
    break;
  }
  return ops.reverse();
}

export interface VerifyOptions {
  /** 成品實際時長（有的話會比對 EDL 預估）。 */
  outDurationMs?: number | null;
  /** 期待時長（EDL keptMs）。 */
  expectedDurationMs?: number | null;
}

/** 預期字序列 × 成品字序列 → 驗證報告。 */
export function verifyEdit(expected: ExpectedWord[], actual: ActualWord[], edl: Edl, opts: VerifyOptions = {}): VerifyReport {
  const ea = toChars(expected);
  const aa = toChars(actual);
  const ops = bandedAlign(
    ea.map((c) => c.ch),
    aa.map((c) => c.ch),
  );

  const seams = edl.keeps
    .slice(0, -1)
    .map((k, idx) => ({ outMs: k.outEndMs, srcBeforeMs: k.srcEndMs, srcAfterMs: edl.keeps[idx + 1]?.srcStartMs ?? k.srcEndMs }));
  const nearSeam = (outMs: number) => seams.some((s) => Math.abs(s.outMs - outMs) <= SEAM_WINDOW_MS);

  // 逐字合併連續的同類操作 → 以「字」為單位回報
  const findings: VerifyFinding[] = [];
  let eq = 0;
  const pushMissing = (owner: ExpectedWord) => {
    const last = findings[findings.length - 1];
    if (last?.kind === "missing" && last.expected === owner.text && Math.abs(last.outMs - owner.outStartMs) < 1) return;
    findings.push({
      kind: "missing",
      expected: owner.text,
      srcMs: owner.srcStartMs,
      outMs: owner.outStartMs,
      nearSeam: nearSeam(owner.outStartMs),
      lowConfidence: false,
    });
  };
  const pushExtra = (owner: ActualWord) => {
    const last = findings[findings.length - 1];
    if (last?.kind === "extra" && last.actual === owner.text && Math.abs(last.outMs - owner.startMs) < 1) return;
    findings.push({
      kind: "extra",
      actual: owner.text,
      srcMs: mapOut(edl, owner.startMs),
      outMs: owner.startMs,
      nearSeam: nearSeam(owner.startMs),
      lowConfidence: owner.prob < LOW_PROB,
    });
  };

  for (const op of ops) {
    if (op.op === "eq") {
      eq += 1;
      continue;
    }
    if (op.op === "del") {
      pushMissing(ea[op.i].owner);
      continue;
    }
    if (op.op === "ins") {
      pushExtra(aa[op.j].owner);
      continue;
    }
    // sub：兩邊都有字但不一樣 → 多半是 ASR 聽錯，只在低信心時降級成提示
    const e = ea[op.i].owner;
    const a = aa[op.j].owner;
    findings.push({
      kind: "mismatch",
      expected: e.text,
      actual: a.text,
      srcMs: e.srcStartMs,
      outMs: a.startMs,
      nearSeam: nearSeam(a.startMs),
      lowConfidence: a.prob < LOW_PROB,
    });
  }

  const expectedChars = ea.length;
  const actualChars = aa.length;
  const matchRate = expectedChars ? eq / expectedChars : actualChars ? 0 : 1;

  const seamChecks: SeamCheck[] = seams.map((s) => {
    const hits = findings.filter((f) => Math.abs(f.outMs - s.outMs) <= SEAM_WINDOW_MS && !f.lowConfidence);
    const hard = hits.filter((f) => f.kind !== "mismatch");
    return {
      outMs: s.outMs,
      srcBeforeMs: s.srcBeforeMs,
      srcAfterMs: s.srcAfterMs,
      ok: hard.length === 0,
      findings: hits.length,
      note: hard.length === 0 ? (hits.length ? "接縫附近有辨識差異，多半是 ASR 聽錯" : "接得乾淨") : summarizeHits(hard),
    };
  });

  const durationDeltaMs = opts.outDurationMs != null && opts.expectedDurationMs != null ? Math.round(opts.outDurationMs - opts.expectedDurationMs) : null;

  const missing = findings.filter((f) => f.kind === "missing").length;
  const extra = findings.filter((f) => f.kind === "extra" && !f.lowConfidence).length;
  const badSeams = seamChecks.filter((s) => !s.ok).length;
  const summary =
    missing === 0 && extra === 0 && badSeams === 0
      ? `逐字對齊 ${(matchRate * 100).toFixed(1)}%：沒有漏字、沒有該剪沒剪，${seamChecks.length} 個接縫都乾淨`
      : `逐字對齊 ${(matchRate * 100).toFixed(1)}%：漏字 ${missing}、該剪沒剪 ${extra}、可疑接縫 ${badSeams} / ${seamChecks.length}`;

  return { matchRate, expectedChars, actualChars, findings, seams: seamChecks, durationDeltaMs, summary };
}

function summarizeHits(hits: VerifyFinding[]): string {
  const miss = hits.filter((h) => h.kind === "missing").map((h) => h.expected);
  const extra = hits.filter((h) => h.kind === "extra").map((h) => h.actual);
  const parts: string[] = [];
  if (miss.length) parts.push(`漏了「${miss.slice(0, 4).join("")}」`);
  if (extra.length) parts.push(`多了「${extra.slice(0, 4).join("")}」`);
  return parts.join("、") || "接縫附近有差異";
}

/** 成品時間 → 原始時間（給 UI 跳轉用；不依賴 build.ts 的匯出以免循環）。 */
function mapOut(edl: Edl, outMs: number): number {
  for (const k of edl.keeps) {
    if (outMs < k.outStartMs) return k.srcStartMs;
    if (outMs <= k.outEndMs) return k.srcStartMs + (outMs - k.outStartMs);
  }
  const last = edl.keeps[edl.keeps.length - 1];
  return last ? last.srcEndMs : 0;
}

/** 把 ASR 回來的字正規化（跟 normalize.ts 同一套）。 */
export function normalizeForCompare(s: string): string {
  return normText(s);
}
