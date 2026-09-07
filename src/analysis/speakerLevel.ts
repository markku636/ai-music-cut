// 每個講者的響度（Auphonic 的 multitrack leveling、Descript 的 speaker balance 在看的東西）。
//
// 一人一軌的素材幾乎一定有音量落差：兩支麥的增益不同、兩個人離麥的距離不同、講話大小
// 聲本來就不一樣。落差大到 6 dB 以上時，整集聽起來就是「來賓一直很小聲」。
//
// **這裡量的是來源，不是成品。** 輸出時的逐段平衡會把兩個人拉向同一個目標，所以成品的
// 落差會比這裡小得多。這個數字的用途是**診斷**：落差大到某個程度就不是後製能好好補救的
// （把小聲的拉起來，底噪與房間聲一起拉起來），該回頭調錄音端。
//
// 量測用的是既有的 BS.1770 閘門積分（loudness/gating.ts），不是自己再算一套平均 ——
// 一個人的發言散在整集各處，把它們的 momentary 視窗收集起來一起閘門積分，跟 ffmpeg
// 對整段算出來的是同一個定義。

import { integratedFromBlocks } from "./loudness/gating";
import type { LocalAnalysis } from "./peaks";
import type { Speaker, SpeakerTurn } from "./speakers";

export interface SpeakerLevel {
  speakerId: string;
  /** 閘門積分響度（LUFS）；資料不足回 null。 */
  lufs: number | null;
  /** 這個人被量到的時間（ms）。 */
  ms: number;
}

/** 少於這麼久就不給數字 —— 三秒鐘的附和算出來的響度不能拿來做任何決定。 */
export const MIN_MEASURE_MS = 5000;

/**
 * 每個講者的響度。
 *
 * 收集這個人所有發言段落覆蓋到的 momentary 視窗，一起做閘門積分。**不是**先算每段
 * 再平均 —— 那樣短的段落跟長的段落會被算成一樣重。
 */
export function speakerLevels(a: LocalAnalysis | null | undefined, turns: SpeakerTurn[], list: Speaker[]): SpeakerLevel[] {
  const out: SpeakerLevel[] = [];
  for (const sp of list) {
    if (!a || a.nWin <= 0) {
      out.push({ speakerId: sp.id, lufs: null, ms: 0 });
      continue;
    }
    const blocks: number[] = [];
    let ms = 0;
    for (const t of turns) {
      if (t.speakerId !== sp.id) continue;
      ms += Math.max(0, t.endMs - t.startMs);
      const lo = Math.max(0, Math.floor(t.startMs / a.hopMs));
      const hi = Math.min(a.nWin - 1, Math.floor((t.endMs - 1) / a.hopMs));
      for (let i = lo; i <= hi; i++) blocks.push(a.win[i * 3]);
    }
    out.push({ speakerId: sp.id, lufs: ms >= MIN_MEASURE_MS ? integratedFromBlocks(blocks) : null, ms });
  }
  return out;
}

/** 最大與最小之間差幾 dB（只算量得到的）；不足兩個人回 null。 */
export function levelSpread(levels: SpeakerLevel[]): number | null {
  const vals = levels.map((l) => l.lufs).filter((v): v is number => v != null);
  if (vals.length < 2) return null;
  return Math.max(...vals) - Math.min(...vals);
}

export type SpreadVerdict = "even" | "noticeable" | "bad";

/**
 * 落差的判讀。
 *
 * 3 dB 以內聽不太出來（逐段平衡輕鬆吸收）；3–6 dB 聽得出來但補得動；超過 6 dB 就是
 * 錄音端的問題 —— 硬補會把小聲那一位的底噪一起拉上來。
 */
export function spreadVerdict(spread: number | null): SpreadVerdict | null {
  if (spread == null) return null;
  if (spread < 3) return "even";
  return spread <= 6 ? "noticeable" : "bad";
}

/**
 * 單元 id → 講者 id 的查表（給 planGains 用）。
 *
 * 一個響度單元最長 15 秒，中間可能換人；歸給**重疊最久**的那個人。判不出的回 null，
 * planGains 會把 null 當成「延續」而不是「換人」—— 在不確定的地方不要製造音量跳點。
 */
export function unitSpeakerMap(units: { id: number; startMs: number; endMs: number }[], turns: SpeakerTurn[]): Map<number, string> {
  const out = new Map<number, string>();
  if (!turns.length) return out;
  for (const u of units) {
    const by = new Map<string, number>();
    for (const t of turns) {
      if (t.endMs <= u.startMs) continue;
      if (t.startMs >= u.endMs) break;
      const ov = Math.min(u.endMs, t.endMs) - Math.max(u.startMs, t.startMs);
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
    if (best) out.set(u.id, best);
  }
  return out;
}
