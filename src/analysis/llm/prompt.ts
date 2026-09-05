// AI 判讀提示：系統提示（原則）+ 視窗內容（句子、候選標記、候選清單）。
import { KIND_LABEL, type Candidate, type DecisionMap, type Transcript } from "../types";
import { formatMs } from "../../time";
import type { JudgeWindow } from "./windows";

export const EDITOR_SYSTEM_PROMPT = `你是資深 Podcast／談話節目的剪輯師，負責審核「自動粗剪」提出的候選。最高原則：**自然順暢**——聽眾應該覺得講者本來就講得流暢，而不是「被剪過」。

判斷準則：
1. 贅字若拿掉會讓句子變得急促、少了呼吸或轉折感 → drop。句首的「然後／那／好／對」常是節奏，通常 drop（保留）。
2. 重複的字詞只留一次，保留最後一次（通常最流暢）；「對對對」留一個 → apply。
3. 講到一半重講（restart）：拿掉沒講完的那一段 → apply；但若前後語意不同（自我修正）→ suggest。
4. 停頓縮短可以 apply，但句子之間要留一口氣（系統已保留 0.35 秒）。
5. 語意不清、東拉西扯、離題、講者自己說「再來一次／重講」（要剪的是重講之前那一段）→ 用 new_candidates 標出，action=suggest。
6. 不確定就 suggest，不要 apply。絕不提出會讓句子不完整的剪法。
7. reason 用繁體中文、20 字內；每個候選代號都要給一筆 decision。`;

/** 舊名，仍有引用（CLI / 既有測試）。 */
export const JUDGE_SYSTEM_PROMPT = EDITOR_SYSTEM_PROMPT;

/**
 * 審核 agent。立場刻意跟剪輯相反：預設「剪輯是對的」，只有明顯會壞才推翻。
 * 不給它新增候選的能力 —— 兩個 agent 都在提議的話，候選只會越滾越多、沒人收斂。
 */
export const REVIEWER_SYSTEM_PROMPT = `你是 Podcast 節目的**審核**（第二雙耳朵）。剪輯師已經決定要剪掉某些片段，你的工作是**只挑出「剪了會壞」的那幾筆**，其餘一律放行。

你看到的是「剪掉之後那句話讀起來的樣子」——被剪的部分用刪除線標記 ⟦cN:～～⟧，請想像它不見了之後這句話還通不通。

判斷準則：
1. 預設 verdict=cut（同意剪）。剪輯師比你熟這個節目，不要為了表現而反對。
2. 只有下列情況才 verdict=keep：
   - 剪掉之後句子缺主詞 / 動詞 / 受詞，或語意反過來（「不是」的「不」被剪掉）。
   - 那個詞其實有實義（「就是」＝「正是」、「對」＝回答而非口頭禪）。
   - 剪掉之後兩句黏在一起、完全沒有呼吸，聽起來會很趕。
   - 這是整段唯一的轉折詞，剪掉會讓前後看起來不相干。
3. 真的判斷不出來（前後文不足）→ verdict=unsure，不要硬猜。
4. 每個候選代號都要給一筆 review。reason 用繁體中文、20 字內，講「為什麼會壞」而不是複述規則。`;

/** 審核視窗：跟剪輯看同一段內容，但把要剪的部分標成刪除線，讀的是「剪完之後」。 */
export function renderReviewWindow(tr: Transcript, w: JudgeWindow, candidates: Candidate[], decisions: DecisionMap, onlyIds: Set<string>): RenderedWindow {
  const base = renderWindow(tr, w, candidates, decisions);
  const ids = [...base.alias.entries()].filter(([, id]) => onlyIds.has(id));
  const alias = new Map(ids);
  const list = ids
    .map(([a, id]) => {
      const c = candidates.find((x) => x.id === id);
      if (!c) return null;
      const text = c.wordIds.length ? c.wordIds.map((wid) => tr.words[wid].text).join("") : `${((c.endMs - c.startMs) / 1000).toFixed(1)}s 停頓`;
      return `${a} | ${KIND_LABEL[c.kind]} | 「${text}」 | 剪輯的理由：${decisions[id]?.reason ?? c.reason}`;
    })
    .filter(Boolean) as string[];
  const prompt = [
    base.prompt.split("\n--- 候選清單 ---")[0],
    "",
    "--- 剪輯師打算剪掉的（只覆核這些） ---",
    ...list,
    "",
    `請輸出 JSON：window_id="${w.id}"；reviews 對上面每個 cN 給 cut/keep/unsure 與 20 字內理由。不要新增候選。`,
  ].join("\n");
  return { prompt, alias };
}

