// 呼吸回填的三個目標長度對不對？拿**你自己的錄音**量。
//
// 「句中 170 / 句尾 340 / 段落 575 ms」這種數字沒有辦法用推理決定 ——
// 只能問「真人在這三種位置原本停多久」。這支就是去問。
//
// 這份 repo 目前的數字是拿一段 90 秒的中文錄音量出來的（見 v0.127 的 commit）。
// 一段錄音不足以定案：換一個講話節奏不同的人、換一種語言，答案可能不一樣。
// 覺得剪出來太趕或太拖的時候，先跑這支，再決定要不要調 breath.ts 的常數。
import { connect, sleep, stat, waitReady } from "./cdp.mjs";

const c = await connect(Number(process.env.AICUT_CDP_PORT ?? 9222));
const id = await waitReady(c, { analysis: true });

const r = await c.ev(`(async () => {
  const b = await import("/src/analysis/edl/breath.ts");
  const ts = __aicut.transcript.getState();
  const tr = ts.byMedia?.[${JSON.stringify(id)}] ?? ts.transcripts?.[${JSON.stringify(id)}];
  if (!tr) return { err: "沒有逐字稿" };
  const words = tr.words, sentences = tr.sentences;
  const buckets = { within: [], sentence: [], paragraph: [] };
  for (let i = 0; i + 1 < words.length; i++) {
    const gap = words[i + 1].startMs - words[i].endMs;
    if (gap <= 0) continue;
    buckets[b.breathContextAt(sentences, words[i].endMs, words[i + 1].startMs)].push(Math.round(gap));
  }
  return {
    name: __aicut.project.getState().media[0]?.name,
    words: words.length, sentences: sentences.length,
    buckets, opts: b.DEFAULT_BREATH_OPTIONS, paragraphGapMs: b.PARAGRAPH_GAP_MS,
  };
})()`);

if (r.err) {
  console.error(r.err);
  c.close();
  process.exit(1);
}

console.log(`${r.name}：${r.words} 字、${r.sentences} 句（段落門檻 ${r.paragraphGapMs} ms）\n`);
console.log("真人原本的停頓（ms）　vs　回填目標");
const row = (label, xs, target) => {
  const s = stat(xs);
  if (!s) return console.log(`${label.padEnd(6)} （這份錄音裡沒有這種位置）　　　　　　　　　← 目標 ${target}`);
  // 樣本太少就不下判斷：一段 90 秒的錄音裡「段落」可能只出現一次，
  // 拿一個點去說「常數錯了」比不說更糟。
  const MIN_N = 5;
  const off = s.median > target * 2 || s.median * 2 < target;
  const flag = !off ? "" : s.n < MIN_N ? `  （只有 ${s.n} 個樣本，看看就好）` : "  ⚠ 差一倍以上";
  console.log(
    `${label.padEnd(6)} n=${String(s.n).padStart(3)}　p10 ${String(s.p10).padStart(4)}　中位 ${String(s.median).padStart(4)}　` +
      `p75 ${String(s.p75).padStart(4)}　p90 ${String(s.p90).padStart(4)}　max ${String(s.max).padStart(5)}　← 目標 ${target}${flag}`,
  );
};
row("句中", r.buckets.within, r.opts.withinMs);
row("句尾", r.buckets.sentence, r.opts.sentenceMs);
row("段落", r.buckets.paragraph, r.opts.paragraphMs);

console.log(`
怎麼讀：目標落在中位與 p75 之間通常剛好 —— 剪輯本來就要比自然講話緊一點，
但緊過頭（遠低於中位）聽起來會很急促。標了 ⚠ 的那一行值得回頭看 breath.ts。`);

await sleep(50);
c.close();
