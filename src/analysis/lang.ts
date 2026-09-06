/**
 * AI 產出要用哪一種語言。
 *
 * 三個語言在這個 App 裡是**互相獨立**的，混在一起就會出現「日文 podcast 配一份繁中節目筆記」：
 * - **介面語言**：使用者選的（繁中 / English / 日本語 / 简体）。
 * - **節目語言**：這一集在講什麼語言，由 ASR 回報（`Transcript.language`）。
 * - **產出語言**：AI 寫出來的東西（節目筆記、章節標題、判讀理由）要用哪一種。
 *
 * 預設是**跟著節目**：節目筆記與章節是要給聽眾看的，聽眾講什麼語言就寫什麼語言。
 * 判讀理由則不同 —— 那是給剪輯的人看的，所以跟著介面。呼叫端自己選要用哪一種。
 */

/** ASR 回報的語言代碼（whisper 用 ISO 639-1，中文只會回 "zh" 不分繁簡）。 */
export type LangCode = string;

export type OutputLangMode =
  /** 跟著這一集的語言（ASR 偵測）；偵測不到就退回介面語言。 */
  | "media"
  /** 跟著介面語言。 */
  | "ui"
  /** 指定一個固定語言。 */
  | LangCode;

interface LangInfo {
  /** 給人看的名字（用該語言自己的寫法）。 */
  name: string;
  /** 給 LLM 的指示。 */
  instruction: string;
}

/**
 * 明確支援的語言。查不到的代碼**不會**被硬塞成中文 ——
 * 那正是「日文 podcast 拿到繁中筆記」的成因。查不到就用代碼本身叫 LLM 照著寫。
 */
const LANGS: Record<string, LangInfo> = {
  "zh-Hant": { name: "繁體中文", instruction: "用繁體中文書寫。" },
  "zh-Hans": { name: "简体中文", instruction: "用简体中文书写。" },
  ja: { name: "日本語", instruction: "日本語で書いてください。" },
  en: { name: "English", instruction: "Write in English." },
  ko: { name: "한국어", instruction: "한국어로 작성하세요." },
  es: { name: "Español", instruction: "Escribe en español." },
  fr: { name: "Français", instruction: "Écris en français." },
  de: { name: "Deutsch", instruction: "Schreibe auf Deutsch." },
};

/**
 * 把各種寫法收斂成一個標準代碼。
 *
 * ASR 回 "zh" 是不分繁簡的 —— 這時**不能**猜。用介面語言當線索：
 * 使用者的介面是简体，那他的中文節目筆記也該是简体。沒有線索才預設繁體
 * （這個 App 的原生語言）。
 */
export function normalizeLangCode(code: string | null | undefined, uiHint?: string): string {
  const raw = (code ?? "").trim().toLowerCase().replace("_", "-");
  if (!raw) return "";
  if (raw.startsWith("zh")) {
    if (raw.includes("hant") || raw.includes("tw") || raw.includes("hk") || raw.includes("mo")) return "zh-Hant";
    if (raw.includes("hans") || raw.includes("cn") || raw.includes("sg")) return "zh-Hans";
    // 只有 "zh"：看介面語言的臉色
    const ui = (uiHint ?? "").toLowerCase();
    return ui.includes("hans") || ui.includes("cn") ? "zh-Hans" : "zh-Hant";
  }
  const base = raw.split("-")[0];
  return base in LANGS ? base : base;
}

/** 決定這一次產出要用哪一種語言。 */
export function resolveOutputLang(mode: OutputLangMode, mediaLang: string | null | undefined, uiLang: string): string {
  const ui = normalizeLangCode(uiLang) || "zh-Hant";
  if (mode === "ui") return ui;
  if (mode === "media") return normalizeLangCode(mediaLang, uiLang) || ui;
  return normalizeLangCode(mode, uiLang) || ui;
}

/** 給人看的語言名稱；不認識的代碼就回代碼本身（不要假裝認識）。 */
export function languageName(code: string): string {
  return LANGS[code]?.name ?? code ?? "";
}

/**
 * 給 LLM 的「用這個語言寫」指示。
 *
 * 不認識的語言不回空字串 —— 那等於沒有指示，LLM 會用 prompt 本身的語言（中文）作答。
 * 改成用代碼叫它照著寫，至少方向是對的。
 */
export function outputLanguageLine(code: string): string {
  if (!code) return "";
  return LANGS[code]?.instruction ?? `Write in the language with BCP-47 code "${code}".`;
}

/** 這個語言是不是我們有明確指示的（UI 用來提示「這一集偵測到的語言我們沒見過」）。 */
export function isKnownLanguage(code: string): boolean {
  return !!LANGS[code];
}

/** 可以指定的語言清單（UI 下拉用）。 */
export function pickableLanguages(): { code: string; name: string }[] {
  return Object.entries(LANGS).map(([code, info]) => ({ code, name: info.name }));
}
