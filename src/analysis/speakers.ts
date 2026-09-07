// 講者標籤（Descript / Riverside 的 speaker track、Final Cut 的 Audio Roles 之於人）。
//
// 多人 podcast 剪起來最缺的一件事：逐字稿上看不出**是誰在講**。所以「只看主持人講的
// 話」「來賓的口頭禪剪掉、主持人的留著」「這一集誰講太多」全都做不到，節目筆記也只能
// 寫成一大團文字。
//
// **不猜。** 真正的單軌聲紋分群要 speaker embedding 模型，這裡沒有，硬做只會得到一份
// 看起來很像但錯得很安靜的標籤 —— 那比沒有更糟（使用者會信它）。
//
// 這裡走的是**多麥克風**那條路，而且它是**確定性的不是猜的**：一人一軌時每支麥都收得
// 到別人的聲音，但**自己的麥一定最大聲**。多麥同步（analysis/sync.ts）已經把偏移量算
// 出來了，於是「這一格誰的麥最大聲」就是「誰在講」。這也正是商業多軌編輯器的做法。
//
// 單軌的素材就誠實地不提供自動指派，改成手動指派範圍（見 assignRange 的呼叫端）。

import { rmsU8ToDb } from "./peaks";
import type { LocalAnalysis } from "./peaks";
import type { Sentence, Word } from "./types";

/** 比這個還小聲的一律當沒人在講（dBFS）。 */
export const SILENT_DB = -100;

export interface Speaker {
  id: string;
  label: string;
  /** UI 用的色票 index（不存實際顏色 —— 換佈景時要跟著換）。 */
  colorIndex: number;
}

export interface SpeakerTurn {
  startMs: number;
  endMs: number;
  speakerId: string;
}

export interface SpeakerState {
  list: Speaker[];
  turns: SpeakerTurn[];
}

/** 講者色票（依序取用）。深淺兩個佈景都要看得清楚，所以挑中間調。 */
export const SPEAKER_COLORS = ["#7c9cf5", "#f2a25c", "#5fbf9f", "#d885c8", "#e0c060", "#7fb8d8"];

export function speakerColor(colorIndex: number): string {
  return SPEAKER_COLORS[((colorIndex % SPEAKER_COLORS.length) + SPEAKER_COLORS.length) % SPEAKER_COLORS.length];
}

export interface MicTrack {
  speakerId: string;
  /** 這一軌的本機分析。 */
  analysis: LocalAnalysis;
  /** 合併時這一軌被延遲了多少（合成品時間 = 這一軌時間 + delayMs）。 */
  delayMs: number;
}

export interface AttributeOptions {
  /** 每秒幾格。20 Hz（50 ms）足夠分辨換人，再細只是把換氣也算成換人。 */
  rateHz: number;
  /** 要領先第二名多少 dB 才算「是他在講」。差距不夠就當搶話 / 串音，不指派。 */
  marginDb: number;
  /** 低於這個 dB 一律當靜音。 */
  silenceDb: number;
  /** 比這個短的段落丟掉（換氣、笑聲、「嗯」的附和不該算成一次發言）。 */
  minTurnMs: number;
  /** 同一個人中間空這麼短就接起來（句子中間的停頓不該把一段切兩半）。 */
  mergeGapMs: number;
}

export const DEFAULT_ATTRIBUTE: AttributeOptions = {
  rateHz: 20,
  marginDb: 6,
  silenceDb: -50,
  minTurnMs: 400,
  mergeGapMs: 600,
};

/**
 * 把一軌的能量取樣成「每格的峰值 dB」。
 *
 * 用峰值不用平均：一格 50 ms 裡只要有一個字的起音就代表這個人在講，取平均會被同一格
 * 裡的靜音稀釋掉，短促的插話（「對」「真的假的」）就整個消失。
 */
export function micFramesDb(a: LocalAnalysis, rateHz: number): Float32Array {
  const step = Math.max(1, Math.round(a.pps / rateHz));
  const n = Math.floor(a.nBuckets / step);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let peak = 0;
    const end = Math.min((i + 1) * step, a.nBuckets);
    for (let k = i * step; k < end; k++) if (a.rmsU8[k] > peak) peak = a.rmsU8[k];
    out[i] = peak === 0 ? SILENT_DB : rmsU8ToDb(peak);
  }
  return out;
}

