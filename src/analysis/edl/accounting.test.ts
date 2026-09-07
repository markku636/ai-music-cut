// EDL 的成品時間帳：隨機輸入下的不變式。
//
// 為什麼要有這一份：`buildEdl` 產出的 `outStartMs / outEndMs / stats.outMs` 是**整個
// 下游的地基** —— 字幕、章節、標記、分割輸出、驗收、A-B 切換全部靠它換算時間。而
// build.test.ts 原本一個斷言都沒碰過這三個欄位（只驗剪除區間與接點種類），
// 也就是說地基本身沒有測試網。
//
// 這裡不寫特定案例，寫**帳要平**：
//   1. 保留段在來源時間上遞增、不重疊
//   2. 每兩段之間的成品時間落差 == 那個接點宣告的量（gap 往後推、crossfade 往前疊）
//   3. 段長總和 + gap 總量 − crossfade 總量 == stats.outMs
//   4. 第一段從成品 0 開始
//   5. 保留區內 mapSrcToOut / mapOutToSrc 互為反函式
//
// 隨機輸入比手寫案例強得多：手寫的只覆蓋到想得到的組合，而會出事的正是想不到的那些。
import { describe, expect, it } from "vitest";
import { buildEdl, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE, type EdlInput } from "./build";
// **注意有兩支同名的 mapSrcToOut**：build.ts 那支收整個 Edl、剪除區回 null；
// map.ts 這支收 keeps、剪除區會靠到鄰段。產品程式碼（字幕 / 章節 / 分割輸出）用的是
// 後者，所以測試也要測後者。
import { mapOutToSrc, mapSrcToOut } from "./map";
import type { Candidate, DecisionMap, Sentence, Word } from "../types";
import { candidateId } from "../types";

/** 可重現的偽亂數（測試失敗時要能用 seed 重跑同一組）。 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Case {
  input: EdlInput;
  candidates: Candidate[];
  decisions: DecisionMap;
}

/** 造一集：連續的字、每 6 個字一句，再隨機挑幾段剪掉。 */
function makeCase(seed: number): Case {
  const r = rng(seed);
  const nWords = 20 + Math.floor(r() * 60);
  const words: Word[] = [];
  let t = Math.floor(r() * 500);
  for (let i = 0; i < nWords; i++) {
    const dur = 120 + Math.floor(r() * 400);
    const gap = r() < 0.25 ? 200 + Math.floor(r() * 1500) : Math.floor(r() * 80);
    t += gap;
    words.push({ id: i, segId: 0, text: `w${i}`, norm: `w${i}`, startMs: t, endMs: t + dur, prob: 0.9 });
    t += dur;
  }
  const durationMs = t + 500 + Math.floor(r() * 2000);

  const sentences: Sentence[] = [];
  for (let i = 0; i < words.length; i += 6) {
    const ids = words.slice(i, i + 6).map((w) => w.id);
    sentences.push({
      id: sentences.length,
      wordIds: ids,
      startMs: words[ids[0]].startMs,
      endMs: words[ids[ids.length - 1]].endMs,
      endsWithQuestion: false,
    });
  }

  // VAD：把每個字當語音區（近似），讓靜音判斷有東西可用
  const vad = words.map((w) => ({ startMs: w.startMs, endMs: w.endMs }));

  const candidates: Candidate[] = [];
  const decisions: DecisionMap = {};
  const nCut = 1 + Math.floor(r() * 8);
  for (let k = 0; k < nCut; k++) {
    const i = Math.floor(r() * words.length);
    const len = 1 + Math.floor(r() * 3);
    const ids = words.slice(i, i + len).map((w) => w.id);
    if (!ids.length) continue;
    const s = words[ids[0]].startMs;
    const e = words[ids[ids.length - 1]].endMs;
    const id = candidateId("filler", s, e);
    if (decisions[id]) continue;
    candidates.push({ id, kind: "filler", startMs: s, endMs: e, wordIds: ids, reason: "", score: 0.9, source: "rule", sentenceId: 0 });
    decisions[id] = { state: "auto", origin: "rule", at: "" };
  }
  return { input: { words, sentences, vad, durationMs }, candidates, decisions };
}

/** 接點宣告的成品時間位移：gap 往後推、crossfade 往前疊、seam 不動。 */
function declaredShift(kind: string, ms: number): number {
  if (kind === "gap") return ms;
  if (kind === "crossfade") return -ms;
  return 0;
}

