// 贅字規則在**你自己的錄音**上長什麼樣。
//
// 規則層不是二元的：每條規則給一個分數，再由激進度決定門檻。
// 所以「這條規則有沒有用」不能看程式碼，要看兩件事：
//   ① 它在真的逐字稿上**會不會觸發**（不觸發的話那段程式碼只是好看）
//   ② 觸發之後的分數落在門檻的哪一邊
//
// 特別要分清楚兩種「沒被剪」：
//   · **沒過門檻**：分數就是比這個激進度低，換一個激進度就會剪。
//   · **語境刻意壓低**：像「句首連接詞『然後』（節奏感，通常保留）」給 0.25、
//     「回答用語『對』，保留」給 0.15 —— 那些分支存在的意義就是不要剪掉不該剪的。
// 前者是滑桿的事，後者才是規則的智慧。混在一起看會以為規則很聰明，其實只是門檻高。
import { connect, waitReady } from "./cdp.mjs";

/** 分數 ≤ 這個值的分支，是規則刻意壓低要留下來的（不是「剛好沒過門檻」）。 */
const RESCUE_MAX_SCORE = 0.35;

const c = await connect(Number(process.env.AICUT_CDP_PORT ?? 9222));
const id = await waitReady(c, { analysis: true });

const r = await c.ev(`(async () => {
  const R = await import("/src/analysis/rules/index.ts");
  const T = await import("/src/analysis/thresholds.ts");
  const ts = __aicut.transcript.getState();
  const tr = ts.byMedia?.[${JSON.stringify(id)}] ?? ts.transcripts?.[${JSON.stringify(id)}];
  const local = ts.local[${JSON.stringify(id)}];
  if (!tr || !local) return { err: "沒有逐字稿或本機分析" };
  const windows = Array.from({ length: local.nWin }, (_, i) => ({
    tMs: i * local.hopMs, momentary: local.win[i * 3], shortTerm: local.win[i * 3 + 1], rmsDb: local.win[i * 3 + 2],
  }));
  const input = { transcript: tr, loudness: windows, loudnessHopMs: local.hopMs };
  const levels = {};
  for (const a of [0, 50, 100]) {
    const th = T.thresholdsFor(a);
    const cands = R.runRules(input, th).filter((x) => x.kind === "filler");
    levels[a] = { threshold: th.fillerAutoScore, total: cands.length, cut: cands.filter((x) => x.score >= th.fillerAutoScore).length };
  }
  // 分支明細用預設激進度
  const th = T.thresholdsFor(50);
  const byReason = {};
  for (const x of R.runRules(input, th).filter((y) => y.kind === "filler")) {
    const k = x.reason.replace(/「[^」]*」/g, "「…」");
    const b = (byReason[k] ??= { n: 0, score: x.score });
    b.n++;
  }
  return { name: __aicut.project.getState().media[0]?.name, words: tr.words.length, levels, byReason, threshold: th.fillerAutoScore };
})()`);

if (r.err) { console.error(r.err); c.close(); process.exit(1); }

console.log(`${r.name}：${r.words} 字\n`);
for (const a of [0, 50, 100]) {
  const l = r.levels[a];
  console.log(`激進度 ${String(a).padStart(3)}（門檻 ${l.threshold}）：贅字候選 ${l.total} 個，其中 ${l.cut} 個會自動剪`);
}

const rows = Object.entries(r.byReason).sort((a, b) => b[1].n - a[1].n);
const rescued = rows.filter(([, v]) => v.score <= RESCUE_MAX_SCORE);
console.log(`\n分支明細（激進度 50，門檻 ${r.threshold}）：`);
for (const [k, v] of rows) {
  const tag = v.score >= r.threshold ? "剪" : v.score <= RESCUE_MAX_SCORE ? "語境保留" : "沒過門檻";
  console.log(`  ${String(v.score).padStart(5)}　${String(v.n).padStart(3)} 次　${tag.padEnd(4)}　${k}`);
}

console.log(`\n語境刻意保留的分支：${rescued.length ? rescued.map(([k]) => k).join("、") : "這份錄音裡一個都沒觸發"}`);
if (!rescued.length) {
  console.log(`  —— 不代表那些規則沒用，只代表**這份錄音沒有那些句型**（句首「然後」、問句後的「對」…）。`);
  console.log(`     要判斷它們值不值得留，得換一份有那些句型的錄音再跑一次。`);
}
c.close();