/**
 * 從多軌能量決定每一格是誰在講，再整理成段落。
 *
 * **領先幅度是重點**：一人一軌時每支麥都收得到別人的聲音，只比大小的話串音會讓標籤
 * 一直跳。要求領先第二名 `marginDb` 才指派，差距不夠就留白 —— 兩個人同時講的時候，
 * 沒有答案比錯誤答案好。
 */
export function attributeTurns(tracks: MicTrack[], opts: AttributeOptions = DEFAULT_ATTRIBUTE): SpeakerTurn[] {
  if (tracks.length < 2) return [];
  const frameMs = 1000 / opts.rateHz;
  const frames = tracks.map((t) => ({
    speakerId: t.speakerId,
    db: micFramesDb(t.analysis, opts.rateHz),
    // 合成品第 i 格 → 這一軌第 (i - delayFrames) 格
    delayFrames: Math.round(t.delayMs / frameMs),
  }));
  const total = Math.max(...frames.map((f) => f.db.length + f.delayFrames));

  const raw: (string | null)[] = new Array<string | null>(total).fill(null);
  for (let i = 0; i < total; i++) {
    let best = SILENT_DB;
    let bestId: string | null = null;
    let second = SILENT_DB;
    for (const f of frames) {
      const k = i - f.delayFrames;
      const db = k >= 0 && k < f.db.length ? f.db[k] : SILENT_DB;
      if (db > best) {
        second = best;
        best = db;
        bestId = f.speakerId;
      } else if (db > second) {
        second = db;
      }
    }
    if (bestId && best > opts.silenceDb && best - second >= opts.marginDb) raw[i] = bestId;
  }

  return tidyTurns(runsOf(raw, frameMs), opts);
}

/** 連續相同的格子縮成一段。 */
function runsOf(raw: (string | null)[], frameMs: number): SpeakerTurn[] {
  const out: SpeakerTurn[] = [];
  let i = 0;
  while (i < raw.length) {
    const id = raw[i];
    if (!id) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < raw.length && raw[j + 1] === id) j++;
    out.push({ startMs: Math.round(i * frameMs), endMs: Math.round((j + 1) * frameMs), speakerId: id });
    i = j + 1;
  }
  return out;
}

/**
 * 合併同一個人的近鄰段、丟掉太短的段。
 *
 * 順序有意義：**先合併再丟短的**。反過來的話，一句話中間的停頓會先讓兩半都被判定成
 * 太短而消失 —— 一整句話就這樣不見了。
 */
export function tidyTurns(turns: SpeakerTurn[], opts: AttributeOptions = DEFAULT_ATTRIBUTE): SpeakerTurn[] {
  const sorted = [...turns].sort((a, b) => a.startMs - b.startMs);
  const merged: SpeakerTurn[] = [];
  for (const t of sorted) {
    const prev = merged[merged.length - 1];
    if (prev && prev.speakerId === t.speakerId && t.startMs - prev.endMs <= opts.mergeGapMs) {
      prev.endMs = Math.max(prev.endMs, t.endMs);
    } else {
      merged.push({ ...t });
    }
  }
  return merged.filter((t) => t.endMs - t.startMs >= opts.minTurnMs);
}

/** 這個時間點是誰在講（沒有答案就 null）。 */
export function speakerAtMs(turns: SpeakerTurn[], ms: number): string | null {
  // 段落已排序且不重疊 → 二分搜
  let lo = 0;
  let hi = turns.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = turns[mid];
    if (ms < t.startMs) hi = mid - 1;
    else if (ms >= t.endMs) lo = mid + 1;
    else return t.speakerId;
  }
  return null;
}

/**
 * 每個字歸給**跟它重疊最久**的段落，不是歸給起點落在哪一段。
 *
 * 起點法在換人的接縫上會系統性地把第一個字判給前一個人 —— 而換人的第一個字正是
 * 最需要對的那個字（「所以你覺得呢」「我覺得…」）。
 */