describe("EDL 成品時間帳（隨機輸入）", () => {
  const SEEDS = Array.from({ length: 60 }, (_, i) => i * 7919 + 13);

  it("保留段在來源時間上遞增且不重疊（**沒有貼上時**才成立）", () => {
    for (const seed of SEEDS) {
      const c = makeCase(seed);
      const { keeps } = buildEdl(c.input, c.candidates, c.decisions, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE);
      for (let i = 0; i < keeps.length; i++) {
        expect(keeps[i].srcEndMs, `seed ${seed} keep ${i}`).toBeGreaterThan(keeps[i].srcStartMs);
        if (i) expect(keeps[i].srcStartMs, `seed ${seed} keep ${i}`).toBeGreaterThanOrEqual(keeps[i - 1].srcEndMs);
      }
    }
  });

  it("**每個接點的成品落差都等於它宣告的量**（帳要對得起來）", () => {
    for (const seed of SEEDS) {
      const c = makeCase(seed);
      const edl = buildEdl(c.input, c.candidates, c.decisions, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE);
      for (let i = 1; i < edl.keeps.length; i++) {
        const j = edl.joins[i - 1];
        const actual = edl.keeps[i].outStartMs - edl.keeps[i - 1].outEndMs;
        expect(actual, `seed ${seed} join ${i - 1} (${j?.kind})`).toBeCloseTo(declaredShift(j?.kind ?? "", j?.ms ?? 0), 3);
      }
    }
  });

  it("**段長總和 + gap − crossfade == 成品長度**", () => {
    for (const seed of SEEDS) {
      const c = makeCase(seed);
      const edl = buildEdl(c.input, c.candidates, c.decisions, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE);
      if (!edl.keeps.length) continue;
      const segSum = edl.keeps.reduce((s, k) => s + (k.srcEndMs - k.srcStartMs), 0);
      const gap = edl.joins.filter((j) => j.kind === "gap").reduce((s, j) => s + j.ms, 0);
      const xf = edl.joins.filter((j) => j.kind === "crossfade").reduce((s, j) => s + j.ms, 0);
      expect(segSum + gap - xf, `seed ${seed}`).toBeCloseTo(edl.stats.outMs, 3);
    }
  });

  it("第一段從成品 0 開始，最後一段的結尾就是成品長度", () => {
    for (const seed of SEEDS) {
      const c = makeCase(seed);
      const edl = buildEdl(c.input, c.candidates, c.decisions, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE);
      if (!edl.keeps.length) continue;
      expect(edl.keeps[0].outStartMs, `seed ${seed}`).toBeCloseTo(0, 3);
      expect(edl.keeps[edl.keeps.length - 1].outEndMs, `seed ${seed}`).toBeCloseTo(edl.stats.outMs, 3);
    }
  });

  it("每一段的成品長度 == 來源長度（純剪接不改變段內時間）", () => {
    for (const seed of SEEDS) {
      const c = makeCase(seed);
      const { keeps } = buildEdl(c.input, c.candidates, c.decisions, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE);
      for (const [i, k] of keeps.entries()) {
        expect(k.outEndMs - k.outStartMs, `seed ${seed} keep ${i}`).toBeCloseTo(k.srcEndMs - k.srcStartMs, 3);
      }
    }
  });

  it("成品時間隨保留段遞增（mapOutToSrc 靠線性掃描，重疊或倒退就會給錯答案）", () => {
    for (const seed of SEEDS) {
      const c = makeCase(seed);
      const { keeps } = buildEdl(c.input, c.candidates, c.decisions, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE);
      for (let i = 1; i < keeps.length; i++) {
        expect(keeps[i].outStartMs, `seed ${seed} keep ${i}`).toBeGreaterThanOrEqual(keeps[i - 1].outStartMs);
      }
    }
  });

  it("保留區內來源 ↔ 成品互為反函式（避開交越重疊）", () => {
    for (const seed of SEEDS) {
      const c = makeCase(seed);
      const { keeps } = buildEdl(c.input, c.candidates, c.decisions, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE);
      for (const k of keeps) {
        const len = k.srcEndMs - k.srcStartMs;
        // 離兩端 50ms 以上（交越最長 24ms，見 DEFAULT_EDL_OPTIONS）
        if (len < 120) continue;
        for (const at of [50, len / 2, len - 50]) {
          const src = k.srcStartMs + at;
          const back = mapOutToSrc(keeps, mapSrcToOut(keeps, src));
          expect(back, `seed ${seed} src ${src}`).toBeCloseTo(src, 3);
        }
      }
    }
  });

  it("**交越重疊處的換算本來就不是一對一**：一個成品瞬間對應到兩段來源（兩邊都在響）", () => {
    // 這不是 bug，是交叉淡化的本質。mapOutToSrc 會回**前一段**的來源時間 ——
    // 呼叫端（字幕、章節、跳播）在接縫上不能假設換算可逆。
    let sawOverlap = false;
    for (const seed of SEEDS) {
      const c = makeCase(seed);
      const edl = buildEdl(c.input, c.candidates, c.decisions, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE);
      for (let i = 1; i < edl.keeps.length; i++) {
        const j = edl.joins[i - 1];
        if (j?.kind !== "crossfade" || j.ms <= 0) continue;
        sawOverlap = true;
        // 重疊區確實存在：後一段的成品起點早於前一段的成品終點
        expect(edl.keeps[i].outStartMs, `seed ${seed} join ${i - 1}`).toBeLessThan(edl.keeps[i - 1].outEndMs);
        // 落在重疊區的成品時間，會被解讀成前一段
        const mid = edl.keeps[i].outStartMs + Math.min(1, j.ms / 2);
        expect(mapOutToSrc(edl.keeps, mid), `seed ${seed}`).toBeLessThanOrEqual(edl.keeps[i - 1].srcEndMs);
      }
    }
    expect(sawOverlap, "隨機輸入裡應該要出現交越").toBe(true);
  });

  it("成品長度不會超過來源長度（剪掉的只會變短）", () => {
    for (const seed of SEEDS) {
      const c = makeCase(seed);
      const edl = buildEdl(c.input, c.candidates, c.decisions, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE);
      expect(edl.stats.outMs, `seed ${seed}`).toBeLessThanOrEqual(c.input.durationMs + 1);
    }
  });

  it("什麼都不剪的時候，成品時間就是來源時間", () => {
    for (const seed of SEEDS.slice(0, 20)) {
      const c = makeCase(seed);
      const { keeps } = buildEdl(c.input, [], {}, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE);
      expect(keeps.length, `seed ${seed}`).toBe(1);
      expect(mapSrcToOut(keeps, keeps[0].srcStartMs + 100), `seed ${seed}`).toBeCloseTo(100, 3);
    }
  });
});

