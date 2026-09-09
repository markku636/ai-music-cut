// 字幕與逐字稿匯出（SRT / WebVTT / Markdown / 純文字）。
//
// Podcast 上架 YouTube 要字幕、部落格要逐字稿、無障礙要文字檔 —— 現在這些全都得
// 自己重打一遍。
//
// **這裡真正難的不是格式，是時間。** 逐字稿在**來源時間軸**上，字幕要的是**成品
// 時間**：剪掉 20 個贅字之後，來源 12:30 那句話在成品裡是 12:11，剪愈多錯愈遠，
// 而且錯得很安靜 —— 字幕會整份慢慢飄掉，愈後面愈離譜。所以字幕是**依成品順序走
// 保留段**長出來的，而**被剪掉的字要整個不出現**（不是往前挪，是根本沒說過）。
// 反過來，剪下貼上讓同一段話在成品裡出現兩次時，字幕也要出現兩次。
//
// 第二個容易錯的地方是**斷句**。播放器不接受重疊或零長度的字幕；一則太長讀不完、
// 太短閃一下就消失。所以除了字數與時長上限之外，換講者一定另起一則（同一則字幕
// 混兩個人的話是不能讀的），大段剪除的兩邊也要斷開。

import type { KeepSegment } from "./edl/build";
import type { Sentence, Word } from "./types";

export interface Cue {
  /** 1 起算（SRT 需要）。 */
  index: number;
  /** 成品時間（ms）。 */
  startMs: number;
  endMs: number;
  text: string;
  /** 講者 id（有講者標籤時）。 */
  speakerId?: string;
}

export interface CaptionOptions {
  /**
   * 一則字幕的顯示寬度上限（中日韓字算 2、其餘算 1）。
   * 42 是拉丁字幕的慣例（一行 42 字 × 2 行）；中文因此約 21 字，讀得完。
   */
  maxWidth: number;
  /** 一則最長多久。超過就算字數還沒滿也要斷。 */
  maxMs: number;
  /** 一則最短多久 —— 太短的字幕閃一下就不見，讀不到。 */
  minMs: number;
  /**
   * 兩個字之間**被剪掉**超過這麼久就斷開。
   * 剪一個贅字只有兩三百毫秒，不該把一句話打碎；剪掉一整段才是真的換場景。
   */
  breakGapMs: number;
  /** 相鄰兩則之間至少留這麼久（0 = 可以貼著）。 */
  cueGapMs: number;
}

export const DEFAULT_CAPTIONS: CaptionOptions = {
  maxWidth: 42,
  maxMs: 7000,
  minMs: 800,
  breakGapMs: 700,
  cueGapMs: 40,
};

/**
 * 顯示寬度：中日韓與全形標點算 2 格，其餘算 1。
 *
 * 直接用 `length` 的話，21 個中文字會被當成「還可以再塞 21 個」，一則字幕就爆行了。
 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    w +=
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x20000 && c <= 0x3fffd)
        ? 2
        : 1;
  }
  return w;
}

/** 兩個字之間要不要空格：兩邊都是「西文字母 / 數字」才要（中文之間不加）。 */
function needsSpace(prev: string, next: string): boolean {
  return /[A-Za-z0-9)\]}"'.,!?;:]$/.test(prev) && /^[A-Za-z0-9([{"']/.test(next);
}

/** 依語言把字接起來。 */
export function joinWords(texts: string[]): string {
  let out = "";
  for (const raw of texts) {
    const t = raw.trim();
    if (!t) continue;
    if (out && needsSpace(out, t)) out += " ";
    out += t;
  }
  return out.trim();
}

/**
 * 這個字在成品裡還在不在：用**中點**判斷。
 *
 * 用起點的話，剛好落在剪除區邊界上的字會被整個算進來或整個丟掉，取決於邊界是
 * 開區間還是閉區間 —— 中點對「這個字大部分還在嗎」是穩定得多的答案。
 */
export function wordSurvives(keeps: KeepSegment[], w: Word): boolean {
  const mid = (w.startMs + w.endMs) / 2;
  return keeps.some((k) => mid >= k.srcStartMs && mid < k.srcEndMs);
}

export interface BuildCuesInput {
  words: Word[];
  sentences: Sentence[];
  keeps: KeepSegment[];
  /** wordId → 講者 id（沒有講者標籤時不傳）。 */
  speakerOf?: Map<number, string>;
  opts?: Partial<CaptionOptions>;
}

/** 一個字被放進成品的某一次（貼上會讓同一個字有兩份）。 */
interface PlacedWord {
  w: Word;
  outStartMs: number;
  outEndMs: number;
  /** 屬於第幾句 —— 句號是天然斷點。 */
  sentence: number;
}

/** 依中點排好的字（`wordsInKeep` 要二分找起點，所以順序必須是中點的順序）。 */
interface WordByMid {
  w: Word;
  mid: number;
}

