#!/usr/bin/env node
// i18n 稽核：找出「畫面上會出現、但沒有進翻譯目錄」的中文字串。
//
// 為什麼需要兩種掃法：
// 1. `t("字面量")` —— 直接找得到。
// 2. `t(表[k])` —— 字串在**別的檔案**的標籤表裡（KIND_LABEL、ShortcutsHelp 的 ROWS、
//    主題名稱、復原標籤…）。只掃第 1 種的話，這些會整批漏掉，
//    症狀是切到日文之後畫面上冒出一片中文，而稽核卻說「零缺漏」。
//    這實際發生過（v0.42.0 之前）。
//
// 不該翻譯的東西要明確排除，不能靠「反正沒人會注意」：
// 語助詞偵測表（嗎 / 呢 / 對不對）與贅字詞庫是**資料**，翻掉會讓規則層失效。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 路徑有空白時 import.meta.url 會是 %20，一定要走 fileURLToPath
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const CJK = /[一-鿿]/;

/**
 * 標籤表所在的檔案：這些檔的中文字串多半是靠 t(變數) 翻的。
 * 以 "/" 結尾的是整個目錄（指令註冊表：每一條的 title / why 都是 zh key）。
 */
const TABLE_SOURCES = [
  "commands/",
  "dialogs/ShortcutsHelp.tsx",
  "analysis/types.ts",
  "analysis/effects.ts",
  "analysis/overlays.ts",
  "analysis/snap.ts",
  "preview/SnapMenu.tsx",
  "themes.ts",
  "dialogs/musicPresets.ts",
  "analysis/loudness/compliance.ts",
  "store/decisions.ts",
];

/** 這些是資料不是介面文字，翻掉會壞掉。 */
const NOT_UI = new Set(["嗎", "呢", "對不對", "是不是", "好不好", "行不行", "對嗎", "是嗎", "好嗎"]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const catalog = readFileSync(join(SRC, "locales", "en.ts"), "utf8");
const have = new Set([...catalog.matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:/gm)].map((m) => m[1]));

const missing = [];
for (const file of walk(SRC)) {
  const rel = file.slice(SRC.length + 1).replace(/\\/g, "/");
  if (rel.startsWith("locales/")) continue;
  const text = readFileSync(file, "utf8");

  for (const m of text.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)+)"/g)) {
    if (CJK.test(m[1]) && !have.has(m[1]) && !NOT_UI.has(m[1])) missing.push({ rel, s: m[1], via: "t()" });
  }

  if (TABLE_SOURCES.some((s) => (s.endsWith("/") ? rel.startsWith(s) : rel === s))) {
    for (const line of text.split("\n")) {
      const st = line.trim();
      if (st.startsWith("//") || st.startsWith("*") || st.startsWith("/*")) continue;
      for (const m of line.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
        const s = m[1].trim();
        if (s && CJK.test(s) && !have.has(s) && !NOT_UI.has(s)) missing.push({ rel, s, via: "label table" });
      }
    }
  }
}

const seen = new Set();
const uniq = missing.filter((x) => !seen.has(x.s) && seen.add(x.s));

if (uniq.length) {
  console.error(`[check-i18n] ${uniq.length} 個字串沒有進 en 目錄：`);
  // --all：全部列出（補翻譯時用）
  const limit = process.argv.includes("--all") ? Infinity : 40;
  for (const x of uniq.slice(0, limit)) console.error(`  ${x.rel} (${x.via}): ${x.s}`);
  if (uniq.length > limit) console.error(`  …還有 ${uniq.length - limit} 個`);
  process.exit(1);
}

// 其他語言可以落後（identity fallback 會回退到繁中原文，不會壞），但要說出來
const sizes = { en: have.size };
for (const lang of ["ja", "zh-Hans"]) {
  try {
    const t = readFileSync(join(SRC, "locales", `${lang}.ts`), "utf8");
    sizes[lang] = [...t.matchAll(/^\s*"((?:[^"\\]|\\.)*)"\s*:/gm)].length;
  } catch {
    sizes[lang] = 0;
  }
}
console.log(`[check-i18n] OK（en ${sizes.en}、ja ${sizes.ja}、zh-Hans ${sizes["zh-Hans"]}）`);
