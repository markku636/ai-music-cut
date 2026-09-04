// 口吃 / 重複片語 / 未講完即重講（restart）。
import { AFFIRMATION, REDUP_WHITELIST, SELF_CORRECTION, isAnyFiller } from "../lexicon";
import type { Candidate } from "../types";
import type { RuleContext } from "./context";

/** 字元級 LCS 長度。 */
export function lcsLen(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[b.length];
}

export function repeatRule(ctx: RuleContext): Candidate[] {
  const out: Candidate[] = [];
  const words = ctx.words;
  const used = new Uint8Array(words.length);
  const th = ctx.th;

  // 1) 連續同字口吃：我 我 我覺得 → 剪前 k-1 個，留最後一個
  let i = 0;
  while (i < words.length) {
    if (ctx.skip(i) || !words[i].norm) {
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < words.length && words[j + 1].norm === words[i].norm && !ctx.skip(j + 1) && ctx.gapBefore(j + 1) <= th.stutterMaxGapMs) j += 1;
    const k = j - i + 1;
    if (k >= 2) {
      const norm = words[i].norm;
      const joined = norm.repeat(2);
      const whitelisted = REDUP_WHITELIST.has(joined) || REDUP_WHITELIST.has(norm) || (k === 2 && REDUP_WHITELIST.has(norm + norm));
      if (!whitelisted) {
        const ids = Array.from({ length: k - 1 }, (_, x) => i + x);
        const affirmation = AFFIRMATION.has(norm);
        out.push(
          ctx.wordsCandidate("stutter", ids, affirmation ? 0.6 : 0.9, affirmation ? `附和語「${norm}」重複 ${k} 次，保留一個` : `口吃重複「${norm}」×${k}，保留最後一次`),
        );
        for (let x = i; x <= j; x++) used[x] = 1;
      }
      i = j + 1;
      continue;
    }
    i += 1;
  }

  // 2) n-gram 重複片語（n=6..2）：S1 後緊接 S2 相同 → 剪 S1（含中間的贅字 / 停頓）
  for (let n = 6; n >= 2; n--) {
    for (let a = 0; a + 2 * n <= words.length; a++) {
      if (used[a] || ctx.skip(a) || !words[a].norm) continue;
      const seq = words.slice(a, a + n).map((w) => w.norm);
      if (seq.some((s) => !s) || seq.slice(a, a + n).some((_, k) => used[a + k])) continue;
      const endA = words[a + n - 1].endMs;
      for (let b = a + n; b + n <= words.length; b++) {
        if (words[b].startMs - endA > th.ngramRepeatMaxGapMs) break;
        let same = true;
        for (let k = 0; k < n; k++) {
          if (words[b + k].norm !== seq[k] || used[b + k]) {
            same = false;
            break;
          }
        }
        if (!same) continue;
        // 中間（a+n .. b-1）只能是贅字才算 restart 式重複
        let between = true;
        for (let k = a + n; k < b; k++) if (!isAnyFiller(words[k].norm) && words[k].norm) between = false;
        if (!between) continue;
        const ids = Array.from({ length: b - a }, (_, x) => a + x);
        // 中間夾贅字或停頓 → 是「講到一半重講」；緊貼重複 → 口吃式重複片語
        const hasBreak = b > a + n || words[b].startMs - endA >= 250;
        out.push(
          hasBreak
            ? ctx.wordsCandidate("restart", ids, 0.9, `未講完即重講：「${seq.join("")}」，保留後一次`, { overlap: 1 })
            : ctx.wordsCandidate("stutter", ids, 0.85, `重複片語「${seq.join("")}」，保留後一次`),
        );
        for (let x = a; x < b + n; x++) used[x] = 1;
        break;
      }
    }
  }

  // 3) restart：句首 / 停頓後的短片段 P1 中斷後，緊接的 P2 與 P1 高度重疊 → 剪 P1
  for (let s = 0; s < words.length; s++) {
    if (used[s] || ctx.skip(s) || !words[s].norm) continue;
    const phraseStart = s === 0 || ctx.isSentenceStart(s) || ctx.gapBefore(s) >= 300;
    if (!phraseStart) continue;
    // P1：直到中斷（停頓 ≥250 / 贅字 / 低信心 / 自我修正詞）
    let e = s;
    let breakAt = -1;
    let breakKind = "";
    while (e < words.length) {
      const w = words[e];
      if (e > s && (isAnyFiller(w.norm) || SELF_CORRECTION.has(w.norm) || w.prob < 0.5)) {
        breakAt = e;
        breakKind = SELF_CORRECTION.has(w.norm) ? "self" : "filler";
        break;
      }
      if (ctx.gapAfter(e) >= 250) {
        breakAt = e + 1;
        breakKind = "pause";
        break;
      }
      e += 1;
    }
    if (breakAt < 0) continue;
    const p1Ids = Array.from({ length: breakAt - s }, (_, x) => s + x).filter((x) => !(breakKind !== "pause" && x === breakAt));
    if (!p1Ids.length) continue;
    const p1 = p1Ids.map((x) => words[x].norm).join("");
    const p1Dur = words[p1Ids[p1Ids.length - 1]].endMs - words[s].startMs;
    if (p1.length < 2 || p1Dur > 3000) continue;
    // P2：中斷之後（跳過贅字 / 修正詞）取 chars(P1)+4 字
    let q = breakKind === "pause" ? breakAt : breakAt + 1;
    while (q < words.length && (isAnyFiller(words[q].norm) || SELF_CORRECTION.has(words[q].norm) || !words[q].norm)) q += 1;
    let p2 = "";
    let qEnd = q;
    while (qEnd < words.length && p2.length < p1.length + 4) {
      p2 += words[qEnd].norm;
      qEnd += 1;
    }
    if (!p2) continue;
    const overlap = lcsLen(p1, p2) / p1.length;
    if (overlap < th.restartMinOverlap) continue;
    const selfCorrection = breakKind === "self";
    const ids = p1Ids.slice();
    for (let x = p1Ids[p1Ids.length - 1] + 1; x < q; x++) ids.push(x); // 含中斷處的贅字 / 修正詞
    if (p1.length > th.restartMaxChars) {
      out.push(ctx.wordsCandidate("rambling", ids, 0.4, `講到一半重講（${p1.length} 字），較長，請確認：「${p1}」`, { overlap }));
    } else {
      const score = Math.min(selfCorrection ? 0.7 : 0.95, 0.5 + 0.4 * overlap);
      out.push(
        ctx.wordsCandidate("restart", ids, score, selfCorrection ? `自我修正後重講：「${p1}」→「${p2.slice(0, p1.length + 2)}」（語意可能不同）` : `未講完即重講：「${p1}」→「${p2.slice(0, p1.length + 2)}」`, {
          overlap,
          selfCorrection,
        }),
      );
    }
    for (const x of ids) used[x] = 1;
  }
  return out;
}