/**
 * 中點落在這一段裡的字，依來源時間排好。
 *
 * 二分找起點而不是整份掃：贅字剪多了保留段會有上千個，每一段都掃一次整份逐字稿
 * 就是上千萬次比較。
 */
function wordsInKeep(byMid: WordByMid[], k: KeepSegment): Word[] {
  let lo = 0;
  let hi = byMid.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (byMid[m].mid < k.srcStartMs) lo = m + 1;
    else hi = m;
  }
  const out: Word[] = [];
  for (let i = lo; i < byMid.length && byMid[i].mid < k.srcEndMs; i++) out.push(byMid[i].w);
  return out.sort((a, b) => a.startMs - b.startMs || a.id - b.id);
}

/**
 * 逐字稿 → 字幕。
 *
 * 順序是：依**成品順序**走保留段、把段內的字放到成品時間上 → 依「換講者 / 大段剪除 /
 * 來源往回跳 / 句號」切成段 → 段內依字數與時長打包成一則一則 → 修掉太短與重疊。
 */
export function buildCues(input: BuildCuesInput): Cue[] {
  const o = { ...DEFAULT_CAPTIONS, ...input.opts };
  const { words, sentences, keeps, speakerOf } = input;
  if (!keeps.length) return [];

  const sentenceOf = new Map<number, number>();
  sentences.forEach((s, si) => s.wordIds.forEach((id) => sentenceOf.set(id, si)));

  // **依成品順序走 keeps，不是依來源順序走字。**
  //
  // 剪下貼上 / 搬移之後來源順序不再等於成品順序，照它走會出兩種錯，而且都不會報錯：
  // 搬移時一則字幕的結束會早於開始（`tidyCues` 接著把它夾成一則 1.2 秒的字幕放在
  // 錯的地方），貼上的那一份則完全沒有字幕 —— `mapSrcToOut` 對重複出現的來源一律
  // 回「成品裡最早的那一次」。
  //
  // 從 keeps 走就沒有這個問題：成品時間天生遞增，而同一段來源出現兩次就會被走兩次。
  const byMid: WordByMid[] = words
    .filter((w) => w && w.text.trim())
    .map((w) => ({ w, mid: (w.startMs + w.endMs) / 2 }))
    .sort((a, b) => a.mid - b.mid);

  const placed: PlacedWord[] = [];
  for (const k of keeps) {
    const off = k.outStartMs - k.srcStartMs;
    for (const w of wordsInKeep(byMid, k)) {
      placed.push({
        w,
        // 跨在段落邊界上的字要夾住，不然會畫到這一段之外去
        outStartMs: Math.max(k.outStartMs, Math.min(k.outEndMs, w.startMs + off)),
        outEndMs: Math.max(k.outStartMs, Math.min(k.outEndMs, w.endMs + off)),
        sentence: sentenceOf.get(w.id) ?? -1,
      });
    }
  }

  const cues: Cue[] = [];
  let pending: PlacedWord[] = [];
  let pendingSpeaker: string | undefined;

  const flush = () => {
    if (!pending.length) return;
    const text = joinWords(pending.map((p) => p.w.text));
    if (text) {
      cues.push({
        index: 0,
        startMs: pending[0].outStartMs,
        endMs: pending[pending.length - 1].outEndMs,
        text,
        speakerId: pendingSpeaker,
      });
    }
    pending = [];
  };

  let prev: PlacedWord | null = null;
  for (const p of placed) {
    const sp = speakerOf?.get(p.w.id);
    // 換講者一定另起一則：一則字幕混兩個人的話是不能讀的
    if (pending.length && sp !== pendingSpeaker) flush();
    if (pending.length && prev) {
      const srcGap = p.w.startMs - prev.w.endMs;
      // 中間被剪掉一大段 → 斷開（剪一個贅字不算）。
      // srcGap < 0 是「來源往回跳」＝ 搬移 / 貼上的接縫，那裡一定要斷。
      if (srcGap < 0 || srcGap > o.breakGapMs) flush();
      else if (p.sentence !== prev.sentence) flush();
    }
    // 字數 / 時長上限。時長用**成品時間**：字幕在螢幕上待多久是成品的事，
    // 用來源時間會把中間剪掉的部分也算進去，於是斷在不需要斷的地方。
    if (pending.length) {
      const wouldBe = joinWords([...pending.map((x) => x.w.text), p.w.text]);
      const spanMs = p.outEndMs - pending[0].outStartMs;
      if (displayWidth(wouldBe) > o.maxWidth || spanMs > o.maxMs) flush();
    }
    if (!pending.length) pendingSpeaker = sp;
    pending.push(p);
    prev = p;
  }
  flush();

  return tidyCues(cues, o);
}

/**
 * 修掉播放器不接受的東西：零長度、太短、重疊、順序顛倒。
 *
 * **拉長只能往後**，而且不能碰到下一則的開頭 —— 字幕重疊時多數播放器會直接兩則
 * 疊著畫，或乾脆丟掉一則。
 */
