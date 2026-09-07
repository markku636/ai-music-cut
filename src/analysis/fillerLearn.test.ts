import { afterEach, describe, expect, it } from "vitest";
import { setFillerRules } from "./lexicon";
import {
  hasSignal,
  observeEpisode,
  parseObservations,
  putObservation,
  serializeObservations,
  suggestRules,
  totalsOf,
  type EpisodeObservation,
} from "./fillerLearn";
import type { Candidate, Decision, DecisionMap, Word } from "./types";

afterEach(() => setFillerRules({}));

function w(id: number, text: string, norm = text): Word {
  return { id, segId: 0, text, norm, startMs: id * 100, endMs: id * 100 + 90, prob: 0.9 };
}
const WORDS = [w(0, "然後"), w(1, "就是，", "就是"), w(2, "欸都", "欸都"), w(3, "然後"), w(4, "就是"), w(5, "欸都")];

function c(id: string, wordIds: number[], kind: Candidate["kind"] = "filler"): Candidate {
  return { id, kind, startMs: 0, endMs: 200, wordIds, reason: "r", score: 0.6, source: "rule", sentenceId: 0 };
}
function d(state: Decision["state"], origin: Decision["origin"] = "user"): Decision {
  return { state, origin, at: "2026-09-07T00:00:00Z" };
}

describe("observeEpisode", () => {
  it("只算使用者親手做的裁決", () => {
    const cands = [c("a", [0]), c("b", [1]), c("c", [3]), c("d", [4])];
    const dec: DecisionMap = {
      a: d("accepted", "user"),
      b: d("rejected", "user"),
      c: d("auto", "rule"), // 規則層自己剪的，不算
      d: d("accepted", "llm"), // AI 剪的，不算
    };
    const obs = observeEpisode(cands, dec, WORDS, { episode: "ep1", name: "第一集" });
    expect(obs.words).toEqual({ 然後: [1, 0], 就是: [0, 1] });
  });

  it("待決的不算（沒表態就不是意見）", () => {
    const obs = observeEpisode([c("a", [0])], { a: d("pending", "user") }, WORDS, { episode: "e", name: "" });
    expect(hasSignal(obs)).toBe(false);
  });

  it("只看贅字候選：長停頓與結巴不影響詞表", () => {
    const cands = [c("p", [0], "long_pause"), c("s", [1], "stutter"), c("f", [3], "filler")];
    const dec: DecisionMap = { p: d("accepted"), s: d("accepted"), f: d("accepted") };
    const obs = observeEpisode(cands, dec, WORDS, { episode: "e", name: "" });
    expect(Object.keys(obs.words)).toEqual(["然後"]);
  });

  it("顯示用原文去掉頭尾標點，歸類仍用 norm", () => {
    const obs = observeEpisode([c("a", [1])], { a: d("accepted") }, WORDS, { episode: "e", name: "" });
    expect(obs.words).toEqual({ 就是: [1, 0] });
    expect(obs.texts["就是"]).toBe("就是");
  });

  it("同一個詞的多筆會累加", () => {
    const cands = [c("a", [0]), c("b", [3])];
    const obs = observeEpisode(cands, { a: d("accepted"), b: d("rejected") }, WORDS, { episode: "e", name: "" });
    expect(obs.words["然後"]).toEqual([1, 1]);
  });
});

describe("putObservation", () => {
  const mk = (episode: string, cut: number): EpisodeObservation => ({
    episode, name: episode, at: "", words: { 然後: [cut, 0] }, texts: { 然後: "然後" },
  });

  it("同一集重學是覆蓋，不是累加", () => {
    let list = putObservation([], mk("ep1", 5));
    list = putObservation(list, mk("ep1", 7));
    expect(list).toHaveLength(1);
    expect(totalsOf(list)[0].cut).toBe(7);
  });

  it("最新的排前面", () => {
    let list = putObservation([], mk("ep1", 1));
    list = putObservation(list, mk("ep2", 2));
    expect(list.map((o) => o.episode)).toEqual(["ep2", "ep1"]);
  });

  it("超過上限砍掉最舊的", () => {
    let list: EpisodeObservation[] = [];
    for (let i = 0; i < 5; i++) list = putObservation(list, mk("ep" + i, 1), 3);
    expect(list.map((o) => o.episode)).toEqual(["ep4", "ep3", "ep2"]);
  });
});

