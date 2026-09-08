// 找出用了「顏色表裡不存在的語意色」的 Tailwind class。
//
// 為什麼需要這個檢查：Tailwind 對不存在的顏色**不會報錯**，只是不產生任何 CSS。
// 症狀是 `bg-bg` 這種 class 靜靜地變成 rgba(0,0,0,0) —— 浮動選單完全沒有底色、
// 背後的內容透出來，而 tsc / eslint 都不會說一句話。實際發生過：ModelMenu、
// RoleMixMenu、SnapMenu 三個選單同時沒有背景，是拍截圖時才看出來的。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CONFIG = path.join(ROOT, "tailwind.config.js");

const cfg = fs.readFileSync(CONFIG, "utf8");
const block = cfg.slice(cfg.indexOf("colors:"), cfg.indexOf("}", cfg.indexOf("kind-manual")));
const SEMANTIC = new Set([...block.matchAll(/^\s*"?([a-z0-9-]+)"?\s*:/gm)].map((m) => m[1]).filter((k) => k !== "colors"));

// Tailwind 內建色 + 特殊值：這些不是專案語意色，但都是合法的
const BUILTIN = new Set([
  "transparent", "current", "inherit", "black", "white", "slate", "gray", "zinc", "neutral", "stone",
  "red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue",
  "indigo", "violet", "purple", "fuchsia", "pink", "rose",
]);

// 同一個前綴在 Tailwind 裡同時是顏色與非顏色工具（border-l 是邊、border-accent 是色），
// 所以要把非顏色的那些排掉，否則整份掃出來全是雜訊。
const NOT_A_COLOUR = new Set([
  // 方向 / 尺寸 / 樣式
  "l", "r", "t", "b", "x", "y", "s", "e", "solid", "dashed", "dotted", "double", "hidden", "none",
  "collapse", "separate", "spacing", "inset", "offset",
  // 字級 / 對齊 / 換行
  "xs", "sm", "base", "lg", "xl", "left", "center", "right", "justify", "start", "end",
  "wrap", "nowrap", "balance", "pretty", "ellipsis", "clip", "capitalize", "uppercase", "lowercase",
  // 背景定位 / 重複 / 漸層
  "cover", "contain", "fixed", "local", "scroll", "top", "bottom", "repeat", "gradient", "blend", "origin",
  // 陰影階梯（本專案自訂 e1..e5）
  "e1", "e2", "e3", "e4", "e5", "inner",
  "current", "auto",
]);
const PREFIXES = ["bg", "text", "border", "ring", "fill", "stroke", "decoration", "outline", "divide", "caret"];
const RE = new RegExp(`\\b(${PREFIXES.join("|")})-([a-z][a-z0-9-]*)(?:/[0-9.]+)?\\b`, "g");

const bad = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "target") continue;
      walk(p);
      continue;
    }
    if (!/\.(tsx|ts)$/.test(e.name) || /\.test\./.test(e.name)) continue;
    const src = fs.readFileSync(p, "utf8");
    src.split("\n").forEach((line, i) => {
      // 註解裡的範例不是真的 class（Icon.tsx 的說明就寫了 text-mysql 當例子）
      if (/^\s*(\*|\/\/)/.test(line)) return;
      // 任意值方括號裡是 CSS 屬性名，不是 class（transition-[…,border-color]）
      const scrubbed = line.replace(/\/\/.*$/, "").replace(/\[[^\]]*\]/g, "");
      for (const m of scrubbed.matchAll(RE)) {
        const [, prefix, name] = m;
        const head = name.split("-")[0];
        if (SEMANTIC.has(name) || SEMANTIC.has(head) || BUILTIN.has(head)) continue;
        if (NOT_A_COLOUR.has(name) || NOT_A_COLOUR.has(head)) continue;
        if (/^\d/.test(name) || /^\d/.test(name.split("-").pop())) continue; // border-2、text-2xl
        if (/^(2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl)$/.test(name)) continue;
        bad.push({ file: path.relative(ROOT, p).replace(/\\/g, "/"), line: i + 1, cls: `${prefix}-${name}` });
      }
    });
  }
}
walk(path.join(ROOT, "src"));

if (!bad.length) {
  console.log(`[check-theme-tokens] OK（語意色 ${SEMANTIC.size} 個）`);
  process.exit(0);
}
console.error(`[check-theme-tokens] ${bad.length} 個不存在的顏色 class（Tailwind 不會報錯，只會靜靜地不產生 CSS）：`);
for (const b of bad) console.error(`  ${b.file}:${b.line}  ${b.cls}`);
process.exit(1);
