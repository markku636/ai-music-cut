// 長停頓（縮短、不整段刪）、開頭 / 結尾靜音。停頓中若有聲響 → 交給 noise。
import type { Candidate } from "../types";
import { fmtSec, type RuleContext } from "./context";

export function pauseRule(ctx: RuleContext): Candidate[] {
  const out: Candidate[] = [];
  const words = ctx.words;
  const th = ctx.th;
  if (!words.length) {
    if (ctx.durationMs > th.leadTrailKeepMs * 2 + 1000) {
      out.push(ctx.rangeCandidate("long_pause", th.leadTrailKeepMs, ctx.durationMs - th.leadTrailKeepMs, 0.5, "整段無語音"));
    }
    return out;
  }
  const keep = th.pauseKeepMs;

  // 開頭靜音
  const first = words[0];
  if (first.startMs > th.leadTrailKeepMs + 200) {
    out.push(ctx.rangeCandidate("long_pause", 0, first.startMs - th.leadTrailKeepMs, 0.9, `開頭靜音 ${fmtSec(first.startMs)} 秒，保留 ${fmtSec(th.leadTrailKeepMs)} 秒`));
  }
  // 結尾靜音
  const last = words[words.length - 1];
  if (ctx.durationMs - last.endMs > th.leadTrailKeepMs + 200) {
    out.push(
      ctx.rangeCandidate("long_pause", last.endMs + th.leadTrailKeepMs, ctx.durationMs, 0.9, `結尾靜音 ${fmtSec(ctx.durationMs - last.endMs)} 秒，保留 ${fmtSec(th.leadTrailKeepMs)} 秒`),
    );
  }

  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i];
    const b = words[i + 1];
    const gap = b.startMs - a.endMs;
    const between = ctx.sentenceId(i) !== ctx.sentenceId(i + 1);
    const min = between ? th.pauseMinBetweenSentencesMs : th.pauseMinWithinSentenceMs;
    if (gap < min) continue;
    const silent = ctx.silenceFraction(a.endMs, b.startMs);
    if (silent < 0.8) {
      out.push(ctx.rangeCandidate("noise", a.endMs + 50, b.startMs - 50, 0.5, `停頓 ${fmtSec(gap)} 秒中有非語音聲響`));
      continue;
    }
    const start = a.endMs + keep / 2;
    const end = b.startMs - keep / 2;
    if (end - start < 100) continue;
    out.push(
      ctx.rangeCandidate("long_pause", start, end, between ? 0.8 : 0.55, `${between ? "句間" : "句中"}停頓 ${fmtSec(gap)} 秒，縮短為 ${fmtSec(keep)} 秒`),
    );
  }
  return out;
}