export function assignWords(words: Word[], turns: SpeakerTurn[]): Map<number, string> {
  const out = new Map<number, string>();
  if (!turns.length) return out;
  let i = 0;
  for (const w of words) {
    while (i < turns.length && turns[i].endMs <= w.startMs) i++;
    let best: string | null = null;
    let bestOverlap = 0;
    for (let k = i; k < turns.length && turns[k].startMs < w.endMs; k++) {
      const ov = Math.min(w.endMs, turns[k].endMs) - Math.max(w.startMs, turns[k].startMs);
      if (ov > bestOverlap) {
        bestOverlap = ov;
        best = turns[k].speakerId;
      }
    }
    // 零長度的字（Whisper 偶爾會給）用起點救一下，不然整個字沒有講者
    if (!best && w.endMs <= w.startMs) best = speakerAtMs(turns, w.startMs);
    if (best) out.set(w.id, best);
  }
  return out;
}

/**
 * 一句話一個講者：取這句話裡**講最久**的人。
 *
 * 逐字稿是一句一列，句子中途換色只會讓人看不懂；而且一句話裡的少數幾個字被串音判錯
 * 是常態，多數決正好把它吸收掉。
 */
export function sentenceSpeakers(
  sentences: Sentence[],
  words: Word[],
  byWord: Map<number, string>,
): Map<number, string> {
  const wordById = new Map(words.map((w) => [w.id, w]));
  const out = new Map<number, string>();
  for (const s of sentences) {
    const ms = new Map<string, number>();
    for (const wid of s.wordIds) {
      const id = byWord.get(wid);
      if (!id) continue;
      const w = wordById.get(wid);
      const dur = w ? Math.max(1, w.endMs - w.startMs) : 1;
      ms.set(id, (ms.get(id) ?? 0) + dur);
    }
    let best: string | null = null;
    let bestMs = 0;
    for (const [id, v] of ms) {
      if (v > bestMs) {
        bestMs = v;
        best = id;
      }
    }
    if (best) out.set(s.id, best);
  }
  return out;
}

export interface SpeakerStat {
  speakerId: string;
  ms: number;
  /** 佔**有人在講的時間**的比例，不是佔整集長度 —— 靜音不屬於任何人。 */
  share: number;
  turns: number;
  longestMs: number;
}

/** 誰講了多久。用來看發言是不是嚴重失衡（主持人講了 80% 通常不是好事）。 */
export function speakerStats(turns: SpeakerTurn[], list: Speaker[]): SpeakerStat[] {
  const by = new Map<string, SpeakerStat>();
  for (const s of list) by.set(s.id, { speakerId: s.id, ms: 0, share: 0, turns: 0, longestMs: 0 });
  for (const t of turns) {
    const len = Math.max(0, t.endMs - t.startMs);
    const cur = by.get(t.speakerId) ?? { speakerId: t.speakerId, ms: 0, share: 0, turns: 0, longestMs: 0 };
    cur.ms += len;
    cur.turns += 1;
    cur.longestMs = Math.max(cur.longestMs, len);
    by.set(t.speakerId, cur);
  }
  const total = [...by.values()].reduce((a, b) => a + b.ms, 0);
  return [...by.values()]
    .map((s) => ({ ...s, share: total > 0 ? s.ms / total : 0 }))
    .sort((a, b) => b.ms - a.ms);
}

/**
 * 一段時間主要是誰在講：跟這個範圍**重疊最久**的那個人。
 *
 * 給的是「一段」而不是「一個時間點」，因為要問這個問題的東西幾乎都是範圍 ——
 * 一個贅字候選、一段選取、一句話。用起點判斷的話，剛好跨在換人邊界上的候選
 * 會被判給前一個人，而那正是最需要判對的位置。
 */
export function dominantSpeaker(turns: SpeakerTurn[], startMs: number, endMs: number): string | null {
  if (endMs <= startMs) return speakerAtMs(turns, startMs);
  const by = new Map<string, number>();
  for (const t of turns) {
    if (t.endMs <= startMs) continue;
    if (t.startMs >= endMs) break;
    const ov = Math.min(endMs, t.endMs) - Math.max(startMs, t.startMs);
    if (ov > 0) by.set(t.speakerId, (by.get(t.speakerId) ?? 0) + ov);
  }
  let best: string | null = null;
  let bestMs = 0;
  for (const [id, ms] of by) {
    if (ms > bestMs) {
      bestMs = ms;
      best = id;
    }
  }
  return best;
}

