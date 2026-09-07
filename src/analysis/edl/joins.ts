// 輸出時間軸的唯一定義。
//
// 為什麼需要這個檔：接點的 crossfade 是「重疊」，不是「插入」——前一段的尾巴被扣住，
// 蓋在下一段的開頭上。舊版 build.ts 的 `out += k.srcEndMs - k.srcStartMs` 完全沒扣這段重疊，
// 每刀累積約 20 ms；剪 2–3 刀之後，spliceAudit 的 LAG_OK_MS = 25 就必定誤報「接縫對不上」。
//
// Rust 的 Cutter（render.rs）是真正在寫檔的那個狀態機，所以規則以它為準：
//   · 第 i 段的最後 hold_i 個 frame 被扣住當 tail，不直接寫出。
//   · crossfade 接點：tail 混進下一段開頭 → 淨損 hold_i 個 frame。
//   · gap 接點：tail 淡出寫出 + room tone + 下一段淡入 → 淨增 gap 長度。
//   · seam 接點（同一保留段內的響度單元邊界）：不淡不重疊 → 0。
//   · 最後一段的 tail 由結尾淡出寫回去 → 不影響總長。
//
// 夾限 `min(spec, prevLen/2, nextLen/2)` 兩邊都要：只夾前一段的話，下一段太短時
// Cutter 會在混音沒跑完就結束、把剩下的 tail 直接補寫出來，長度就對不起來了。
// 這個公式在 Rust 端逐字重寫一次，並用隨機 plan 對拍測試釘死（render.rs 的 tests）。

export const RENDER_SR = 48_000;

export type JoinKind = "crossfade" | "gap" | "seam";

export interface JoinSpec {
  kind: JoinKind | string;
  /** crossfade：重疊長度；gap：room tone 長度；seam：忽略。 */
  ms: number;
}

export interface SegSpan {
  startMs: number;
  endMs: number;
}

/** 與 render.rs 的 ms_to_frames 同一套（四捨五入到 frame）。 */
export function msToFrames(ms: number): number {
  return Math.round((Math.max(0, ms) / 1000) * RENDER_SR);
}

export function framesToMs(frames: number): number {
  return (frames * 1000) / RENDER_SR;
}

/** 接點實際重疊幾個 frame。兩段都不能被吃掉超過一半，否則 Cutter 會補寫殘餘 tail。 */
export function effectiveXfFrames(specMs: number, prevLenFrames: number, nextLenFrames: number): number {
  const spec = msToFrames(specMs);
  return Math.max(0, Math.min(spec, Math.floor(prevLenFrames / 2), Math.floor(nextLenFrames / 2)));
}

/** 同上，回傳毫秒（UI / EDL 用）。 */
export function effectiveXfMs(specMs: number, prevLenMs: number, nextLenMs: number): number {
  return framesToMs(effectiveXfFrames(specMs, msToFrames(prevLenMs), msToFrames(nextLenMs)));
}

function segFrames(segs: SegSpan[]): number[] {
  return segs.map((s) => Math.max(0, msToFrames(s.endMs) - msToFrames(s.startMs)));
}

/**
 * 每個接點的重疊 frame 數（joins[i] 介於 segs[i] 與 segs[i+1] 之間）。
 * gap 與 seam 一律 0：它們不吃掉任何一段的內容。
 */
export function joinOverlapFrames(segs: SegSpan[], joins: JoinSpec[]): number[] {
  const lens = segFrames(segs);
  return joins.map((j, i) => {
    if (j.kind !== "crossfade") return 0;
    return effectiveXfFrames(j.ms, lens[i] ?? 0, lens[i + 1] ?? 0);
  });
}

/** 輸出總長（frame）。必須逐 frame 等於 Rust 實際寫出的數量。 */
export function planOutFrames(segs: SegSpan[], joins: JoinSpec[]): number {
  const lens = segFrames(segs);
  let total = lens.reduce((a, b) => a + b, 0);
  const overlaps = joinOverlapFrames(segs, joins);
  for (let i = 0; i < joins.length; i++) {
    if (joins[i].kind === "gap") total += msToFrames(joins[i].ms);
    else total -= overlaps[i];
  }
  return Math.max(0, total);
}

/**
 * 每一段在成品時間軸上的起點（frame）。與 planOutFrames 同一套帳：
 * 段 i 的起點 = 前面所有段長 + gap − crossfade 重疊。範圍濾波（fx_regions）要把來源時間的效果
 * 換算到成品時間，靠的就是這個 —— 建在 plan 的 segs 上而不是 edl.keeps，重排 / 只輸出一段都天然正確。
 */
export function segOutStartFrames(segs: SegSpan[], joins: JoinSpec[]): number[] {
  const lens = segFrames(segs);
  const overlaps = joinOverlapFrames(segs, joins);
  const out: number[] = [];
  let cur = 0;
  for (let i = 0; i < segs.length; i++) {
    out.push(cur);
    cur += lens[i];
    if (i < joins.length) {
      if (joins[i].kind === "gap") cur += msToFrames(joins[i].ms);
      else cur -= overlaps[i];
    }
  }
  return out;
}

/** 輸出總長（毫秒）。 */
export function planOutDurationMs(segs: SegSpan[], joins: JoinSpec[]): number {
  return framesToMs(planOutFrames(segs, joins));
}

/** 直接吃 EDL 的保留段 / 接點。注意：實際輸出走的是響度單元切過的段，兩者只有在
 *  單元邊界都比 crossfade 長（splitUnits 的 minUnitMs）時才保證一致 —— 要驗真正的
 *  成品長度請用 RenderPlan 版（見 pipeline/render.ts 的 expectedOutMs）。 */
export function edlOutDurationMs(edl: { keeps: { srcStartMs: number; srcEndMs: number }[]; joins: JoinSpec[] }): number {
  return planOutDurationMs(
    edl.keeps.map((k) => ({ startMs: k.srcStartMs, endMs: k.srcEndMs })),
    edl.joins,
  );
}
