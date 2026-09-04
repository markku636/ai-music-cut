// 雜音：非語音區高於底噪的聲響（咳嗽 / 碰撞）、Whisper 非語音標記。
import { NON_SPEECH_RE } from "../lexicon";
import type { Candidate } from "../types";
import { fmtSec, type RuleContext } from "./context";

function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}

export function noiseRule(ctx: RuleContext): Candidate[] {
  const out: Candidate[] = [];

  // 1) Whisper 非語音標記 [音樂] (笑聲) ♪
  for (const w of ctx.words) {
    if (NON_SPEECH_RE.test(w.text)) out.push(ctx.wordsCandidate("noise", [w.id], 0.5, `非語音標記 ${w.text.trim()}`));
  }

  // 2) VAD 非語音區的響亮視窗
  if (!ctx.loudness.length || !ctx.vad.length) return out;
  const hop = ctx.hopMs;
  const nonSpeech: number[] = [];
  const isSpeech = new Uint8Array(ctx.loudness.length);
  for (const r of ctx.vad) {
    const a = Math.max(0, Math.floor(r.startMs / hop));
    const b = Math.min(ctx.loudness.length - 1, Math.ceil(r.endMs / hop));
    for (let i = a; i <= b; i++) isSpeech[i] = 1;
  }
  for (let i = 0; i < ctx.loudness.length; i++) {
    if (!isSpeech[i] && ctx.loudness[i].momentary > -90) nonSpeech.push(ctx.loudness[i].momentary);
  }
  const floor = percentile(nonSpeech, 0.1);
  if (floor == null) return out;
  const thr = floor + ctx.th.noiseAboveFloorLu;
  const minRun = Math.ceil(300 / hop);
  let i = 0;
  while (i < ctx.loudness.length) {
    if (isSpeech[i] || ctx.loudness[i].momentary <= thr) {
      i += 1;
      continue;
    }
    let j = i;
    while (j + 1 < ctx.loudness.length && !isSpeech[j + 1] && ctx.loudness[j + 1].momentary > thr) j += 1;
    if (j - i + 1 >= minRun) {
      const start = i * hop;
      const end = (j + 1) * hop;
      const peak = Math.max(...ctx.loudness.slice(i, j + 1).map((w) => w.momentary));
      out.push(ctx.rangeCandidate("noise", start, end, 0.6, `非語音區有明顯聲響（${fmtSec(end - start)} 秒，高於底噪 ${(peak - floor).toFixed(0)} LU）`));
    }
    i = j + 1;
  }
  return out;
}
