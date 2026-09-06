// 贅字規則：純語助詞、語境相依的軟贅詞、英文口頭禪、過度使用的連接詞。
import {
  COPULA_SUBJECTS, DUI_KEEP_NEXT, EN_PURE_FILLERS, EN_SOFT_FILLERS, LIKE_KEEP_PREV, MULTI_TOKEN, OVERUSE_MARKERS, ZH_PURE_FILLERS,
  ZH_SOFT_FILLERS, customFillerPhrases, fillerRuleFor, isAnyFiller, isPureFiller,
} from "../lexicon";
import type { Candidate } from "../types";
import type { RuleContext } from "./context";

const ATTACHED_PARTICLES = new Set(["啊", "哦", "喔", "嘛", "齁", "厚", "呢", "啦", "吼", "耶", "欸"]);
const DUI = new Set(["對", "對啊", "對對", "對對對", "對呀", "對阿"]);
const NA_GE = new Set(["那個", "這個"]);
const JIU_SHI = new Set(["就是", "就是說"]);
const OK_WORDS = new Set(["好", "ok", "okay"]);

interface Hit {
  ids: number[];
  score: number;
  reason: string;
}

/**
 * 從 i 起是否能組成使用者自訂的多字詞。
 * 內建的 MULTI_TOKEN 是寫死的切法（["就是","說"]），使用者加的詞不可能預先知道
 * Whisper 會怎麼切，所以這裡改成「一路接下去比對」。
 */
function customPhraseAt(ctx: RuleContext, i: number): { n: number; norm: string } | null {
  const phrases = customFillerPhrases();
  if (!phrases.length) return null;
  const maxLen = [...phrases[0]].length; // 已依長度排序，第一個最長
  let acc = "";
  for (let k = 0; k < 8; k++) {
    const w = ctx.words[i + k];
    if (!w || !w.norm) break;
    if (k > 0 && ctx.gapBefore(i + k) > 200) break; // 中間有停頓就不是同一個詞
    acc += w.norm;
    if ([...acc].length > maxLen) break;
    if (k > 0 && fillerRuleFor(acc)) return { n: k + 1, norm: acc };
  }
  return null;
}

/** 從 i 起是否能組成 MULTI_TOKEN 詞；回組成的字數（0=否）。 */
function multiTokenAt(ctx: RuleContext, i: number): { n: number; norm: string } | null {
  for (const parts of MULTI_TOKEN) {
    let ok = true;
    for (let k = 0; k < parts.length; k++) {
      const w = ctx.words[i + k];
      if (!w || w.norm !== parts[k] || (k > 0 && ctx.gapBefore(i + k) > 200)) {
        ok = false;
        break;
      }
    }
    if (ok) return { n: parts.length, norm: parts.join("") };
  }
  return null;
}