describe("totalsOf", () => {
  it("跨集累加，並記得看過幾集", () => {
    const list: EpisodeObservation[] = [
      { episode: "a", name: "", at: "", words: { 然後: [10, 0], 就是: [3, 1] }, texts: {} },
      { episode: "b", name: "", at: "", words: { 然後: [8, 2] }, texts: {} },
    ];
    const t = totalsOf(list);
    const rr = t.find((x) => x.norm === "然後")!;
    expect([rr.cut, rr.kept, rr.episodes]).toEqual([18, 2, 2]);
    expect(t.find((x) => x.norm === "就是")!.episodes).toBe(1);
  });

  it("依證據多寡排序", () => {
    const list: EpisodeObservation[] = [{ episode: "a", name: "", at: "", words: { 少: [1, 0], 多: [20, 0] }, texts: {} }];
    expect(totalsOf(list).map((x) => x.norm)).toEqual(["多", "少"]);
  });
});

describe("suggestRules", () => {
  const t = (norm: string, cut: number, kept: number, episodes = 1) => ({ norm, text: norm, cut, kept, episodes });

  it("證據不夠就不建議", () => {
    expect(suggestRules([t("欸都", 4, 0)], {})).toHaveLength(0);
    expect(suggestRules([t("欸都", 5, 0)], {})).toHaveLength(1);
  });

  it("意見不一面倒就不建議（那本來就該看語境）", () => {
    expect(suggestRules([t("欸都", 6, 4)], {})).toHaveLength(0);
    expect(suggestRules([t("欸都", 9, 1)], {})).toHaveLength(1);
  });

  it("一直剪的自訂詞 → 建議一律剪", () => {
    const [s] = suggestRules([t("欸都", 12, 0)], {});
    expect([s.mode, s.kind, s.current]).toEqual(["always", "new", null]);
  });

  it("內建詞表本來就會剪、你也一直在剪 → 不建議（設了也沒差別）", () => {
    // 「然後」在內建詞表裡
    expect(suggestRules([t("然後", 30, 0)], {})).toHaveLength(0);
  });

  it("內建詞表會剪、但你每次都留著 → 這才是最該建議的", () => {
    const [s] = suggestRules([t("然後", 0, 14)], {});
    expect([s.mode, s.builtin]).toEqual(["never", true]);
  });

  it("已經設成一樣的就不用再建議", () => {
    expect(suggestRules([t("欸都", 12, 0)], { 欸都: "always" })).toHaveLength(0);
  });

  it("你的設定跟你的做法相反 → 提出來改", () => {
    const [s] = suggestRules([t("欸都", 0, 12)], { 欸都: "always" });
    expect([s.mode, s.current, s.kind]).toEqual(["never", "always", "change"]);
  });

  it("設成 context 但做法一面倒，也算值得改", () => {
    const [s] = suggestRules([t("欸都", 12, 0)], { 欸都: "context" });
    expect([s.mode, s.kind]).toEqual(["always", "change"]);
  });

  it("「跟現在設定相反」排在最前面", () => {
    const list = suggestRules([t("欸都", 40, 0), t("你知道", 0, 8)], { 你知道: "always" });
    expect(list[0].norm).toBe("你知道");
  });

  it("壞掉的設定值當作沒設過", () => {
    const [s] = suggestRules([t("欸都", 12, 0)], { 欸都: "sometimes" });
    expect(s.current).toBe(null);
  });

  it("門檻可以調", () => {
    expect(suggestRules([t("欸都", 3, 0)], {}, { minObservations: 3, minAgreement: 0.9, keepEpisodes: 20 })).toHaveLength(1);
  });
});

describe("讀寫設定", () => {
  it("來回一趟不變", () => {
    const list: EpisodeObservation[] = [{ episode: "a", name: "第一集", at: "2026-09-07", words: { 然後: [3, 1] }, texts: { 然後: "然後" } }];
    expect(parseObservations(serializeObservations(list))).toEqual(list);
  });

  it("壞掉的那幾筆丟掉，其餘照讀", () => {
    const good = JSON.stringify({ episode: "a", name: "", at: "", words: { 然後: [1, 0] }, texts: {} });
    const parsed = parseObservations(["{壞掉的", "null", "[]", JSON.stringify({ words: {} }), JSON.stringify({ episode: "b", words: {} }), good]);
    expect(parsed.map((o) => o.episode)).toEqual(["a"]);
  });

  it("負數或非數字的格子丟掉", () => {
    const raw = JSON.stringify({ episode: "a", words: { 好: [-1, 2], 壞: ["x", 1], 對: [2, 1] } });
    expect(parseObservations([raw])[0].words).toEqual({ 對: [2, 1] });
  });

  it("沒有東西可學的那一集不留", () => {
    expect(parseObservations([JSON.stringify({ episode: "a", words: {} })])).toHaveLength(0);
  });
});