/**
 * 帶貼上的隨機案例。
 *
 * v0.97 之後 keeps 可能不照來源排序、同一段來源可能出現兩次，
 * 而上面那 60 seeds × 10 條性質**完全沒有覆蓋這個情況** —— 它們是假的綠燈。
 * 這一組專門補那個洞：帳務不變式（成品長度、接點落差）在重排後同樣必須成立。
 */
function withPastes(seed: number): { input: EdlInput; candidates: Candidate[]; decisions: DecisionMap } {
  const c = makeCase(seed);
  const dur = c.input.durationMs;
  const rnd = rng(seed ^ 0x5eed);
  const n = 1 + Math.floor(rnd() * 2);
  const pastes = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor(rnd() * dur * 0.6);
    const len = 200 + Math.floor(rnd() * 800);
    const at = Math.floor(rnd() * dur);
    pastes.push({ id: `p${i}`, srcStartMs: a, srcEndMs: Math.min(dur, a + len), atMs: at });
  }
  return { ...c, input: { ...c.input, pastes } };
}

describe("EDL 成品時間帳（帶貼上 / 搬移的隨機輸入）", () => {
  const SEEDS = Array.from({ length: 40 }, (_, i) => i * 6151 + 29);

  it("成品總長 = 各段長度總和 + gap − crossfade", () => {
    for (const seed of SEEDS) {
      const c = withPastes(seed);
      const edl = buildEdl(c.input, c.candidates, c.decisions, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE);
      const segSum = edl.keeps.reduce((n2, k) => n2 + (k.srcEndMs - k.srcStartMs), 0);
      const gaps = edl.joins.filter((j) => j.kind === "gap").reduce((n2, j) => n2 + j.ms, 0);
      const xf = edl.joins.filter((j) => j.kind === "crossfade").reduce((n2, j) => n2 + j.ms, 0);
      expect(Math.abs(segSum + gaps - xf - edl.stats.outMs), `seed ${seed}`).toBeLessThanOrEqual(3);
    }
  });

  it("成品時間嚴格遞增（順序是成品順序，不是來源順序）", () => {
    for (const seed of SEEDS) {
      const c = withPastes(seed);
      const { keeps } = buildEdl(c.input, c.candidates, c.decisions, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE);
      for (let i = 1; i < keeps.length; i++) {
        expect(keeps[i].outStartMs, `seed ${seed} keep ${i}`).toBeGreaterThan(keeps[i - 1].outStartMs);
      }
    }
  });

  it("每一段都有正的長度（不能出現長度為零或負的段）", () => {
    for (const seed of SEEDS) {
      const c = withPastes(seed);
      const { keeps } = buildEdl(c.input, c.candidates, c.decisions, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE);
      for (const k of keeps) expect(k.srcEndMs, `seed ${seed}`).toBeGreaterThan(k.srcStartMs);
    }
  });

  it("**有貼上就一定要標記 rearranged**（下游靠這個旗標擋住輸出）", () => {
    for (const seed of SEEDS) {
      const c = withPastes(seed);
      const edl = buildEdl(c.input, c.candidates, c.decisions, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE);
      expect(edl.rearranged, `seed ${seed}`).toBe(true);
    }
  });

  it("沒有貼上時 rearranged 必須是 false（否則會把正常專案也擋掉）", () => {
    for (const seed of SEEDS) {
      const c = makeCase(seed);
      const edl = buildEdl(c.input, c.candidates, c.decisions, DEFAULT_EDL_OPTIONS, MIDPOINT_PROBE);
      expect(edl.rearranged, `seed ${seed}`).toBe(false);
    }
  });
});
