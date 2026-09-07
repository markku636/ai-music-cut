/**
 * 命令面板的模糊比對。純函式。
 *
 * - 子字串命中最高分（開頭再加分）：「降噪」對「降噪整集（建議值）」。
 * - 否則子序列：英文縮寫「dnz」對「denoise」。中文逐字也是子序列，所以「噪降」對不到「降噪」。
 * - 一個指令有好幾個可比對的字串（翻譯後標題、繁中原文、關鍵字、快捷鍵），取最高分的那一個。
 */

export interface Match {
  score: number;
  /** 命中的區間 [start, end)，畫底線用。 */
  ranges: [number, number][];
}

export function fuzzyMatch(query: string, text: string): Match | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, ranges: [] };
  const s = text.toLowerCase();
  if (!s) return null;
  const idx = s.indexOf(q);
  if (idx >= 0) {
    let score = 100;
    if (idx === 0) score += 50;
    else if (/[\s(（\-_/·]/.test(s[idx - 1])) score += 25;
    score -= Math.min(20, Math.floor((s.length - q.length) / 4));
    return { score, ranges: [[idx, idx + q.length]] };
  }
  // 子序列
  const ranges: [number, number][] = [];
  let score = 0;
  let pos = 0;
  let prevHit = -2;
  for (const ch of q) {
    if (ch === " ") continue;
    const at = s.indexOf(ch, pos);
    if (at < 0) return null;
    score += 10;
    if (at === prevHit + 1) score += 8;
    if (at === 0 || /[\s(（\-_/·]/.test(s[at - 1])) score += 5;
    score -= Math.min(6, at - pos);
    if (ranges.length && ranges[ranges.length - 1][1] === at) ranges[ranges.length - 1][1] = at + 1;
    else ranges.push([at, at + 1]);
    prevHit = at;
    pos = at + 1;
  }
  return { score, ranges };
}

export interface Searchable {
  id: string;
  /** 依序：顯示標題、繁中原文、關鍵字…；第 0 個是畫面上會畫底線的那個。 */
  texts: string[];
}

export interface Ranked {
  id: string;
  score: number;
  /** 命中在 texts 的哪一個。 */
  field: number;
  ranges: [number, number][];
}

/** 排名；空查詢回傳全部（原順序、score 0）。同分維持輸入順序（穩定）。 */
export function rank(query: string, items: Searchable[]): Ranked[] {
  const q = query.trim();
  const out: Ranked[] = [];
  items.forEach((it) => {
    let best: Ranked | null = null;
    it.texts.forEach((txt, field) => {
      const m = fuzzyMatch(q, txt);
      if (!m) return;
      // 第 0 個是標題：同分時偏好標題命中
      const score = m.score + (field === 0 ? 1 : 0);
      if (!best || score > best.score) best = { id: it.id, score, field, ranges: m.ranges };
    });
    if (best) out.push(best);
  });
  if (!q) return out;
  return out.sort((a, b) => b.score - a.score);
}
