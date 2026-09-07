// 從「你實際做過的裁決」長出詞表建議。
//
// 贅字詞表（lexicon.ts 的 always / context / never）已經可以跨集沿用，但是要**手動**建。
// 而每個節目的口頭禪是固定的：同一位主持人每一集都講「然後」四百次，你每一集都在
// 對同一批詞做同一組判斷。這裡把那些判斷收集起來，累積夠了就回頭問一句
// 「這個詞你最近六集剪了 213 次、留了 2 次，要不要設成一律剪？」
//
// **只算使用者親手做的裁決**（origin === "user"）。
// auto 是規則層自己的決定、llm 是 AI 的決定 —— 把它們算進來就變成
// 「規則層說要剪 → 學到要剪 → 更確定要剪」的自我循環，學不到任何新東西，
// 只會把規則層本來就有的偏見放大成使用者的詞表。
//
// **建議永遠只是建議**：這支不會改任何設定，也不會改任何剪輯決策。
import { isBuiltinFiller, type FillerMode } from "./lexicon";
import { isActiveState, type Candidate, type DecisionMap, type Word } from "./types";

/** 一集裡使用者親手做過的贅字裁決。 */
export interface EpisodeObservation {
  /** 這一集的識別（媒體指紋）。同一集重學會**覆蓋**而不是累加。 */
  episode: string;
  /** 顯示用（檔名）。 */
  name: string;
  at: string;
  /** norm → [剪掉幾筆, 保留幾筆]。 */
  words: Record<string, [number, number]>;
  /** norm → 顯示用原文（保留標點與大小寫）。 */
  texts: Record<string, string>;
}

/** 累積起來的統計。 */
export interface WordTotals {
  norm: string;
  text: string;
  cut: number;
  kept: number;
  /** 有幾集看過這個詞。 */
  episodes: number;
}

export interface RuleSuggestion {
  norm: string;
  text: string;
  /** 建議設成什麼。 */
  mode: FillerMode;
  /** 目前詞表裡是什麼（沒設過就是 null）。 */
  current: FillerMode | null;
  cut: number;
  kept: number;
  episodes: number;
  /** new = 還沒設過；change = 已經設了，但你最近的做法跟它相反。 */
  kind: "new" | "change";
  builtin: boolean;
}

export interface LearnOptions {
  /** 至少要看過幾筆才敢建議。 */
  minObservations: number;
  /** 一面倒到什麼程度才算「你就是這樣做的」（0–1）。 */
  minAgreement: number;
  /** 最多留幾集的觀察（設定檔不要無限長）。 */
  keepEpisodes: number;
}

export const DEFAULT_LEARN: LearnOptions = { minObservations: 5, minAgreement: 0.9, keepEpisodes: 20 };

/** 頭尾標點；歸類看 norm，這只影響顯示。 */
const EDGE_PUNCT_RE = /^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu;

/**
 * 把這一集的使用者裁決收成一筆觀察。
 *
 * 只看 filler 候選：長停頓 / 雜音沒有「詞」可以歸類，結巴則是同一個字重複，
 * 兩者都不該影響贅字詞表。
 */
export function observeEpisode(
  candidates: readonly Candidate[],
  decisions: DecisionMap,
  words: readonly Word[],
  meta: { episode: string; name: string; at?: string },
): EpisodeObservation {
  const out: EpisodeObservation = {
    episode: meta.episode,
    name: meta.name,
    at: meta.at ?? new Date().toISOString(),
    words: {},
    texts: {},
  };
  for (const c of candidates) {
    if (c.kind !== "filler" || !c.wordIds.length) continue;
    const d = decisions[c.id];
    if (!d || d.origin !== "user") continue;
    if (d.state !== "accepted" && d.state !== "rejected") continue;
    const ws = c.wordIds.map((id) => words[id]).filter(Boolean);
    if (!ws.length) continue;
    const norm = ws.map((w) => w.norm).join("");
    if (!norm) continue;
    const cell = out.words[norm] ?? [0, 0];
    if (isActiveState(d.state)) cell[0] += 1;
    else cell[1] += 1;
    out.words[norm] = cell;
    if (!out.texts[norm]) {
      out.texts[norm] = ws.map((w) => w.text).join("").replace(EDGE_PUNCT_RE, "") || norm;
    }
  }
  return out;
}

/** 這一筆觀察有東西可學嗎（空的不要存進設定）。 */
export function hasSignal(obs: EpisodeObservation): boolean {
  return Object.keys(obs.words).length > 0;
}

/**
 * 把新的一集放進清單：同一集覆蓋、最新的在前面、超過上限就砍掉最舊的。
 *
 * 覆蓋而不是累加是重點 —— 使用者回頭重看同一集、多按幾次「學習」，
 * 不應該讓那一集的意見變成三倍重。
 */
