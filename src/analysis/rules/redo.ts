// 重錄偵測：講錯了自己說「等一下，重講」，那句失敗的嘗試要跟著這句指令一起剪掉。
//
// 一個人錄音的時候沒有導播喊卡，講壞了就是**當場說一聲再講一次**。這是 podcast 與
// 旁白最常見的錄音方式，而剪的時候要做的事很機械：找到那句「重講」，把它前面那次
// 失敗的嘗試連同這句指令一起拿掉。
//
// **這條規則只建議、不自動剪**（`redo` 在 SUGGEST_ONLY_KINDS 裡）。它跟其他規則不一樣：
// 別的規則剪掉的是贅字、停頓這些「拿掉也不會少講什麼」的東西，這一條剪掉的是**一整句
// 真正的內容**。判斷錯的代價完全不對稱 —— 少剪一句只是留了個瑕疵，多剪一句是內容不見了。
//
// 精準度靠三件事：
// 1. 指令詞要在句子**開頭附近**。「我們重來一次好不好」是內容，「重來一次」才是指令。
// 2. 指令句要**短**。真的在下指令的人不會講一長串。
// 3. 前面**要有東西可以重錄**。第一句就說「重講」的話，只剪掉指令本身。
import { REDO_MARKERS } from "../lexicon";
import { normText } from "../normalize";
import type { Candidate, Sentence } from "../types";
import type { RuleContext } from "./context";

/** 指令詞要落在句子的前幾個字裡。 */
const MARKER_MAX_WORD_INDEX = 3;
/** 指令句的實詞上限 —— 真的在下指令的人不會講一長串。 */
const MAX_COMMAND_WORDS = 8;
/**
 * 失敗的那次嘗試離指令太遠就不算。
 *
 * 中間隔了半分鐘的話，那句話多半已經是別的內容了，不是剛剛講壞的那一句。
 */
const MAX_LOOKBACK_MS = 30_000;

const NORMALIZED_MARKERS = REDO_MARKERS.map((m) => normText(m)).filter(Boolean);

/** 這句話開頭是不是重錄指令；是的話回指令詞。 */
export function redoMarkerOf(sentenceText: string): string | null {
  const norm = normText(sentenceText);
  if (!norm) return null;
  for (const m of NORMALIZED_MARKERS) {
    // 只認開頭：「重來一次」是指令，「我覺得我們可以重來一次」是內容
    if (norm.startsWith(m)) return m;
  }
  return null;
}

/** 句子的文字（給比對用；不含被跳過的幻覺字）。 */
function textOf(ctx: RuleContext, s: Sentence): string {
  return s.wordIds
    .filter((id) => !ctx.skip(id))
    .map((id) => ctx.words[id]?.text ?? "")
    .join("");
}

export function redoRule(ctx: RuleContext): Candidate[] {
  if (!ctx.sentences.length) return [];
  const out: Candidate[] = [];

  for (let sid = 0; sid < ctx.sentences.length; sid++) {
    const s = ctx.sentences[sid];
    if (!s.wordIds.length) continue;

    // 指令詞要在開頭附近：整句掃的話「…然後我們重來一次」也會中
    const head = s.wordIds
      .slice(0, MARKER_MAX_WORD_INDEX + 1)
      .filter((id) => !ctx.skip(id))
      .map((id) => ctx.words[id]?.text ?? "")
      .join("");
    const marker = redoMarkerOf(head);
    if (!marker) continue;

    // 指令句要短
    const words = s.wordIds.filter((id) => !ctx.skip(id) && ctx.words[id]?.norm);
    if (words.length > MAX_COMMAND_WORDS) continue;

    // 前面那一句就是失敗的嘗試
    const prev = sid > 0 ? ctx.sentences[sid - 1] : null;
    const hasTake = !!prev && prev.wordIds.length > 0 && s.startMs - prev.endMs <= MAX_LOOKBACK_MS;

    const startMs = hasTake ? prev.startMs : s.startMs;
    const endMs = s.endMs;
    const takeText = hasTake ? textOf(ctx, prev) : "";
    const reason = hasTake
      ? `聽起來是重錄：「${marker}」，連同前一句「${takeText.slice(0, 18)}${takeText.length > 18 ? "…" : ""}」一起剪`
      : `聽起來是重錄指令：「${marker}」（前面沒有可以重錄的內容，只剪這句）`;

    out.push(
      ctx.rangeCandidate("redo", startMs, endMs, hasTake ? 0.7 : 0.55, reason, {
        marker,
        // 前面沒東西時只剪指令本身，UI 要看得出差別
        includesTake: hasTake,
      }),
    );
  }
  return out;
}
