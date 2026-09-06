// 只輸出選取的那一段（社群短片用）。
//
// 剪完一集之後常常還要再切 30–60 秒的預告丟社群。做法**不是**另外開一個專案再剪一次，
// 而是把同一份剪輯計畫夾在選取範圍內輸出 —— 贅字、接縫、配樂、閃避全部照舊，
// 只是頭尾被切掉。專案本身完全不動。
//
// 兩個時間軸要小心：選取是在**來源**時間軸上拉的（使用者看著波形選），
// 但配樂的位置是釘在**成品**時間上的，所以要先把選取的起點換算成成品時間，
// 才知道配樂該往前挪多少。
export interface Span {
  startMs: number;
  endMs: number;
}

/**
 * 把響度單元夾在來源範圍內。
 *
 * 範圍是連續的，所以只有頭尾會被切；中間不會有洞 —— 這也是接點（joins）可以原樣沿用的原因，
 * 被留下來的相鄰單元之間，關係跟夾之前一模一樣。
 */
export function clipUnits<T extends Span>(units: T[], range: Span): T[] {
  const out: T[] = [];
  for (const u of units) {
    const s = Math.max(u.startMs, range.startMs);
    const e = Math.min(u.endMs, range.endMs);
    if (e - s < 1) continue;
    out.push({ ...u, startMs: s, endMs: e });
  }
  return out;
}

export interface ClipOverlayInput {
  outStartMs: number;
  srcInMs: number;
  srcOutMs: number;
}

/**
 * 把配樂 / 音效夾到「剪出來的那一段」的時間軸上。
 *
 * `outOffsetMs` 是選取起點在成品時間軸的位置，`clipOutMs` 是這一段剪出來有多長。
 * 只蓋到一半的片段會被切（連同來源的進出點一起移），完全在範圍外的直接丟掉。
 */
export function clipOverlays<T extends ClipOverlayInput>(overlays: T[], outOffsetMs: number, clipOutMs: number): T[] {
  const out: T[] = [];
  for (const o of overlays) {
    const len = Math.max(0, o.srcOutMs - o.srcInMs);
    if (len <= 0) continue;
    // 換算到這一段的時間軸
    const start = o.outStartMs - outOffsetMs;
    const end = start + len;
    if (end <= 0 || start >= clipOutMs) continue;

    // 前面被切掉多少 → 來源的進點要跟著往後移，音樂才不會從頭開始播
    const cutHead = Math.max(0, -start);
    const cutTail = Math.max(0, end - clipOutMs);
    const srcInMs = o.srcInMs + cutHead;
    const srcOutMs = o.srcOutMs - cutTail;
    if (srcOutMs - srcInMs < 1) continue;
    out.push({ ...o, outStartMs: Math.max(0, start), srcInMs, srcOutMs });
  }
  return out;
}

/** `a.mp3` → `a_clip.mp3`（同一個資料夾，不覆蓋原本的成品）。 */
export function clipPath(outPath: string, suffix = "_clip"): string {
  const i = outPath.lastIndexOf(".");
  return i <= 0 ? `${outPath}${suffix}` : `${outPath.slice(0, i)}${suffix}${outPath.slice(i)}`;
}
