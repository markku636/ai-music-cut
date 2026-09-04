// 含糊 / 聽不清：低信心字串、段級品質訊號、音量明顯偏小。一律只當「建議」（SUGGEST_ONLY_KINDS）。
import type { Candidate } from "../types";
import type { RuleContext } from "./context";

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function unclearRule(ctx: RuleContext): Candidate[] {
  const out: Candidate[] = [];
  const words = ctx.words;
  const th = ctx.th;

  // 1) 連續低信心字
  let i = 0;
  while (i < words.length) {
    if (ctx.skip(i) || !words[i].norm) {
      i += 1;
      continue;
    }
    if (words[i].prob < th.unclearWordProb) {
      let j = i;
      while (j + 1 < words.length && !ctx.skip(j + 1) && words[j + 1].prob < th.unclearWordProb && ctx.gapBefore(j + 1) < 600) j += 1;
      const n = j - i + 1;
      const w = words[i];
      if (n >= th.unclearMinRun || (n === 1 && w.prob < 0.3 && w.endMs - w.startMs > 300)) {
        const ids = Array.from({ length: n }, (_, x) => i + x);
        const mean = ids.reduce((s, id) => s + words[id].prob, 0) / n;
        out.push(ctx.wordsCandidate("unclear", ids, 0.6, `辨識信心低（平均 ${mean.toFixed(2)}），語音可能含糊`, { meanProb: mean }));
      }
      i = j + 1;
      continue;
    }
    i += 1;
  }

  // 2) 段級訊號
  for (const seg of ctx.segments) {
    if (seg.hallucination || !seg.wordIds.length) continue;
    if (seg.compressionRatio > 2.4) {
      out.push(ctx.wordsCandidate("unclear", seg.wordIds, 0.7, `整段辨識異常（壓縮比 ${seg.compressionRatio.toFixed(2)}，疑似重複 / 幻覺）`));
    } else if (seg.avgLogprob < -1.0 || seg.noSpeechProb > 0.6) {
      out.push(
        ctx.wordsCandidate("unclear", seg.wordIds, 0.55, seg.avgLogprob < -1.0 ? `整段辨識信心低（logprob ${seg.avgLogprob.toFixed(2)}）` : `整段疑似非語音（no_speech ${seg.noSpeechProb.toFixed(2)}）`),
      );
    }
  }

  // 3) 音量明顯偏小（相對講者中位數）
  if (ctx.loudness.length) {
    const speechLevels: number[] = [];
    for (const w of words) {
      if (ctx.skip(w.id)) continue;
      const m = ctx.meanMomentary(w.startMs, w.endMs);
      if (m != null) speechLevels.push(m);
    }
    const ref = median(speechLevels);
    if (ref != null) {
      let k = 0;
      while (k < words.length) {
        const w = words[k];
        if (ctx.skip(k) || w.endMs - w.startMs < 200) {
          k += 1;
          continue;
        }
        const m = ctx.meanMomentary(w.startMs, w.endMs);
        if (m != null && m < ref - th.unclearQuietLu) {
          let j = k;
          while (j + 1 < words.length) {
            const mn = ctx.meanMomentary(words[j + 1].startMs, words[j + 1].endMs);
            if (mn != null && mn < ref - th.unclearQuietLu && ctx.gapBefore(j + 1) < 600) j += 1;
            else break;
          }
          const ids = Array.from({ length: j - k + 1 }, (_, x) => k + x);
          out.push(ctx.wordsCandidate("unclear", ids, 0.5, `音量明顯偏小（比平均低 ${(ref - m).toFixed(0)} LU），可能聽不清`, { lu: ref - m }));
          k = j + 1;
          continue;
        }
        k += 1;
      }
    }
  }
  return out;
}
