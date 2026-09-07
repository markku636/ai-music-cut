// 壞掉的專案檔不該讓時間軸靜靜地壞掉。
//
// 每一條都對應一種「進了 store 才會發作、而且發作的地方離原因很遠」的資料：
// NaN 的時間會讓 EDL 算出 NaN、非陣列會讓 .filter 當場丟例外、指不到候選的決策會讓
// 「還有幾筆待決」永遠算不對。
import { MIN_PASTE_MS } from "../analysis/edl/arrange";
import { describe, expect, it } from "vitest";
import { emptyReport, sanitizeCandidates, sanitizeCleanup, sanitizeDecisions, sanitizeEffects, sanitizeMarkers, sanitizeOverlays, sanitizePastes, sanitizeSpeakers, sanitizeSplits } from "./sanitize";

const cand = (id: string, s: number, e: number) => ({ id, kind: "filler", startMs: s, endMs: e, wordIds: [1], reason: "", score: 0.9, source: "rule", sentenceId: 0 });

describe("sanitizeCandidates", () => {
  it("留下正常的", () => {
    const r = emptyReport();
    expect(sanitizeCandidates([cand("a", 0, 100)], r)).toHaveLength(1);
    expect(r.total).toBe(0);
  });

  it("**NaN / 無限大的時間丟掉**（進了 EDL 會讓整條時間軸變 NaN）", () => {
    const r = emptyReport();
    expect(sanitizeCandidates([cand("a", Number.NaN, 100), cand("b", 0, Number.POSITIVE_INFINITY)], r)).toEqual([]);
    expect(r.dropped.candidates).toBe(2);
  });

  it("結尾不在起點之後的丟掉", () => {
    const r = emptyReport();
    expect(sanitizeCandidates([cand("a", 500, 500), cand("b", 500, 100)], r)).toEqual([]);
  });

  it("缺 id / kind / wordIds 的丟掉", () => {
    const r = emptyReport();
    expect(sanitizeCandidates([{ startMs: 0, endMs: 1 }, { ...cand("a", 0, 1), wordIds: "x" }], r)).toEqual([]);
  });

  it("**根本不是陣列時回空的而不是丟例外**（後面一定會 .filter）", () => {
    const r = emptyReport();
    expect(sanitizeCandidates("boom", r)).toEqual([]);
    expect(sanitizeCandidates(null, r)).toEqual([]);
  });
});

describe("sanitizeDecisions", () => {
  const known = new Set(["a", "b"]);

  it("留下狀態合法且指得到候選的", () => {
    const r = emptyReport();
    const out = sanitizeDecisions({ a: { state: "auto", origin: "rule", at: "" } }, known, r);
    expect(Object.keys(out)).toEqual(["a"]);
  });

  it("**指不到候選的鍵丟掉**（不然「還有幾筆待決」永遠算不對）", () => {
    const r = emptyReport();
    expect(sanitizeDecisions({ ghost: { state: "auto" } }, known, r)).toEqual({});
    expect(r.dropped.decisions).toBe(1);
  });

  it("狀態不在列舉裡的丟掉", () => {
    const r = emptyReport();
    expect(sanitizeDecisions({ a: { state: "maybe" } }, known, r)).toEqual({});
  });

  it("不是物件時回空的", () => {
    expect(sanitizeDecisions([1, 2], known, emptyReport())).toEqual({});
  });
});

describe("sanitizeEffects", () => {
  it("kind 不在列舉裡的丟掉", () => {
    const r = emptyReport();
    expect(sanitizeEffects([{ id: "x", kind: "explode", startMs: 0, endMs: 10 }], r)).toEqual([]);
  });

  it("**壞掉的 db 變成 undefined 而不是 NaN**（NaN 增益會讓整段變無聲）", () => {
    const out = sanitizeEffects([{ id: "x", kind: "gain", startMs: 0, endMs: 10, db: "loud" }], emptyReport());
    expect(out[0].db).toBeUndefined();
  });

  it("正常的 db 留著", () => {
    expect(sanitizeEffects([{ id: "x", kind: "gain", startMs: 0, endMs: 10, db: -6 }], emptyReport())[0].db).toBe(-6);
  });
});

describe("sanitizeSplits", () => {
  it("非數字 / 負數的 ms 丟掉", () => {
    const r = emptyReport();
    expect(sanitizeSplits([{ id: "a", ms: "abc" }, { id: "b", ms: -5 }], r)).toEqual([]);
    expect(r.dropped.splits).toBe(2);
  });

  it("依時間排序（EDL 假設切點是有序的）", () => {
    const out = sanitizeSplits([{ id: "b", ms: 500 }, { id: "a", ms: 100 }], emptyReport());
    expect(out.map((x) => x.ms)).toEqual([100, 500]);
  });

  it("gapMs 只留正數，其餘當沒有", () => {
    const out = sanitizeSplits([{ id: "a", ms: 1, gapMs: -3 }, { id: "b", ms: 2, gapMs: 200 }], emptyReport());
    expect(out[0].gapMs).toBeUndefined();
    expect(out[1].gapMs).toBe(200);
  });
});

describe("sanitizeMarkers", () => {
  it("kind 不合法或時間壞掉的丟掉", () => {
    const r = emptyReport();
    expect(sanitizeMarkers([{ id: "a", ms: 0, kind: "weird" }, { id: "b", ms: Number.NaN, kind: "chapter" }], r)).toEqual([]);
  });

  it("標題不是字串時補成空字串（章節寫檔時會被當字串用）", () => {
    const out = sanitizeMarkers([{ id: "a", ms: 0, kind: "chapter", title: 42 }], emptyReport());
    expect(out[0].title).toBe("");
  });

  it("依時間排序", () => {
    const out = sanitizeMarkers([{ id: "b", ms: 900, kind: "standard", title: "b" }, { id: "a", ms: 100, kind: "standard", title: "a" }], emptyReport());
    expect(out.map((m) => m.ms)).toEqual([100, 900]);
  });
});