export function tidyCues(cues: Cue[], opts: CaptionOptions = DEFAULT_CAPTIONS): Cue[] {
  const sorted = [...cues].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const out: Cue[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const c = { ...sorted[i] };
    const prev = out[out.length - 1];
    if (prev && c.startMs < prev.endMs + opts.cueGapMs) c.startMs = prev.endMs + opts.cueGapMs;
    const nextStart = sorted[i + 1]?.startMs ?? Number.POSITIVE_INFINITY;
    // 想拉到 minMs，但最多只能拉到下一則開始之前
    const want = Math.max(c.endMs, c.startMs + opts.minMs);
    c.endMs = Math.min(want, nextStart - opts.cueGapMs);
    if (c.endMs <= c.startMs) {
      // 擠不下了（前後兩則貼太近）—— 丟掉比產生一個零長度的字幕好
      if (c.startMs + 1 >= nextStart) continue;
      c.endMs = c.startMs + 1;
    }
    out.push(c);
  }
  return out.map((c, i) => ({ ...c, index: i + 1 }));
}

/** `00:01:02,345`（SRT 用逗號）。 */
export function srtTime(ms: number): string {
  return clockOf(ms, ",");
}

/** `00:01:02.345`（WebVTT 用小數點）。 */
export function vttTime(ms: number): string {
  return clockOf(ms, ".");
}

function clockOf(ms: number, sep: string): string {
  const v = Math.max(0, Math.round(ms));
  const h = Math.floor(v / 3_600_000);
  const m = Math.floor((v % 3_600_000) / 60_000);
  const s = Math.floor((v % 60_000) / 1000);
  const f = v % 1000;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${sep}${pad(f, 3)}`;
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, "0");
}

export interface RenderOptions {
  /** 把講者名字寫進字幕文字（`Mark：…`）。 */
  speakerPrefix?: boolean;
  labelOf?: (speakerId: string) => string;
}

function withSpeaker(c: Cue, o: RenderOptions): string {
  if (!o.speakerPrefix || !c.speakerId) return c.text;
  const label = o.labelOf?.(c.speakerId) ?? c.speakerId;
  return `${label}：${c.text}`;
}

/** SRT。行尾用 \n（多數播放器兩種都吃，\n 比較不會被編輯器改壞）。 */
export function toSrt(cues: Cue[], o: RenderOptions = {}): string {
  return cues.map((c) => `${c.index}\n${srtTime(c.startMs)} --> ${srtTime(c.endMs)}\n${withSpeaker(c, o)}\n`).join("\n");
}

/** WebVTT。第一行的 `WEBVTT` 是規格要求，少了整份檔案會被當成不合法。 */
export function toVtt(cues: Cue[], o: RenderOptions = {}): string {
  const body = cues.map((c) => `${vttTime(c.startMs)} --> ${vttTime(c.endMs)}\n${withSpeaker(c, o)}\n`).join("\n");
  return `WEBVTT\n\n${body}`;
}

/** 給部落格 / 節目筆記用的 Markdown 逐字稿：換人時另起一段並加粗名字。 */
export function toMarkdown(cues: Cue[], o: RenderOptions & { timestamps?: boolean } = {}): string {
  const lines: string[] = [];
  let lastSpeaker: string | undefined;
  for (const c of cues) {
    const ts = o.timestamps === false ? "" : `\`${stampOf(c.startMs)}\` `;
    if (c.speakerId && c.speakerId !== lastSpeaker) {
      const label = o.labelOf?.(c.speakerId) ?? c.speakerId;
      lines.push("", `**${label}**`, "");
      lastSpeaker = c.speakerId;
    }
    lines.push(`${ts}${c.text}`);
  }
  return lines.join("\n").replace(/^\n+/, "").trimEnd() + "\n";
}

/** 純文字：只有內容，沒有時間也沒有標記。 */
export function toPlainText(cues: Cue[], o: RenderOptions = {}): string {
  return cues.map((c) => withSpeaker(c, o)).join("\n") + "\n";
}

/** `12:34` / `1:02:03`（Markdown 的可讀時間戳）。 */
export function stampOf(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m, 2)}:${pad(s, 2)}` : `${m}:${pad(s, 2)}`;
}

export type CaptionFormat = "srt" | "vtt" | "md" | "txt";

export const CAPTION_EXT: Record<CaptionFormat, string> = { srt: "srt", vtt: "vtt", md: "md", txt: "txt" };

export function renderCaptions(cues: Cue[], format: CaptionFormat, o: RenderOptions & { timestamps?: boolean } = {}): string {
  switch (format) {
    case "srt":
      return toSrt(cues, o);
    case "vtt":
      return toVtt(cues, o);
    case "md":
      return toMarkdown(cues, o);
    case "txt":
      return toPlainText(cues, o);
  }
}
