// push 前的祕密掃描：只掃 git 追蹤的檔案，找 API key / token 樣式與不該入庫的檔名。
// 有命中就 exit 1（npm run check 會擋）。
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execSync("git ls-files", { encoding: "utf-8" })
  .split(/\r?\n/)
  .filter(Boolean);

const badNames = files.filter((f) => /(^|\/)\.env(\..*)?$/.test(f) && !f.endsWith(".env.example"))
  .concat(files.filter((f) => f.endsWith(".aicut.json")));

const patterns = [
  { name: "X-API-Key literal", re: /x-api-key\s*[:=]\s*["']?[A-Za-z0-9_\-]{12,}/i },
  { name: "TTS_API_KEY value", re: /(AICUT_TTLS_API_KEY|TTS_API_KEY)\s*=\s*["']?[A-Za-z0-9_\-]{8,}/ },
  { name: "Anthropic key", re: /sk-ant-[A-Za-z0-9_\-]{20,}/ },
  { name: "generic sk- key", re: /\bsk-[A-Za-z0-9]{24,}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "Bearer literal", re: /Bearer\s+[A-Za-z0-9_\-\.]{24,}/ },
];

const hits = [];
for (const f of files) {
  if (/\.(png|ico|icns|jpg|jpeg|webp|woff2?|mp3|wav|ogg|lock)$/i.test(f)) continue;
  let text;
  try {
    text = readFileSync(f, "utf-8");
  } catch {
    continue;
  }
  for (const p of patterns) {
    const m = text.match(p.re);
    if (m) hits.push(`${f}: ${p.name} → ${m[0].slice(0, 24)}…`);
  }
}

if (badNames.length || hits.length) {
  console.error("[check-secrets] 發現不該入庫的內容：");
  for (const n of badNames) console.error("  tracked secret file:", n);
  for (const h of hits) console.error("  ", h);
  process.exit(1);
}
console.log(`[check-secrets] OK（掃描 ${files.length} 個檔案）`);