describe("sanitizeOverlays", () => {
  const ok = { id: "o1", lane: "music", mediaId: "m", srcInMs: 0, srcOutMs: 1000, outStartMs: 0, gainDb: -18, fadeInMs: 100, fadeOutMs: 100, points: [] };

  it("留下正常的", () => {
    expect(sanitizeOverlays([ok], emptyReport())).toHaveLength(1);
  });

  it("lane 不合法、來源區間反了、位置壞掉的丟掉", () => {
    const r = emptyReport();
    expect(sanitizeOverlays([{ ...ok, lane: "vocals" }, { ...ok, srcOutMs: 0 }, { ...ok, outStartMs: "x" }], r)).toEqual([]);
    expect(r.dropped.overlays).toBe(3);
  });

  it("壞掉的 gainDb 當 0（NaN 增益會讓配樂整段消失或爆掉）", () => {
    expect(sanitizeOverlays([{ ...ok, gainDb: Number.NaN }], emptyReport())[0].gainDb).toBe(0);
  });

  it("閃避控制點裡壞掉的那幾個丟掉，好的留著", () => {
    const out = sanitizeOverlays([{ ...ok, points: [{ ms: 0, db: -8 }, { ms: "x", db: -8 }, { ms: 10 }] }], emptyReport());
    expect(out[0].points).toHaveLength(1);
  });
});

describe("sanitizeCleanup / sanitizeSpeakers", () => {
  it("沒有就是沒有（不算壞掉）", () => {
    const r = emptyReport();
    expect(sanitizeCleanup(undefined, r)).toBeUndefined();
    expect(sanitizeSpeakers(undefined, r)).toBeUndefined();
    expect(r.total).toBe(0);
  });

  it("不是物件的修聲設定丟掉並記一筆", () => {
    const r = emptyReport();
    expect(sanitizeCleanup("loud", r)).toBeUndefined();
    expect(r.dropped.cleanup).toBe(1);
  });

  it("講者段落走既有的 parseSpeakerState（重疊會被截掉）", () => {
    const s = sanitizeSpeakers(
      { list: [{ id: "a", label: "A", colorIndex: 0 }], turns: [{ startMs: 0, endMs: 100, speakerId: "a" }] },
      emptyReport(),
    );
    expect(s?.turns).toHaveLength(1);
  });

  it("壞掉的講者資料丟掉並記一筆", () => {
    const r = emptyReport();
    expect(sanitizeSpeakers({ nope: 1 }, r)).toBeUndefined();
    expect(r.dropped.speakers).toBe(1);
  });
});

describe("報告", () => {
  it("乾淨的檔案什麼都不記", () => {
    const r = emptyReport();
    sanitizeCandidates([cand("a", 0, 100)], r);
    sanitizeSplits([{ id: "s", ms: 10 }], r);
    sanitizeMarkers([{ id: "m", ms: 10, kind: "chapter", title: "x" }], r);
    expect(r.total).toBe(0);
    expect(r.dropped).toEqual({});
  });

  it("分類記數，方便一眼看出是哪一段壞了", () => {
    const r = emptyReport();
    sanitizeCandidates([cand("a", Number.NaN, 1)], r);
    sanitizeSplits([{ id: "s", ms: "x" }], r);
    expect(r.dropped).toEqual({ candidates: 1, splits: 1 });
    expect(r.total).toBe(2);
  });
});

describe("sanitizePastes", () => {
  const rep = emptyReport;

  it("正常的貼上留下來", () => {
    const r = rep();
    const out = sanitizePastes([{ id: "p1", srcStartMs: 1000, srcEndMs: 2000, atMs: 500 }], r);
    expect(out).toEqual([{ id: "p1", srcStartMs: 1000, srcEndMs: 2000, atMs: 500 }]);
  });

  it("不是陣列就當空的", () => {
    expect(sanitizePastes(null, rep())).toEqual([]);
    expect(sanitizePastes("x", rep())).toEqual([]);
  });

  it("壞掉的那幾筆丟掉，其餘照留", () => {
    const r = rep();
    const out = sanitizePastes(
      [
        { id: "ok", srcStartMs: 1000, srcEndMs: 2000, atMs: 0 },
        { srcStartMs: 1, srcEndMs: 2, atMs: 0 }, // 沒有 id
        { id: "nan", srcStartMs: "abc", srcEndMs: 2000, atMs: 0 },
        { id: "neg", srcStartMs: -5, srcEndMs: 2000, atMs: 0 },
        { id: "negAt", srcStartMs: 0, srcEndMs: 2000, atMs: -1 },
        { id: "backwards", srcStartMs: 2000, srcEndMs: 1000, atMs: 0 },
      ],
      r,
    );
    expect(out.map((x) => x.id)).toEqual(["ok"]);
  });

  it("太短的丟掉（長度為負或幾乎為零的區間會讓剪接器讀不到）", () => {
    expect(sanitizePastes([{ id: "tiny", srcStartMs: 100, srcEndMs: 100 + MIN_PASTE_MS - 1, atMs: 0 }], rep())).toEqual([]);
    expect(sanitizePastes([{ id: "ok", srcStartMs: 100, srcEndMs: 100 + MIN_PASTE_MS, atMs: 0 }], rep())).toHaveLength(1);
  });
});