function judgeToken(ctx: RuleContext, i: number, norm: string, span: number): Hit | null {
  const w = ctx.words[i];
  const last = i + span - 1;
  const gapAfter = ctx.gapAfter(last);
  const gapBefore = ctx.gapBefore(i);
  const next = ctx.words[last + 1];
  const prev = ctx.words[i - 1];
  const nextNorm = next?.norm ?? "";
  const prevNorm = prev?.norm ?? "";
  const ids = Array.from({ length: span }, (_, k) => i + k);
  const s = ctx.sentence(i);
  const singleWordSentence = !!s && s.wordIds.length === span;
  const sentenceStart = ctx.isSentenceStart(i);

  // 使用者詞表最優先 —— 他要是說了「『然後』永遠別剪」，內建那套語境判斷就不該再插嘴。
  const userRule = fillerRuleFor(norm);
  if (userRule === "never") return null;
  if (userRule === "always") return { ids, score: 0.95, reason: `自訂贅字「${norm}」` };

  // 純語助詞
  if (isPureFiller(norm)) {
    if (ATTACHED_PARTICLES.has(norm) && gapBefore < 60) return null; // 黏在前字的語尾助詞
    if (singleWordSentence && ctx.prevSentenceIsQuestion(i)) return { ids, score: 0.15, reason: `「${w.text.trim()}」可能是回答（前句為問句）` };
    return { ids, score: 0.95, reason: `語助詞「${norm}」` };
  }

  // 「對」家族
  if (DUI.has(norm)) {
    if (next && gapAfter < 150 && DUI_KEEP_NEXT.has(nextNorm)) return null; // 對的 / 對於 / 對面 …
    if (ctx.prevSentenceIsQuestion(i) && (singleWordSentence || ctx.isStandalone(i))) return { ids, score: 0.2, reason: "回答用語「對」，保留" };
    if (norm.length >= 3) return { ids, score: 0.7, reason: "重複確認語「對對對」，保留一個" };
    if (ctx.isStandalone(i) || (sentenceStart && gapAfter >= 150)) return { ids, score: 0.75, reason: "自我確認語「對」" };
    return null;
  }

  // 然後
  if (norm === "然後") {
    if (sentenceStart && gapAfter < 300) return { ids, score: 0.25, reason: "句首連接詞「然後」（節奏感，通常保留）" };
    if (!sentenceStart && (gapAfter >= 250 || isAnyFiller(nextNorm))) return { ids, score: 0.7, reason: "句中贅詞「然後」後接停頓" };
    return { ids, score: 0.35, reason: "連接詞「然後」" };
  }

  // 那個 / 這個
  if (NA_GE.has(norm)) {
    const nextIsContent = !!next && nextNorm.length > 0 && !isAnyFiller(nextNorm);
    if (nextIsContent && gapAfter < 200 && !NA_GE.has(nextNorm)) return null; // 限定詞（那個系統）
    if (gapAfter >= 200 || isAnyFiller(nextNorm) || NA_GE.has(nextNorm) || !next) return { ids, score: 0.8, reason: `「${norm}」後接停頓，為思考語` };
    return null;
  }

  // 就是 / 就是說
  if (JIU_SHI.has(norm)) {
    if (norm === "就是" && COPULA_SUBJECTS.has(prevNorm) && gapBefore < 200) return null; // 我就是…（係詞）
    if (gapAfter >= 200 || isAnyFiller(nextNorm)) return { ids, score: 0.75, reason: `「${norm}」後停頓` };
    return { ids, score: 0.4, reason: `「${norm}」疑似贅詞（語意需判斷）` };
  }

  // 好 / OK（轉場）
  if (OK_WORDS.has(norm)) {
    if (ctx.prevSentenceIsQuestion(i) && (singleWordSentence || ctx.isStandalone(i))) return { ids, score: 0.15, reason: "回答用語，保留" };
    if (sentenceStart && (ctx.isStandalone(i) || gapAfter >= 150)) return { ids, score: 0.6, reason: `段落轉場語「${w.text.trim()}」` };
    return null;
  }

  // 英文 like
  if (norm === "like") {
    if (LIKE_KEEP_PREV.has(prevNorm) && gapBefore < 200) return null;
    if (ctx.isStandalone(i) || isAnyFiller(nextNorm) || gapAfter >= 120) return { ids, score: 0.7, reason: "口頭禪 like" };
    return { ids, score: 0.3, reason: "like（語意需判斷）" };
  }

  if (norm === "actually" || norm === "so") {
    if (sentenceStart && gapAfter >= 120) return { ids, score: 0.5, reason: `句首口頭禪 ${norm}` };
    return null;
  }
  if (norm === "right" || norm === "well") {
    if (ctx.isStandalone(i)) return { ids, score: 0.5, reason: `口頭禪 ${norm}` };
    return null;
  }
  if (EN_SOFT_FILLERS.has(norm)) return { ids, score: 0.6, reason: `英文口頭禪 ${norm}` };

  // 其餘中文軟贅詞：其實 / 反正 / 基本上 / 我覺得 / 怎麼講 / 你知道嗎 / 嘛 / 齁 …
  if (ZH_SOFT_FILLERS.has(norm)) {
    if (norm === "那") {
      if (sentenceStart && gapAfter >= 150) return { ids, score: 0.5, reason: "句首「那」轉場語" };
      return null;
    }
    if (ATTACHED_PARTICLES.has(norm)) {
      if (gapBefore < 60) return null;
      return { ids, score: 0.5, reason: `語尾助詞「${norm}」獨立成音` };
    }
    if (norm === "其實" || norm === "反正" || norm === "基本上") {
      return { ids, score: sentenceStart ? 0.35 : 0.5, reason: `口頭禪「${norm}」` };
    }
    if (norm === "我覺得") return null; // 語意詞，交給 LLM
    return { ids, score: 0.55, reason: `口頭禪「${norm}」` };
  }

  // 自訂「看語境」的詞：內建沒有為它寫過規則，所以只用最通用的訊號（獨立成音 / 後接停頓），
  // 而且分數壓在自動剪的門檻以下 —— 使用者自己加的詞，先讓他看過再說。
  if (userRule === "context") {
    if (ctx.isStandalone(i) || gapAfter >= 150 || isAnyFiller(nextNorm)) {
      return { ids, score: 0.6, reason: `自訂贅字「${norm}」後接停頓` };
    }
    return { ids, score: 0.35, reason: `自訂贅字「${norm}」（語意需判斷）` };
  }
  return null;
}