export function putObservation(list: readonly EpisodeObservation[], obs: EpisodeObservation, cap = DEFAULT_LEARN.keepEpisodes): EpisodeObservation[] {
  const rest = list.filter((o) => o.episode !== obs.episode);
  return [obs, ...rest].slice(0, Math.max(1, cap));
}

/** 累加成每個詞的總計。 */
export function totalsOf(list: readonly EpisodeObservation[]): WordTotals[] {
  const map = new Map<string, WordTotals>();
  for (const obs of list) {
    for (const [norm, cell] of Object.entries(obs.words)) {
      const cut = cell?.[0] ?? 0;
      const kept = cell?.[1] ?? 0;
      if (cut + kept <= 0) continue;
      const cur = map.get(norm) ?? { norm, text: obs.texts?.[norm] ?? norm, cut: 0, kept: 0, episodes: 0 };
      cur.cut += cut;
      cur.kept += kept;
      cur.episodes += 1;
      if (!cur.text || cur.text === norm) cur.text = obs.texts?.[norm] ?? cur.text;
      map.set(norm, cur);
    }
  }
  return [...map.values()].sort((a, b) => b.cut + b.kept - (a.cut + a.kept) || a.norm.localeCompare(b.norm));
}

/**
 * 從總計提建議。
 *
 * 刻意**不建議**「內建詞表已經認得、而你也一直在剪」的詞：那個詞現在就已經會被提出來，
 * 設成 always 只是把分數從 0.8 變成 0.95，對使用者沒有任何差別，卻多一條要維護的規則。
 * 反過來「內建認得、但你每次都留著」就非常值得建議 —— 那是這個節目跟通用詞表不一樣的地方。
 */
export function suggestRules(
  totals: readonly WordTotals[],
  current: Record<string, string> | undefined | null,
  opts: LearnOptions = DEFAULT_LEARN,
): RuleSuggestion[] {
  const minN = Math.max(1, opts.minObservations);
  const minAgree = Math.min(1, Math.max(0.5, opts.minAgreement));
  const out: RuleSuggestion[] = [];
  for (const w of totals) {
    const n = w.cut + w.kept;
    if (n < minN) continue;
    const agree = Math.max(w.cut, w.kept) / n;
    if (agree < minAgree) continue;
    const mode: FillerMode = w.cut > w.kept ? "always" : "never";
    const raw = current?.[w.norm];
    const cur: FillerMode | null = raw === "always" || raw === "context" || raw === "never" ? raw : null;
    if (cur === mode) continue;
    const builtin = isBuiltinFiller(w.norm);
    // 內建就會剪、你也一直在剪 → 設了也沒差別
    if (cur === null && mode === "always" && builtin) continue;
    out.push({ norm: w.norm, text: w.text || w.norm, mode, current: cur, cut: w.cut, kept: w.kept, episodes: w.episodes, kind: cur === null ? "new" : "change", builtin });
  }
  // 先看「跟你現在的設定相反」的，那是最值得知道的；再依證據多寡
  return out.sort((a, b) => (a.kind === b.kind ? b.cut + b.kept - (a.cut + a.kept) : a.kind === "change" ? -1 : 1));
}

/** 寬鬆地讀設定裡的觀察字串；壞掉的丟掉而不是整份不能用。 */
export function parseObservations(raw: readonly string[] | undefined | null): EpisodeObservation[] {
  const out: EpisodeObservation[] = [];
  for (const s of raw ?? []) {
    let o: unknown;
    try {
      o = JSON.parse(s);
    } catch {
      continue;
    }
    if (!o || typeof o !== "object") continue;
    const r = o as Partial<EpisodeObservation>;
    if (typeof r.episode !== "string" || !r.episode) continue;
    if (!r.words || typeof r.words !== "object") continue;
    const words: Record<string, [number, number]> = {};
    for (const [k, v] of Object.entries(r.words)) {
      if (!Array.isArray(v)) continue;
      const cut = Number(v[0]);
      const kept = Number(v[1]);
      if (!Number.isFinite(cut) || !Number.isFinite(kept)) continue;
      if (cut < 0 || kept < 0) continue;
      words[k] = [Math.round(cut), Math.round(kept)];
    }
    if (!Object.keys(words).length) continue;
    const texts: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.texts ?? {})) if (typeof v === "string") texts[k] = v;
    out.push({ episode: r.episode, name: typeof r.name === "string" ? r.name : "", at: typeof r.at === "string" ? r.at : "", words, texts });
  }
  return out;
}

export function serializeObservations(list: readonly EpisodeObservation[]): string[] {
  return list.map((o) => JSON.stringify(o));
}
