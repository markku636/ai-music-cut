import type { Edl } from "./edl/build";
import { mapSrcToOut } from "./edl/map";
import type { Marker, Transcript } from "./types";

/**
 * 節目筆記（show notes）：剪完之後要貼到部落格 / RSS 的那一份。
 *
 * **這裡唯一難的事情是時間**。逐字稿的時間是**來源**時間軸上的，
 * 但節目筆記給的是聽眾在成品裡看到的時間 —— 中間隔著整份 EDL。
 * 剪掉 20 個贅字之後，來源 12:30 那句話在成品裡是 12:11；
 * 直接把逐字稿的時間寫進節目筆記，剪愈多錯愈遠，而且錯得很安靜。
 *
 * 所以：給 claude 的素材、以及它回來之後的驗證，**兩邊都用成品時間**。
 * claude 完全不需要知道 EDL 的存在。
 */

export interface ShowNoteChapter {
  /** 成品時間（ms）。 */
  outMs: number;
  title: string;
}

export interface ShowNotes {
  /** 這份筆記寫成哪一種語言（BCP-47 風格代碼）。 */
  language?: string;
  /** 給人看的語言名稱。 */
  languageName?: string;
  summary: string;
  chapters: ShowNoteChapter[];
  quotes: { outMs: number; text: string }[];
  keywords: string[];
}

