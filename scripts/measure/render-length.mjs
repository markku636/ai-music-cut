// 計畫說會產出多長，就真的產出多長嗎？
//
// **這支存在的理由是一次真實的失誤。** v0.97 我只驗了 TS 端的 `edl.stats.outMs`
// （那是「計畫」）就發版，實際渲染出來是計畫 35534 ms、成品 19372 ms ——
// 中間 16 秒憑空消失，而且沒有任何錯誤訊息。
//
// 所以驗輸出這件事，唯一算數的是**真的產生一個檔案再去量它**。
// 這支會依序輸出：原樣、貼上一段（亂序）、貼兩段，每一次都用 ffprobe 量。
import { connect, sleep, waitReady } from "./cdp.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OUT_DIR = process.env.AICUT_MEASURE_DIR ?? path.join(os.tmpdir(), "aicut-measure");
fs.mkdirSync(OUT_DIR, { recursive: true });

const durMs = (p) => {
  const s = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p]).toString().trim();
  return Math.round(parseFloat(s) * 1000);
};

const c = await connect(Number(process.env.AICUT_CDP_PORT ?? 9222));
const id = await waitReady(c);

let bad = 0;
async function render(tag) {
  const out = path.join(OUT_DIR, `measure-${tag}.wav`).replace(/\\/g, "/");
  if (fs.existsSync(out)) fs.unlinkSync(out);
  const plan = await c.ev(`(() => {
    const b = __aicut.buildRenderPlan(${JSON.stringify(id)}, { format: "wav", outPath: ${JSON.stringify(out)}, leveling: false, targetLufs: -16 });
    if (!b) return null;
    return { expectedOutMs: Math.round(b.expectedOutMs), segs: b.plan.segs.length, rearranged: !!b.edl.rearranged };
  })()`);
  if (!plan) throw new Error("建不出輸出計畫（媒體還沒探測？）");
  await c.ev(`__aicut.runRender(${JSON.stringify(id)}, { format: "wav", outPath: ${JSON.stringify(out)}, leveling: false, targetLufs: -16 })`);
  if (!fs.existsSync(out)) throw new Error(`${tag}：沒有產出檔案`);
  const actual = durMs(out);
  const diff = actual - plan.expectedOutMs;
  const ok = Math.abs(diff) <= 2;
  if (!ok) bad++;
  console.log(
    `${ok ? "OK  " : "FAIL"} ${tag.padEnd(11)} ${plan.segs} 段　亂序=${String(plan.rearranged).padEnd(5)}　` +
      `計畫 ${plan.expectedOutMs} ms → 成品 ${actual} ms（差 ${diff >= 0 ? "+" : ""}${diff}）`,
  );
  fs.unlinkSync(out);
}

await render("原樣");

// 貼上一段：讓 EDL 變成亂序，走 Rust 的隨機存取路徑
const dur = await c.ev(`__aicut.project.getState().media[0]?.probe?.duration_ms ?? 0`);
if (dur > 12_000) {
  await c.ev(`__aicut.decisions.getState().addPaste(${JSON.stringify(id)}, 2000, 5000, ${Math.round(dur * 0.6)})`);
  await sleep(200);
  await render("貼上一段");
  await c.ev(`__aicut.decisions.getState().addPaste(${JSON.stringify(id)}, 6000, 8000, ${Math.round(dur * 0.8)})`);
  await sleep(200);
  await render("貼上兩段");
  await c.ev(`(() => { const d = __aicut.decisions.getState(); for (const p of d.pastes[${JSON.stringify(id)}] ?? []) d.removePaste(${JSON.stringify(id)}, p.id); })()`);
} else {
  console.log("（檔案太短，跳過亂序那幾輪）");
}

console.log(bad === 0 ? "\n計畫與成品逐毫秒對得上。" : `\n有 ${bad} 輪對不上 —— 那是會安靜交出壞檔的那種錯，別放過。`);
c.close();
process.exit(bad === 0 ? 0 : 1);