/**
 * 手動把一段時間指派給某個人（單軌素材唯一的路，也是自動指派錯掉時的補救）。
 *
 * 做法是**先在既有段落上挖掉這個範圍**再放進去，不是疊上去 —— 段落重疊的話
 * `speakerAtMs` 的二分搜就不成立了，而且一個時間點有兩個講者本來就沒有意義。
 */
export function assignRange(turns: SpeakerTurn[], startMs: number, endMs: number, speakerId: string | null): SpeakerTurn[] {
  const lo = Math.min(startMs, endMs);
  const hi = Math.max(startMs, endMs);
  if (hi <= lo) return turns;
  const out: SpeakerTurn[] = [];
  for (const t of turns) {
    if (t.endMs <= lo || t.startMs >= hi) {
      out.push({ ...t });
      continue;
    }
    if (t.startMs < lo) out.push({ startMs: t.startMs, endMs: lo, speakerId: t.speakerId });
    if (t.endMs > hi) out.push({ startMs: hi, endMs: t.endMs, speakerId: t.speakerId });
  }
  if (speakerId) out.push({ startMs: lo, endMs: hi, speakerId });
  out.sort((a, b) => a.startMs - b.startMs);
  // 挖完可能與鄰居同人相接 —— 合起來，但**不要在這裡丟短的段**：使用者手動指派
  // 一個 200 ms 的「對」是他的本意，自動指派的門檻不該套在手動結果上。
  const merged: SpeakerTurn[] = [];
  for (const t of out) {
    const prev = merged[merged.length - 1];
    if (prev && prev.speakerId === t.speakerId && t.startMs <= prev.endMs) prev.endMs = Math.max(prev.endMs, t.endMs);
    else merged.push(t);
  }
  return merged;
}

/** 從檔名做一個像人名的預設標籤：`mark_20260907.wav` → `mark`。 */
export function speakerLabelFromName(name: string): string {
  const stem = name.replace(/\.[^.]+$/, "");
  const cut = stem.replace(/[_-]?\d{4,}.*$/, "").replace(/[_-]+$/, "");
  return (cut || stem).trim() || name;
}

/** 讀專案檔 / 設定時擋掉壞資料（段落重疊或反向會讓二分搜失效）。 */
export function parseSpeakerState(raw: unknown): SpeakerState | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<SpeakerState>;
  if (!Array.isArray(s.list) || !Array.isArray(s.turns)) return null;
  const list = s.list.filter(
    (x): x is Speaker => !!x && typeof x === "object" && typeof (x as Speaker).id === "string" && typeof (x as Speaker).label === "string",
  ).map((x) => ({ id: x.id, label: x.label, colorIndex: Number.isFinite(x.colorIndex) ? x.colorIndex : 0 }));
  const ids = new Set(list.map((x) => x.id));
  const turns = s.turns
    .filter(
      (x): x is SpeakerTurn =>
        !!x &&
        typeof x === "object" &&
        typeof (x as SpeakerTurn).speakerId === "string" &&
        Number.isFinite((x as SpeakerTurn).startMs) &&
        Number.isFinite((x as SpeakerTurn).endMs) &&
        (x as SpeakerTurn).endMs > (x as SpeakerTurn).startMs &&
        ids.has((x as SpeakerTurn).speakerId),
    )
    .map((x) => ({ startMs: x.startMs, endMs: x.endMs, speakerId: x.speakerId }))
    .sort((a, b) => a.startMs - b.startMs);
  // 重疊的一律截掉後面那一段的頭，寧可少算一點也不要讓二分搜給出錯的答案
  const clean: SpeakerTurn[] = [];
  for (const t of turns) {
    const prev = clean[clean.length - 1];
    if (prev && t.startMs < prev.endMs) {
      if (t.endMs <= prev.endMs) continue;
      clean.push({ ...t, startMs: prev.endMs });
    } else {
      clean.push(t);
    }
  }
  return { list, turns: clean };
}
