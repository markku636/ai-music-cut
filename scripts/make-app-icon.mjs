// 產生 App 圖示來源 PNG（1024²）：漸層圓角方塊 + 波形 + 剪掉的兩根（虛線切痕）。
// 之後 `npx tauri icon src-tauri/app-icon.png` 生成各平台 icons/。
import sharp from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "src-tauri/app-icon.png");

const bars = [18, 34, 58, 82, 60, 40, 72, 96, 70, 46, 30, 54, 80, 62, 36, 20];
const barW = 30;
const gap = 18;
const total = bars.length * barW + (bars.length - 1) * gap;
const x0 = (1024 - total) / 2;
const cy = 512;
const rects = bars
  .map((h, i) => {
    const x = x0 + i * (barW + gap);
    const hh = h * 3.4;
    const cut = i === 9 || i === 10;
    return `<rect x="${x}" y="${cy - hh / 2}" width="${barW}" height="${hh}" rx="${barW / 2}" fill="${cut ? "rgba(248,248,242,0.28)" : "#F8F8F2"}"/>`;
  })
  .join("");
const cutX = x0 + 9 * (barW + gap) - gap / 2;
const cutX2 = x0 + 11 * (barW + gap) - gap / 2;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#9580FF"/>
      <stop offset="1" stop-color="#3B2E7A"/>
    </linearGradient>
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="200" fill="url(#g)"/>
  ${rects}
  <path d="M${cutX} 200 L${cutX} 824" stroke="#FF9580" stroke-width="14" stroke-dasharray="28 22" stroke-linecap="round"/>
  <path d="M${cutX2} 200 L${cutX2} 824" stroke="#FF9580" stroke-width="14" stroke-dasharray="28 22" stroke-linecap="round"/>
</svg>`;

mkdirSync(dirname(out), { recursive: true });
const png = await sharp(Buffer.from(svg)).png().toBuffer();
writeFileSync(out, png);
console.log("wrote", out, png.length, "bytes");
