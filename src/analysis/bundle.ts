// 發布包（Hindenburg 的 Publish、Descript 的 Export → Podcast）。
//
// 一集要上架，手上得有：音檔、字幕、逐字稿、節目筆記、章節。這些這個 App 全都做得出來，
// 但**分散在五個對話框裡**，每週都要開五次、存五次、自己想檔名、自己收進同一個資料夾。
// 上架前最容易出的錯不是做不出來，是「少帶了一個」或「這次的檔名跟上次不一樣」。
//
// 所以這裡只做一件事：**用同一個名字把它們一次產齊，並且說清楚哪些沒帶到、為什麼**。
// 沒有逐字稿就沒有字幕，沒有標記就沒有章節 —— 那不是錯誤，是這一集的狀態，
// 但一定要寫在清單上，不能安靜地少一個檔案。

import type { PreflightFinding } from "./preflight";
import { CAPTION_EXT, type CaptionFormat } from "./captions";
import { safeFileName } from "./splitExport";

export type BundleItemKind = "audio" | "captions" | "transcript" | "notes" | "chapters" | "manifest";

export interface BundleItem {
  kind: BundleItemKind;
  fileName: string;
  /** 沒有這一項時填原因（會寫進清單，也會顯示在 UI 上）。 */
  skipped?: string;
}

export interface BundlePlanInput {
  /** 原始檔名（會去掉副檔名當前綴）。 */
  mediaName: string;
  audioFormat: string;
  captionFormat: CaptionFormat;
  hasTranscript: boolean;
  hasShowNotes: boolean;
  chapterCount: number;
  /** 使用者自己指定的名字；空白就用檔名。 */
  stem?: string;
}

/** 發布包的檔名前綴。使用者沒指定就用原始檔名（去副檔名），洗成安全字元。 */
export function bundleStem(input: BundlePlanInput): string {
  const raw = (input.stem ?? "").trim() || (input.mediaName ?? "").replace(/\.[^.]+$/, "");
  return safeFileName(raw) || "episode";
}

/**
 * 這一包會有哪些檔案、哪些沒帶到。
 *
 * **沒帶到的也要列出來**（帶 `skipped` 原因）。少一個檔案而清單上什麼都沒說，
 * 是上架前最難發現的那種錯。
 */
export function planBundle(input: BundlePlanInput): BundleItem[] {
  const stem = bundleStem(input);
  const items: BundleItem[] = [{ kind: "audio", fileName: `${stem}.${input.audioFormat}` }];

  const capExt = CAPTION_EXT[input.captionFormat];
  items.push(
    input.hasTranscript
      ? { kind: "captions", fileName: `${stem}.${capExt}` }
      : { kind: "captions", fileName: `${stem}.${capExt}`, skipped: "這一集還沒有逐字稿，做不出字幕" },
  );
  items.push(
    input.hasTranscript
      ? { kind: "transcript", fileName: `${stem}-transcript.md` }
      : { kind: "transcript", fileName: `${stem}-transcript.md`, skipped: "這一集還沒有逐字稿" },
  );
  items.push(
    input.hasShowNotes
      ? { kind: "notes", fileName: `${stem}-shownotes.md` }
      : { kind: "notes", fileName: `${stem}-shownotes.md`, skipped: "還沒產節目筆記（工具列「節目筆記」）" },
  );
  items.push(
    input.chapterCount > 0
      ? { kind: "chapters", fileName: `${stem}-chapters.txt` }
      : { kind: "chapters", fileName: `${stem}-chapters.txt`, skipped: "這一集沒有章節標記" },
  );
  items.push({ kind: "manifest", fileName: `${stem}-README.md` });
  return items;
}

export function includedItems(items: BundleItem[]): BundleItem[] {
  return items.filter((i) => !i.skipped);
}

export interface ManifestInput {
  stem: string;
  mediaName: string;
  items: BundleItem[];
  /** 成品長度（ms）。 */
  outMs: number;
  srcMs: number;
  targetLufs: number;
  /** 輸出後量到的整體響度；沒有就 null。 */
  measuredLufs?: number | null;
  chapters: { outMs: number; title: string }[];
  speakers: { label: string; share: number }[];
  findings: PreflightFinding[];
  generatedAt: Date;
}

function hhmmss(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/**
 * 清單檔（`-README.md`）。
 *
 * 這份檔案要能單獨看懂 —— 三個月後翻出這個資料夾，光看它就知道這一包是什麼、
 * 少了什麼、能不能直接上架。所以**沒帶到的項目與交付前檢查一定要寫進去**。
 */
export function renderManifest(i: ManifestInput): string {
  const L: string[] = [];
  L.push(`# ${i.stem}`, "");
  L.push(`- 來源：\`${i.mediaName}\``);
  L.push(`- 長度：${hhmmss(i.outMs)}（來源 ${hhmmss(i.srcMs)}，剪掉 ${hhmmss(Math.max(0, i.srcMs - i.outMs))}）`);
  L.push(
    `- 響度目標：${i.targetLufs} LUFS` +
      (i.measuredLufs == null ? "" : `，輸出後量到 ${i.measuredLufs.toFixed(1)} LUFS`),
  );
  L.push(`- 產生時間：${i.generatedAt.toISOString()}`);
  L.push("");

  L.push("## 這一包有什麼", "");
  for (const it of i.items) {
    L.push(it.skipped ? `- ~~\`${it.fileName}\`~~ —— 沒有：${it.skipped}` : `- \`${it.fileName}\``);
  }
  L.push("");

  if (i.speakers.length) {
    L.push("## 講者", "");
    for (const s of i.speakers) L.push(`- ${s.label}　${Math.round(s.share * 100)}%`);
    L.push("");
  }

  if (i.chapters.length) {
    L.push("## 章節", "");
    for (const c of i.chapters) L.push(`- \`${hhmmss(c.outMs)}\`　${c.title}`);
    L.push("");
  }

  L.push("## 交付前檢查", "");
  if (!i.findings.length) {
    L.push("沒有發現問題。");
  } else {
    for (const f of i.findings) {
      const tag = f.severity === "blocker" ? "**擋下**" : f.severity === "warning" ? "注意" : "提醒";
      L.push(`- ${tag}：${f.title}${f.detail ? ` —— ${f.detail}` : ""}`);
    }
  }
  L.push("");
  return L.join("\n");
}

/** 章節清單（給 YouTube 說明欄 / Apple Podcasts 貼上用的純文字）。 */
export function renderChapterList(chapters: { outMs: number; title: string }[]): string {
  // YouTube 的規矩：第一個章節一定要是 0:00，不然整份都不會生效
  const lines = chapters.map((c) => `${hhmmss(c.outMs)} ${c.title}`);
  if (chapters.length && chapters[0].outMs > 0) lines.unshift("0:00 開頭");
  return lines.join("\n") + "\n";
}
