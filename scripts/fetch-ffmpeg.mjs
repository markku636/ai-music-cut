// 把 LGPL 版 ffmpeg / ffprobe 抓下來放進 src-tauri/resources/ffmpeg/，讓 Windows 安裝檔自帶。
// CI 在 tauri-action 之前跑這支；本機開發不需要（沒有內建版就退回 PATH）。
//
// 三個硬性 gate，任何一個沒過就 exit 1（寧可 build 失敗，也不要出一個裝不起來或授權有問題的安裝檔）：
//   1. sha256 必須完全吻合 manifest（供應鏈）。
//   2. 解壓後必須同時有 ffmpeg.exe 與 ffprobe.exe（ffprobe 缺了 Rust 端是靜默丟棄那個候選）。
//   3. `ffmpeg -version` 的 configuration 必須含 --enable-libmp3lame 與 --enable-shared。
//
// 用法：
//   node scripts/fetch-ffmpeg.mjs              下載 / 驗證 / 解壓（已是最新則跳過）
//   node scripts/fetch-ffmpeg.mjs --force      忽略 stamp 重來
//   node scripts/fetch-ffmpeg.mjs --print-sha  只印出 URL 的 sha256（換版本時用）
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "scripts", "ffmpeg-manifest.json"), "utf8"));
const outDir = join(root, "src-tauri", "resources", "ffmpeg");
const stampPath = join(outDir, ".stamp");
const args = process.argv.slice(2);
const force = args.includes("--force");
const printSha = args.includes("--print-sha");

const log = (m) => console.log(`[ffmpeg] ${m}`);
const die = (m) => {
  console.error(`[ffmpeg] ${m}`);
  process.exit(1);
};

async function download(url) {
  log(`下載 ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) die(`下載失敗 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  log(`收到 ${(buf.length / 1048576).toFixed(1)} MB`);
  return buf;
}

/**
 * 只讀中央目錄的極簡 ZIP 解析（避免為了一支 build 腳本多裝依賴，也不依賴系統 unzip）。
 * 檔案 < 4 GB 所以不需要處理 zip64。
 */
function* zipEntries(buf) {
  // End of Central Directory：從尾端往回找簽章（最多 64 KB 的註解）
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) die("不是有效的 zip（找不到 EOCD）");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) die("中央目錄壞掉");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    yield {
      name,
      read() {
        if (buf.readUInt32LE(localOff) !== 0x04034b50) die(`local header 壞掉：${name}`);
        const lNameLen = buf.readUInt16LE(localOff + 26);
        const lExtraLen = buf.readUInt16LE(localOff + 28);
        const start = localOff + 30 + lNameLen + lExtraLen;
        const raw = buf.subarray(start, start + compSize);
        if (method === 0) return raw;
        if (method === 8) return inflateRawSync(raw);
        die(`不支援的壓縮方式 ${method}：${name}`);
      },
    };
  }
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const zip = await download(manifest.url);
const got = sha256(zip);

if (printSha) {
  console.log(got);
  process.exit(0);
}

if (got !== manifest.sha256) {
  die(
    `sha256 不符 —— 拒絕使用。\n  manifest: ${manifest.sha256}\n  實際:     ${got}\n` +
      "若確定是刻意換版，請更新 scripts/ffmpeg-manifest.json（--print-sha 可取得新值）。",
  );
}
log(`sha256 OK ${got.slice(0, 16)}…`);

if (!force && existsSync(stampPath) && readFileSync(stampPath, "utf8").trim() === manifest.sha256) {
  log("已是 manifest 指定的版本，跳過解壓");
  process.exit(0);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const wantDir = `/${manifest.zipDir}/`;
const skip = new Set(manifest.skip ?? []);
let written = 0;
for (const e of zipEntries(zip)) {
  if (!e.name.includes(wantDir)) continue;
  const base = e.name.slice(e.name.lastIndexOf("/") + 1);
  if (skip.has(base)) continue;
  writeFileSync(join(outDir, base), e.read());
  written++;
}
log(`解出 ${written} 個檔案到 src-tauri/resources/ffmpeg/`);

// ffprobe 必須跟 ffmpeg 同一層 —— Rust 端的 sibling_probe 找不到 ffprobe 會靜默丟棄整個候選，
// 症狀是「明明有內建 ffmpeg 卻還是說找不到」，非常難查。
for (const need of ["ffmpeg.exe", "ffprobe.exe"]) {
  if (!existsSync(join(outDir, need))) die(`解壓後缺少 ${need}`);
}

// 只有 Windows 跑得起來這兩顆 exe；在別的平台上先信任 sha256，其餘由 CI 的 Windows job 把關。
if (process.platform === "win32") {
  let out = "";
  try {
    out = execFileSync(join(outDir, "ffmpeg.exe"), ["-version"], { encoding: "utf8", windowsHide: true });
  } catch (e) {
    die(`ffmpeg -version 跑不起來（DLL 缺了？）：${e.message}`);
  }
  for (const flag of manifest.requireConfigureFlags ?? []) {
    if (!out.includes(flag)) die(`這份 build 沒有 ${flag}，不能用`);
  }
  log(out.split("\n")[0].trim());
} else {
  log(`非 Windows（${process.platform}）：跳過執行驗證`);
}

writeFileSync(stampPath, `${manifest.sha256}\n`);
log(`完成（${manifest.version}, ${manifest.license}）`);