export interface RenderedWindow {
  prompt: string;
  /** 代號（c1…）→ 候選 id。 */
  alias: Map<string, string>;
}

export function renderWindow(tr: Transcript, w: JudgeWindow, candidates: Candidate[], decisions: DecisionMap): RenderedWindow {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const alias = new Map<string, string>();
  const aliasOf = new Map<string, string>();
  w.candidateIds.forEach((id, i) => {
    alias.set(`c${i + 1}`, id);
    aliasOf.set(id, `c${i + 1}`);
  });
  // 字 → 覆蓋它的候選代號（只標視窗內的候選）
  const wordAlias = new Map<number, string>();
  const rangeCands: Candidate[] = [];
  for (const id of w.candidateIds) {
    const c = byId.get(id);
    if (!c) continue;
    if (c.wordIds.length) for (const wid of c.wordIds) if (!wordAlias.has(wid)) wordAlias.set(wid, aliasOf.get(id)!);
    else rangeCands.push(c);
  }
  const lines: string[] = [];
  const renderSentence = (sid: number, core: boolean) => {
    const s = tr.sentences[sid];
    if (!s) return;
    let cur: string | null = null;
    let buf: string[] = [];
    const parts: string[] = [];
    const flush = () => {
      if (!buf.length) return;
      parts.push(cur ? `⟦${cur}:${buf.join("")}⟧` : buf.join(""));
      buf = [];
    };
    for (const wid of s.wordIds) {
      const a = core ? (wordAlias.get(wid) ?? null) : null;
      if (a !== cur) {
        flush();
        cur = a;
      }
      const wd = tr.words[wid];
      buf.push(wd.prob < 0.4 && !a && core ? `${wd.text}(?)` : wd.text);
    }
    flush();
    const pauses = rangeCands.filter((c) => c.startMs >= s.startMs - 50 && c.endMs <= (tr.sentences[sid + 1]?.startMs ?? tr.durationMs) + 50 && c.kind === "long_pause");
    const tail = core && pauses.length ? `  ⟨${pauses.map((c) => `${aliasOf.get(c.id)}:停頓${((c.endMs - c.startMs) / 1000).toFixed(1)}s`).join(" ")}⟩` : "";
    lines.push(`${core ? "" : "（語境）"}S${sid} [${formatMs(s.startMs, { millis: false })}] ${parts.join("")}${tail}`);
  };
  for (const sid of w.contextBefore) renderSentence(sid, false);
  for (const sid of w.coreSentenceIds) renderSentence(sid, true);
  for (const sid of w.contextAfter) renderSentence(sid, false);

  const candLines = w.candidateIds.map((id) => {
    const c = byId.get(id)!;
    const a = aliasOf.get(id)!;
    const text = c.wordIds.length ? c.wordIds.map((wid) => tr.words[wid].text).join("") : `${((c.endMs - c.startMs) / 1000).toFixed(1)}s`;
    const st = decisions[id]?.state ?? "pending";
    return `${a} | ${KIND_LABEL[c.kind]} | 「${text}」 | 分數 ${c.score.toFixed(2)} | 規則預設 ${st === "auto" ? "剪" : "待決"} | ${c.reason}`;
  });

  const prompt = [
    `=== 視窗 ${w.id}（核心句 S${w.coreSentenceIds[0]}–S${w.coreSentenceIds[w.coreSentenceIds.length - 1]}；⟦cN:…⟧ 為候選、(?) 為辨識信心低的字、⟨cN:停頓⟩ 為長停頓候選）===`,
    ...lines,
    "",
    "--- 候選清單 ---",
    ...candLines,
    "",
    `請輸出 JSON：window_id="${w.id}"；decisions 對每個 cN 給 apply/suggest/drop 與 20 字內理由；new_candidates 只在核心句（S 編號）內、text 逐字複製該句中的連續文字。`,
  ].join("\n");
  return { prompt, alias };
}
