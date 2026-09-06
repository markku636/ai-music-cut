import { useMemo } from "react";
import { create } from "zustand";
import { outputLanguageLine, resolveOutputLang, type OutputLangMode } from "./analysis/lang";

// 介面語言。以「繁中原文」作為 translation key，查無翻譯時回傳 key 本身（identity fallback）。
export type Lang = "zh-TW" | "zh-Hans" | "ja" | "en";

const LANG_KEY = "aicut:lang";
const AI_LANG_KEY = "aicut:aiLang";

export const LANGUAGES: readonly { id: Lang; label: string }[] = [
  { id: "zh-TW", label: "繁體中文" },
  { id: "zh-Hans", label: "简体中文" },
  { id: "ja", label: "日本語" },
  { id: "en", label: "English" },
];

export interface Plural {
  one: string;
  other: string;
}

export type Catalog = Readonly<Record<string, string | Plural>>;
export type Params = Readonly<Record<string, string | number>>;

function isLang(v: unknown): v is Lang {
  return LANGUAGES.some((l) => l.id === v);
}

/** 讀取偏好；無 / 不合法一律回 zh-TW。 */
export function readStoredLang(): Lang {
  try {
    const v = localStorage.getItem(LANG_KEY);
    if (isLang(v)) return v;
  } catch {
    /* localStorage 不可用時退回預設 */
  }
  return "zh-TW";
}

/** 以 `{name}` 為佔位符做執行期取代。 */
export function interpolate(tpl: string, params?: Params): string {
  if (!params) return tpl;
  return tpl.replace(/\{(\w+)\}/g, (whole, key: string) => (key in params ? String(params[key]) : whole));
}

function selectForm(value: string | Plural, params?: Params): string {
  if (typeof value === "string") return value;
  return params && Number(params.n) === 1 ? value.one : value.other;
}

interface LangStore {
  lang: Lang;
  catalog: Catalog;
  setLang: (l: Lang) => Promise<void>;
  /**
   * AI 產出（節目筆記、章節標題）要用哪一種語言。
   *
   * 預設 "media" —— 跟著這一集的語言走。節目筆記與章節是**給聽眾看的**，
   * 聽眾講什麼語言就寫什麼語言；跟著介面走的話，一個用繁中介面剪日文節目的人
   * 會拿到一份聽眾看不懂的筆記。
   * 判讀理由不走這個設定：那是給剪輯的人看的，一律跟著介面。
   */
  aiLang: OutputLangMode;
  setAiLang: (m: OutputLangMode) => void;
}

function readStoredAiLang(): OutputLangMode {
  try {
    const v = localStorage.getItem(AI_LANG_KEY);
    if (v) return v as OutputLangMode;
  } catch {
    /* localStorage 不可用 */
  }
  return "media";
}

const LOADERS: Record<Exclude<Lang, "zh-TW">, () => Promise<{ default: Catalog }>> = {
  en: () => import("./locales/en"),
  "zh-Hans": () => import("./locales/zh-Hans"),
  ja: () => import("./locales/ja"),
};

async function loadCatalog(l: Lang): Promise<Catalog> {
  if (l === "zh-TW") return {};
  return (await LOADERS[l]()).default;
}

export const useLang = create<LangStore>((set) => ({
  lang: readStoredLang(),
  catalog: {},
  aiLang: readStoredAiLang(),
  setAiLang: (m) => {
    try {
      localStorage.setItem(AI_LANG_KEY, m);
    } catch {
      /* ignore */
    }
    set({ aiLang: m });
  },
  setLang: async (l) => {
    const catalog = await loadCatalog(l);
    try {
      localStorage.setItem(LANG_KEY, l);
    } catch {
      /* ignore */
    }
    applyDocLang(l);
    // 同步進 settings.json（延遲 import：i18n.ts 不靜態相依 Tauri runtime，單元測試不會拉進 api）。
    void import("./store/settings")
      .then((m) => m.useSettings.getState().save({ lang: l }))
      .catch(() => {});
    set({ lang: l, catalog });
  },
}));

function resolve(s: Pick<LangStore, "catalog">, zh: string, params?: Params): string {
  const hit = s.catalog[zh];
  return interpolate(hit === undefined ? zh : selectForm(hit, params), params);
}

/** 翻譯（module-level，可在 React 之外呼叫）。 */
export function t(zh: string, params?: Params): string {
  return resolve(useLang.getState(), zh, params);
}

/** 元件內用：訂閱語言，使切換時重繪（參考身分綁在 catalog 上，可放進 memo 依賴）。 */
export function useT(): typeof t {
  const catalog = useLang((s) => s.catalog);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo<typeof t>(() => (zh, params) => t(zh, params), [catalog]);
}

export function htmlLangAttr(l: string): string {
  if (l.startsWith("en")) return "en";
  if (l.startsWith("ja")) return "ja";
  // 简体要標成 zh-Hans：瀏覽器與螢幕閱讀器依這個挑字體與發音，
  // 標錯的話簡體內容會被套上繁體字型（同一個碼位在兩地字形不同，看起來就是怪）
  if (l.includes("Hans") || l.includes("CN")) return "zh-Hans";
  return "zh-Hant";
}

/**
 * AI 產出的語言指示（節目筆記 / 章節）。呼叫端把它接在 prompt 上。
 * 依 `aiLang` 設定、這一集的語言與介面語言決定。
 */
export function aiOutputLanguage(mediaLang: string | null | undefined): string {
  const s = useLang.getState();
  return resolveOutputLang(s.aiLang, mediaLang, s.lang);
}

/** 介面語言的 LLM 指示（判讀理由、助手回覆用 —— 那些是給剪輯的人看的）。 */
export function uiLanguageLine(): string {
  return outputLanguageLine(resolveOutputLang("ui", null, useLang.getState().lang));
}

export function applyDocLang(l: Lang): void {
  document.documentElement.lang = htmlLangAttr(l);
}
