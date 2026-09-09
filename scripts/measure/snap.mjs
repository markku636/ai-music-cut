// 吸附吸得準不準？拿**你自己的錄音**量。
//
// 要問的是兩件事：
//  ① 拖曳一次要掃多少目標、掃多久（會不會拖起來卡）
//  ② 瞄著既有的接縫拖過去時，會不會被更近的字界搶走
//
// ② 才是真正會咬人的：中文沒有空格，辨識器給的字界密到每 200 ms 左右一個，
// 整段適配時容差是 140 ms —— 純比距離的話幾乎永遠吸到字界，
// 而使用者是瞄著那一刀去的（v0.124 之前 36/100 會被搶走）。
import { connect, sleep, waitReady } from "./cdp.mjs";

const c = await connect(Number(process.env.AICUT_CDP_PORT ?? 9222));
const id = await waitReady(c, { analysis: true });

const r = await c.ev(`(async () => {
  const snap = await import("/src/analysis/snap.ts");
  const ts = __aicut.transcript.getState();
  const tr = ts.byMedia?.[${JSON.stringify(id)}] ?? ts.transcripts?.[${JSON.stringify(id)}];
  if (!tr) return { err: "沒有逐字稿" };
  const edl = __aicut.edlFor(${JSON.stringify(id)});
  const seams = (edl?.keeps ?? []).slice(0, -1).map((k) => k.srcEndMs);
  const targets = snap.collectTargets(
    { words: tr.words, sentences: tr.sentences, seams, markers: [], playheadMs: null, durationMs: tr.durationMs },
    snap.ALL_SNAP,
  );

  // 字界密度：相鄰兩個字界之間隔多久
  const wordEdges = tr.words.flatMap((w) => [w.startMs, w.endMs]).sort((a, b) => a - b);
  const dens = [];
  for (let i = 1; i < wordEdges.length; i++) if (wordEdges[i] > wordEdges[i - 1]) dens.push(wordEdges[i] - wordEdges[i - 1]);
  dens.sort((a, b) => a - b);

  const tolFit = snap.toleranceMs(30);
  const ctx = { enabled: true, targets, grid: null, tolMs: tolFit };

  // 掃描成本
  const t0 = performance.now();
  for (let i = 0; i < 300; i++) snap.snapValue((i / 300) * (tr.durationMs || 1) + 37, ctx);
  const perCall = (performance.now() - t0) / 300;

  // 瞄準接縫：站在旁邊 30 ms 拖，會不會被搶走
  let stolen = 0, tried = 0;
  for (const s of seams.slice(0, 200)) {
    tried++;
    if (snap.snapValue(s + 30, ctx).kind !== "seam") stolen++;
  }
  return {
    name: __aicut.project.getState().media[0]?.name,
    targets: targets.length, seams: seams.length,
    medianWordGap: dens.length ? dens[Math.floor(dens.length / 2)] : null,
    tolFit: Math.round(tolFit), tolZoom: Math.round(snap.toleranceMs(400)),
    perCall: +perCall.toFixed(3), stolen, tried,
  };
})()`);

if (r.err) {
  console.error(r.err);
  c.close();
  process.exit(1);
}

console.log(`${r.name}：吸附目標 ${r.targets} 個（其中接縫 ${r.seams} 個）`);
console.log(`字界密度：中位 ${r.medianWordGap} ms 一個　容差：整段適配 ${r.tolFit} ms、放大 400 px/s 時 ${r.tolZoom} ms`);
console.log(`拖曳一次掃一輪：${r.perCall} ms`);
if (r.perCall > 2) console.log("  ⚠ 超過 2 ms，拖曳可能會有感 —— 目標清單該改成排序 + 二分");
console.log(`\n瞄著接縫拖（旁邊 30 ms）：${r.tried} 次裡有 ${r.stolen} 次被別的目標搶走`);
if (r.tried && r.stolen / r.tried > 0.1) console.log("  ⚠ 超過一成 —— 回頭看 snap.ts 的 BIAS");
else if (r.tried) console.log("  OK：結構性邊界贏得過密集的字界");

await sleep(50);
c.close();