/** 把成品毫秒印成 podcast 慣用的時間戳（>1 小時才出現小時位）。 */
export function stamp(outMs: number): string {
  const total = Math.max(0, Math.floor(outMs / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, "0")}` : `${mm}:${String(s).padStart(2, "0")}`;
}

export interface NotesSource {
  /** 成品時間（ms）。 */
  outMs: number;
  text: string;
}

/**
 * 把逐字稿整理成「成品時間 + 句子」餵給 claude。
 *
 * 落在剪掉的區間裡的句子會被丟掉 —— 那些話成品裡根本沒有，
 * 讓 claude 看到它們只會生出聽眾找不到的章節。
 */
export function notesSource(tr: Transcript | null, edl: Edl | null, opts: { maxChars?: number } = {}): NotesSource[] {
  if (!tr || !edl) return [];
  const maxChars = opts.maxChars ?? 24_000;
  const out: NotesSource[] = [];
  let used = 0;
  for (const s of tr.sentences) {
    // 這句話在成品裡還在不在：起點落在任何一個保留段內才算
    const kept = edl.keeps.some((k) => s.startMs >= k.srcStartMs && s.startMs < k.srcEndMs);
    if (!kept) continue;
    const text = s.wordIds.map((id) => tr.words[id]?.text ?? "").join("").trim();
    if (!text) continue;
    if (used + text.length > maxChars) break;
    used += text.length;
    out.push({ outMs: mapSrcToOut(edl.keeps, s.startMs), text });
  }
  return out;
}

/** 餵給 claude 的文字：每行一個成品時間戳 + 那句話。 */
export function notesPrompt(src: NotesSource[], opts: { title?: string; durationMs: number; languageLine?: string }): string {
  const lines = src.map((s) => `[${stamp(s.outMs)}] ${s.text}`).join("\n");
  return [
    `這是一集 podcast 剪完之後的逐字稿。每一行前面的時間戳是**成品**裡的位置（聽眾按下播放之後的時間）。`,
    `節目長度 ${stamp(opts.durationMs)}。${opts.title ? `檔名：${opts.title}` : ""}`,
    ``,
    `請產生節目筆記：`,
    `- summary：150–250 字的摘要，講這一集在談什麼、聽眾會得到什麼。不要寫「本集」開頭的公式句。`,
    `- chapters：5–10 個章節。標題要具體（「來賓怎麼開始寫程式」勝過「訪談」），≤ 14 字。`,
    `  時間戳**只能用上面出現過的**，而且必須遞增。第一個章節從 00:00 開始。`,
    `- quotes：2–4 句最值得引用的原話，逐字照抄，附上它的時間戳。`,
    `- keywords：5–8 個關鍵字。`,
    ``,
    // 語言指示放在**最後**：夾在一堆規則中間的指示比較容易被忽略掉
    opts.languageLine ? `\n所有輸出（summary / chapters / quotes / keywords）都用同一種語言。${opts.languageLine}` : "",
    ``,
    `逐字稿：`,
    lines,
  ].join("\n");
}

export const SHOW_NOTES_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    chapters: {
      type: "array",
      items: {
        type: "object",
        properties: { at: { type: "string", description: "時間戳，如 12:30" }, title: { type: "string" } },
        required: ["at", "title"],
        additionalProperties: false,
      },
    },
    quotes: {
      type: "array",
      items: {
        type: "object",
        properties: { at: { type: "string" }, text: { type: "string" } },
        required: ["at", "text"],
        additionalProperties: false,
      },
    },
    keywords: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "chapters", "quotes", "keywords"],
  additionalProperties: false,
} as const;

/** `12:30` / `1:02:03` / `90`（純秒）→ ms；看不懂回 null。 */
export function parseStamp(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const parts = t.split(":").map((x) => Number(x.trim()));
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  if (parts.length === 1) return parts[0] * 1000;
  if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
  if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
  return null;
}

export interface RawShowNotes {
  summary?: unknown;
  chapters?: unknown;
  quotes?: unknown;
  keywords?: unknown;
}

/**
 * 驗證 claude 回來的東西。
 *
 * 會出錯的地方都在這裡擋掉：時間戳看不懂、超出節目長度、章節沒有遞增、
 * 第一個章節不是 0。**寧可丟掉一筆也不要寫出聽眾按下去跳到空氣的章節。**
 */
export function normalizeShowNotes(raw: RawShowNotes, durationMs: number): ShowNotes {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);

  const chapters: ShowNoteChapter[] = [];
  for (const c of arr(raw.chapters)) {
    const o = c as { at?: unknown; title?: unknown };
    const ms = parseStamp(str(o.at));
    const title = str(o.title);
    if (ms === null || !title || ms > durationMs) continue;
    // 必須遞增：播放器對亂序 / 重疊章節的反應從忽略到整份 metadata 不讀都有
    if (chapters.length && ms <= chapters[chapters.length - 1].outMs) continue;
    chapters.push({ outMs: ms, title });
  }
  // 第一個章節補到 0：從 00:03 開始的章節表，前三秒是沒有章節的空窗
  if (chapters.length && chapters[0].outMs > 0) chapters[0] = { ...chapters[0], outMs: 0 };

  const quotes: { outMs: number; text: string }[] = [];
  for (const q of arr(raw.quotes)) {
    const o = q as { at?: unknown; text?: unknown };
    const ms = parseStamp(str(o.at));
    const text = str(o.text);
    if (ms === null || !text || ms > durationMs) continue;
    quotes.push({ outMs: ms, text });
  }

  return {
    summary: str(raw.summary),
    chapters,
    quotes,
    keywords: arr(raw.keywords).map(str).filter(Boolean).slice(0, 12),
  };
}

/** 節目筆記 → Markdown（貼到部落格 / RSS 的那一份）。 */
export function toMarkdown(n: ShowNotes, opts: { title?: string } = {}): string {
  const lines: string[] = [];
  if (opts.title) lines.push(`# ${opts.title}`, "");
  if (n.summary) lines.push(n.summary, "");
  if (n.chapters.length) {
    lines.push("## 章節", "");
    for (const c of n.chapters) lines.push(`- \`${stamp(c.outMs)}\` ${c.title}`);
    lines.push("");
  }
  if (n.quotes.length) {
    lines.push("## 節錄", "");
    for (const q of n.quotes) lines.push(`> ${q.text}`, `> — \`${stamp(q.outMs)}\``, "");
  }
  if (n.keywords.length) lines.push("## 關鍵字", "", n.keywords.join("、"), "");
  return lines.join("\n").trimEnd() + "\n";
}

/** 節目筆記的章節 → 可以直接下的標記（來源時間由呼叫端換算）。 */
export function chaptersToMarkers(n: ShowNotes): { outMs: number; title: string }[] {
  return n.chapters.map((c) => ({ outMs: c.outMs, title: c.title }));
}

/** 已經有的章節標記 → 節目筆記的章節（成品時間）。 */
export function markersToChapters(markers: Marker[], edl: Edl | null): ShowNoteChapter[] {
  if (!edl) return [];
  return markers
    .filter((m) => m.kind === "chapter")
    .map((m) => ({ outMs: mapSrcToOut(edl.keeps, m.ms), title: m.title || "" }))
    .filter((c) => c.title)
    .sort((a, b) => a.outMs - b.outMs);
}
