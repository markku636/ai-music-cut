import { describe, expect, it } from "vitest";
import { isKnownLanguage, languageName, normalizeLangCode, outputLanguageLine, pickableLanguages, resolveOutputLang } from "./lang";

describe("normalizeLangCode", () => {
  it("認得明確的繁 / 简寫法", () => {
    expect(normalizeLangCode("zh-TW")).toBe("zh-Hant");
    expect(normalizeLangCode("zh-Hant")).toBe("zh-Hant");
    expect(normalizeLangCode("zh-HK")).toBe("zh-Hant");
    expect(normalizeLangCode("zh-CN")).toBe("zh-Hans");
    expect(normalizeLangCode("zh_Hans")).toBe("zh-Hans");
  });

  it("ASR 只回 \"zh\" 時看介面語言的臉色，不要亂猜", () => {
    // whisper 不分繁簡，所以要有第二個線索
    expect(normalizeLangCode("zh", "zh-CN")).toBe("zh-Hans");
    expect(normalizeLangCode("zh", "zh-TW")).toBe("zh-Hant");
    // 介面是英文之類的沒有線索 → 用這個 App 的原生語言
    expect(normalizeLangCode("zh", "en")).toBe("zh-Hant");
    expect(normalizeLangCode("zh")).toBe("zh-Hant");
  });

  it("其他語言取主碼", () => {
    expect(normalizeLangCode("ja")).toBe("ja");
    expect(normalizeLangCode("en-US")).toBe("en");
    expect(normalizeLangCode("ko-KR")).toBe("ko");
  });

  it("空值回空字串（讓呼叫端決定要退回什麼）", () => {
    expect(normalizeLangCode(null)).toBe("");
    expect(normalizeLangCode("")).toBe("");
    expect(normalizeLangCode("   ")).toBe("");
  });

  it("沒見過的語言原樣保留，不會被硬塞成中文", () => {
    // 這正是「日文 podcast 拿到繁中筆記」的成因，所以要有測試守著
    expect(normalizeLangCode("th")).toBe("th");
    expect(normalizeLangCode("vi-VN")).toBe("vi");
  });
});

describe("resolveOutputLang", () => {
  it("跟著節目：用 ASR 偵測到的語言", () => {
    expect(resolveOutputLang("media", "ja", "zh-TW")).toBe("ja");
    expect(resolveOutputLang("media", "en", "zh-TW")).toBe("en");
  });

  it("跟著節目但偵測不到 → 退回介面語言", () => {
    expect(resolveOutputLang("media", null, "en")).toBe("en");
    expect(resolveOutputLang("media", "", "ja")).toBe("ja");
  });

  it("跟著介面：不管節目講什麼", () => {
    expect(resolveOutputLang("ui", "ja", "zh-TW")).toBe("zh-Hant");
    expect(resolveOutputLang("ui", "en", "zh-CN")).toBe("zh-Hans");
  });

  it("指定固定語言時兩邊都不管", () => {
    expect(resolveOutputLang("en", "ja", "zh-TW")).toBe("en");
    expect(resolveOutputLang("zh-Hans", "ja", "en")).toBe("zh-Hans");
  });

  it("中文節目會跟著介面決定繁簡", () => {
    expect(resolveOutputLang("media", "zh", "zh-CN")).toBe("zh-Hans");
    expect(resolveOutputLang("media", "zh", "zh-TW")).toBe("zh-Hant");
  });

  it("什麼線索都沒有時預設繁體（這個 App 的原生語言）", () => {
    expect(resolveOutputLang("media", null, "")).toBe("zh-Hant");
  });
});

describe("outputLanguageLine", () => {
  it("每個支援的語言都有自己的指示，而且是用該語言寫的", () => {
    expect(outputLanguageLine("ja")).toContain("日本語");
    expect(outputLanguageLine("en")).toContain("English");
    expect(outputLanguageLine("zh-Hans")).toContain("简体");
    expect(outputLanguageLine("zh-Hant")).toContain("繁體");
  });

  it("沒見過的語言也要給指示，不能留空", () => {
    // 留空 = 沒有指示 = LLM 會用 prompt 本身的語言（中文）作答
    const line = outputLanguageLine("th");
    expect(line).not.toBe("");
    expect(line).toContain("th");
  });

  it("空代碼才回空字串", () => {
    expect(outputLanguageLine("")).toBe("");
  });
});

describe("languageName / isKnownLanguage / pickableLanguages", () => {
  it("名字用該語言自己的寫法", () => {
    expect(languageName("ja")).toBe("日本語");
    expect(languageName("zh-Hans")).toBe("简体中文");
  });

  it("不認識的代碼回代碼本身，不要假裝認識", () => {
    expect(languageName("th")).toBe("th");
    expect(isKnownLanguage("th")).toBe(false);
    expect(isKnownLanguage("ja")).toBe(true);
  });

  it("可挑選的清單涵蓋四個介面語言", () => {
    const codes = pickableLanguages().map((l) => l.code);
    for (const c of ["zh-Hant", "zh-Hans", "ja", "en"]) expect(codes).toContain(c);
  });
});