export function fillerRule(ctx: RuleContext): Candidate[] {
  const out: Candidate[] = [];
  const words = ctx.words;
  const hits: Hit[] = [];
  const hitAt = new Map<number, Hit>();
  let i = 0;
  while (i < words.length) {
    if (ctx.skip(i) || !words[i].norm) {
      i += 1;
      continue;
    }
    // 自訂詞先比 —— 使用者加的「你知道我意思吧」要贏過內建的「你知道」
    const multi = customPhraseAt(ctx, i) ?? multiTokenAt(ctx, i);
    let hit: Hit | null = null;
    let span = 1;
    if (multi) {
      hit = judgeToken(ctx, i, multi.norm, multi.n);
      span = multi.n;
    }
    if (!hit) {
      hit = judgeToken(ctx, i, words[i].norm, 1);
      span = 1;
    }
    if (hit) {
      hits.push(hit);
      for (const id of hit.ids) hitAt.set(id, hit);
      i += span;
    } else i += 1;
  }

  // 過度使用：30 秒滑動窗內 然後/就是/其實 ≥ N 次 → 每隔一個提高分數
  const markerIdx = words.map((w, idx) => (OVERUSE_MARKERS.has(w.norm) ? idx : -1)).filter((x) => x >= 0);
  for (let a = 0; a < markerIdx.length; a++) {
    const start = words[markerIdx[a]].startMs;
    let b = a;
    while (b + 1 < markerIdx.length && words[markerIdx[b + 1]].startMs - start <= 30_000) b += 1;
    const n = b - a + 1;
    if (n >= ctx.th.markerOverusePer30s) {
      for (let k = a + 1; k <= b; k += 2) {
        const idx = markerIdx[k];
        const h = hitAt.get(idx);
        const w = words[idx];
        if (h) {
          if (h.score < 0.6) {
            h.score = 0.6;
            h.reason = `30 秒內出現 ${n} 次「${w.norm}」，過度使用`;
          }
        } else if (!ctx.skip(idx)) {
          const nh: Hit = { ids: [idx], score: 0.6, reason: `30 秒內出現 ${n} 次「${w.norm}」，過度使用` };
          hits.push(nh);
          hitAt.set(idx, nh);
        }
      }
    }
  }

  for (const h of hits) {
    const w = words[h.ids[0]];
    const last = words[h.ids[h.ids.length - 1]];
    let score = h.score;
    // 修正：低信心 / 極短 / 兩側皆贅字 → 更像贅字
    if (w.prob < 0.6) score += 0.05;
    if (last.endMs - w.startMs < 120) score += 0.05;
    const p = words[h.ids[0] - 1];
    const n = words[h.ids[h.ids.length - 1] + 1];
    if (p && n && isAnyFiller(p.norm) && isAnyFiller(n.norm)) score += 0.1;
    // 守門：剪掉後句子少於 2 個實詞 → 不提候選（避免剪成空句）
    const sid = ctx.sentenceId(h.ids[0]);
    if (sid >= 0 && ctx.contentWordCount(sid, isAnyFiller) < 2 && score >= 0.5) continue;
    out.push(ctx.wordsCandidate("filler", h.ids, score, h.reason));
  }
  return out;
}

export const _test = { ZH_PURE_FILLERS, EN_PURE_FILLERS, ZH_SOFT_FILLERS };
