import { describe, expect, it } from "vitest";
import { sameRow, type RowProps, type WordMark } from "./rowEquals";
import type { Sentence } from "../analysis/types";

const sentence: Sentence = { id: 7, wordIds: [10, 11, 12], startMs: 1000, endMs: 2000, endsWithQuestion: false };
// 另一句，完全不含上面那三個字 —— 用來確認「別人的變動不會波及這一列」
const other: Sentence = { id: 8, wordIds: [20, 21], startMs: 3000, endMs: 4000, endsWithQuestion: false };

function base(over: Partial<RowProps> = {}): RowProps {
  return {
    sentence,
    words: [],
    activeWordId: -1,
    isActive: false,
    marks: { mark: new Map<number, WordMark>(), cov: new Map(), reason: new Map() },
    selectedWordIds: new Set(),
    selection: null,
    onSeek: () => {},
    onWordClick: () => {},
    onWordToggle: () => {},
    ...over,
  };
}

/** 換一組**內容相同但識別不同**的 marks —— 就是每次決策都會發生的事。 */
function reboxed(p: RowProps, edit?: (m: RowProps["marks"]) => void): RowProps {
  const marks = {
    mark: new Map(p.marks.mark),
    cov: new Map([...p.marks.cov].map(([k, v]): [number, string[]] => [k, [...v]])),
    reason: new Map(p.marks.reason),
  };
  edit?.(marks);
  return { ...p, marks, selectedWordIds: new Set(p.selectedWordIds) };
}

describe("sameRow", () => {
  it("整份 marks 換了新物件、但這一句的字沒變 → 不重繪", () => {
    const a = base();
    expect(sameRow(a, reboxed(a))).toBe(true);
  });

  it("別句的字被標成 cut → 這一列不重繪", () => {
    const a = base();
    const b = reboxed(a, (m) => m.mark.set(20, "cut"));
    expect(sameRow(a, b)).toBe(true);
  });

  it("自己的字被標成 cut → 要重繪", () => {
    const a = base();
    const b = reboxed(a, (m) => m.mark.set(11, "cut"));
    expect(sameRow(a, b)).toBe(false);
  });

  it("cut → pending 也算變（顏色不同）", () => {
    const a = base({ marks: { mark: new Map<number, WordMark>([[11, "cut"]]), cov: new Map(), reason: new Map() } });
    const b = reboxed(a, (m) => m.mark.set(11, "pending"));
    expect(sameRow(a, b)).toBe(false);
  });

  it("理由變了要重繪（title 會顯示）", () => {
    const a = base();
    const b = reboxed(a, (m) => m.reason.set(12, "填充詞"));
    expect(sameRow(a, b)).toBe(false);
  });

  it("覆蓋的候選 id 變了要重繪（會傳進 onWordClick）", () => {
    const a = base({ marks: { mark: new Map<number, WordMark>(), cov: new Map([[10, ["c1"]]]), reason: new Map() } });
    expect(sameRow(a, reboxed(a, (m) => m.cov.set(10, ["c2"])))).toBe(false);
    expect(sameRow(a, reboxed(a, (m) => m.cov.set(10, ["c1", "c2"])))).toBe(false);
    expect(sameRow(a, reboxed(a, (m) => m.cov.set(10, ["c1"])))).toBe(true);
  });

  it("選取的字：自己的變了要重繪，別人的不用", () => {
    const a = base();
    expect(sameRow(a, { ...a, selectedWordIds: new Set([11]) })).toBe(false);
    expect(sameRow(a, { ...a, selectedWordIds: new Set([21]) })).toBe(true);
  });

  it("搜尋命中：自己的變了要重繪，別人的不用", () => {
    const a = base({ hitWordIds: new Set([10]) });
    expect(sameRow(a, { ...a, hitWordIds: new Set([10]) })).toBe(true);
    expect(sameRow(a, { ...a, hitWordIds: new Set([21]) })).toBe(false);
    expect(sameRow(a, { ...a, hitWordIds: undefined })).toBe(false);
    const none = base();
    expect(sameRow(none, { ...none, hitWordIds: new Set([21]) })).toBe(true);
  });

  it("目前跳到的那一筆命中也要分開比", () => {
    const a = base();
    expect(sameRow(a, { ...a, activeHitWordIds: new Set([12]) })).toBe(false);
  });

  it("選取範圍：沒碰到這一句就不重繪", () => {
    const a = base();
    // 這一句是 1000–2000，選 3000–4000 與它無關
    expect(sameRow(a, { ...a, selection: { startMs: 3000, endMs: 4000 } })).toBe(true);
    // 碰到了就要
    expect(sameRow(a, { ...a, selection: { startMs: 1500, endMs: 4000 } })).toBe(false);
  });

  it("選取範圍碰到這一句、只是邊界移動 → 仍要重繪", () => {
    const a = base({ selection: { startMs: 1500, endMs: 1800 } });
    expect(sameRow(a, { ...a, selection: { startMs: 1500, endMs: 1900 } })).toBe(false);
    // 貼齊邊界（endMs === startMs）不算重疊
    const b = base();
    expect(sameRow(b, { ...b, selection: { startMs: 2000, endMs: 2500 } })).toBe(true);
  });

  it("播放線相關的欄位變了要重繪", () => {
    const a = base();
    expect(sameRow(a, { ...a, activeWordId: 11 })).toBe(false);
    expect(sameRow(a, { ...a, isActive: true })).toBe(false);
  });

  it("句子 / 字表 / 講者 / handler 換了都要重繪", () => {
    const a = base();
    expect(sameRow(a, { ...a, sentence: other })).toBe(false);
    expect(sameRow(a, { ...a, words: [] })).toBe(false);
    expect(sameRow(a, { ...a, speaker: { id: "s1", label: "來賓", colorIndex: 1 } })).toBe(false);
    expect(sameRow(a, { ...a, showSpeakerName: true })).toBe(false);
    expect(sameRow(a, { ...a, onWordClick: () => {} })).toBe(false);
    expect(sameRow(a, { ...a, onWordToggle: () => {} })).toBe(false);
    expect(sameRow(a, { ...a, onSeek: () => {} })).toBe(false);
    expect(sameRow(a, { ...a, onWordMenu: () => {} })).toBe(false);
    expect(sameRow(a, { ...a, onSentenceSelect: () => {} })).toBe(false);
  });

  it("每一個會影響畫面的欄位都被比到（漏一個就是靜默的 UI bug）", () => {
    // 這個測試釘住「欄位清單」：新增 prop 卻忘了進比較器時，這裡會紅。
    const compared = new Set([
      "sentence", "words", "activeWordId", "isActive", "marks", "selectedWordIds", "selection",
      "onSeek", "onWordClick", "onWordToggle", "onWordMenu", "onSentenceSelect",
      "hitWordIds", "activeHitWordIds", "speaker", "showSpeakerName",
    ]);
    const actual = Object.keys(base({ hitWordIds: new Set(), activeHitWordIds: new Set(), speaker: null, showSpeakerName: false, onWordMenu: () => {}, onSentenceSelect: () => {} }));
    for (const k of actual) expect(compared.has(k), `${k} 沒有進 sameRow`).toBe(true);
    expect(actual.length).toBe(compared.size);
  });
});
