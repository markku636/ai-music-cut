import { describe, expect, it } from "vitest";
import {
  assignRange,
  assignWords,
  attributeTurns,
  DEFAULT_ATTRIBUTE,
  micFramesDb,
  parseSpeakerState,
  sentenceSpeakers,
  speakerAtMs,
  speakerColor,
  speakerLabelFromName,
  speakerStats,
  tidyTurns,
  type SpeakerTurn,
} from "./speakers";
import type { LocalAnalysis } from "./peaks";
import type { Sentence, Word } from "./types";

/** dB → u8（rmsU8ToDb 的反函式）。 */
function u8(db: number): number {
  return Math.round(((db + 60) / 60) * 255);
}

const PPS = 200; // 5 ms 一桶

/** 用 [起 ms, 迄 ms, dB] 的段落做一軌分析。 */
function mic(spans: [number, number, number][], durationMs = 10_000): LocalAnalysis {
  const nBuckets = Math.round((durationMs / 1000) * PPS);
  const rmsU8 = new Uint8Array(nBuckets); // 預設 0 = 靜音
  for (const [s, e, db] of spans) {
    const lo = Math.round((s / 1000) * PPS);
    const hi = Math.round((e / 1000) * PPS);
    for (let i = lo; i < hi && i < nBuckets; i++) rmsU8[i] = u8(db);
  }
  return {
    version: 3,
    pps: PPS,
    hopMs: 100,
    sampleRate: 48000,
    nBuckets,
    nWin: 0,
    totalSamples: 0,
    durationMs,
    mins: new Int8Array(0),
    maxs: new Int8Array(0),
    rmsU8,
    win: new Float32Array(0),
    zx: null,
  };
}

describe("micFramesDb", () => {
  it("一格取峰值不是平均（短促的插話不能被稀釋掉）", () => {
    // 20 Hz = 50 ms 一格；只有前 5 ms 有聲音
    const a = mic([[0, 5, -12]], 1000);
    expect(micFramesDb(a, 20)[0]).toBeCloseTo(-12, 0);
  });

  it("全靜音回 SILENT_DB 而不是 -60（0 是「沒量到」不是「-60 dB」）", () => {
    expect(micFramesDb(mic([], 1000), 20)[0]).toBe(-100);
  });
});

describe("attributeTurns", () => {
  // A 講 0–3 秒，B 講 4–7 秒；兩支麥都收得到對方（串音低 20 dB）
  const A = mic([
    [0, 3000, -12],
    [4000, 7000, -32],
  ]);
  const B = mic([
    [0, 3000, -32],
    [4000, 7000, -12],
  ]);
  const tracks = [
    { speakerId: "a", analysis: A, delayMs: 0 },
    { speakerId: "b", analysis: B, delayMs: 0 },
  ];

  it("誰的麥最大聲就是誰在講", () => {
    const turns = attributeTurns(tracks);
    expect(turns).toHaveLength(2);
    expect(turns[0].speakerId).toBe("a");
    expect(turns[0].startMs).toBe(0);
    expect(turns[0].endMs).toBeCloseTo(3000, -2);
    expect(turns[1].speakerId).toBe("b");
    expect(turns[1].startMs).toBeCloseTo(4000, -2);
  });

  it("靜音不屬於任何人（3–4 秒中間留白）", () => {
    expect(speakerAtMs(attributeTurns(tracks), 3500)).toBeNull();
  });

  it("兩個人同時講（差距不到 marginDb）不指派 —— 沒有答案好過錯誤答案", () => {
    const both = [
      { speakerId: "a", analysis: mic([[0, 3000, -12]]), delayMs: 0 },
      { speakerId: "b", analysis: mic([[0, 3000, -14]]), delayMs: 0 },
    ];
    expect(attributeTurns(both)).toEqual([]);
  });

  it("串音差距夠大就分得開", () => {
    const t = attributeTurns([
      { speakerId: "a", analysis: mic([[0, 3000, -12]]), delayMs: 0 },
      { speakerId: "b", analysis: mic([[0, 3000, -30]]), delayMs: 0 },
    ]);
    expect(t.map((x) => x.speakerId)).toEqual(["a"]);
  });

  it("延遲會換算到合成品時間軸", () => {
    // B 這一軌整體被延遲 2 秒 → 它的 0–3 秒在成品的 2–5 秒
    const t = attributeTurns([
      { speakerId: "a", analysis: mic([[6000, 9000, -12]]), delayMs: 0 },
      { speakerId: "b", analysis: mic([[0, 3000, -12]]), delayMs: 2000 },
    ]);
    const b = t.find((x) => x.speakerId === "b")!;
    expect(b.startMs).toBeCloseTo(2000, -2);
    expect(b.endMs).toBeCloseTo(5000, -2);
  });

  it("只有一軌時不指派（單軌沒有可比的對象，不要用猜的）", () => {
    expect(attributeTurns([{ speakerId: "a", analysis: A, delayMs: 0 }])).toEqual([]);
  });

  it("整段安靜的素材回空陣列而不是一大段假的發言", () => {
    expect(
      attributeTurns([
        { speakerId: "a", analysis: mic([]), delayMs: 0 },
        { speakerId: "b", analysis: mic([]), delayMs: 0 },
      ]),
    ).toEqual([]);
  });
});

describe("tidyTurns", () => {
  const o = DEFAULT_ATTRIBUTE;

  it("先合併再丟短的（一句話中間的停頓不該讓整句消失）", () => {
    // 兩段各 300 ms（都短於 minTurnMs 400），中間隔 200 ms（短於 mergeGapMs 600）
    const out = tidyTurns(
      [
        { startMs: 0, endMs: 300, speakerId: "a" },
        { startMs: 500, endMs: 800, speakerId: "a" },
      ],
      o,
    );
    expect(out).toEqual([{ startMs: 0, endMs: 800, speakerId: "a" }]);
  });

  it("不同人不合併，就算靠得很近", () => {
    const out = tidyTurns(
      [
        { startMs: 0, endMs: 1000, speakerId: "a" },
        { startMs: 1050, endMs: 2000, speakerId: "b" },
      ],
      o,
    );
    expect(out).toHaveLength(2);
  });

  it("孤立的短段丟掉（換氣、附和的「嗯」不算一次發言）", () => {
    expect(tidyTurns([{ startMs: 0, endMs: 200, speakerId: "a" }], o)).toEqual([]);
  });

  it("進來沒排序也處理得了", () => {
    const out = tidyTurns(
      [
        { startMs: 5000, endMs: 6000, speakerId: "b" },
        { startMs: 0, endMs: 1000, speakerId: "a" },
      ],
      o,
    );
    expect(out.map((t) => t.startMs)).toEqual([0, 5000]);
  });
});

describe("speakerAtMs", () => {
  const turns: SpeakerTurn[] = [
    { startMs: 0, endMs: 1000, speakerId: "a" },
    { startMs: 2000, endMs: 3000, speakerId: "b" },
  ];

  it("落在段落內回那個人", () => {
    expect(speakerAtMs(turns, 500)).toBe("a");
    expect(speakerAtMs(turns, 2999)).toBe("b");
  });

  it("邊界：起點含、終點不含（相鄰段不會兩邊都命中）", () => {
    expect(speakerAtMs(turns, 0)).toBe("a");
    expect(speakerAtMs(turns, 1000)).toBeNull();
  });

  it("空清單不會炸", () => {
    expect(speakerAtMs([], 500)).toBeNull();
  });
});

describe("assignWords", () => {
  const w = (id: number, s: number, e: number): Word => ({ id, segId: 0, text: "x", norm: "x", startMs: s, endMs: e, prob: 0.9 });

  it("歸給重疊最久的段落，不是起點落在哪一段", () => {
    // 換人的接縫上：這個字 90% 在 b 身上，起點卻還在 a
    const turns: SpeakerTurn[] = [
      { startMs: 0, endMs: 1010, speakerId: "a" },
      { startMs: 1010, endMs: 3000, speakerId: "b" },
    ];
    expect(assignWords([w(1, 1000, 1500)], turns).get(1)).toBe("b");
  });

  it("沒有覆蓋到的字不給講者（不要硬塞一個）", () => {
    expect(assignWords([w(1, 5000, 5200)], [{ startMs: 0, endMs: 1000, speakerId: "a" }]).size).toBe(0);
  });

  it("零長度的字用起點救回來", () => {
    expect(assignWords([w(1, 500, 500)], [{ startMs: 0, endMs: 1000, speakerId: "a" }]).get(1)).toBe("a");
  });

  it("沒有段落時回空的", () => {
    expect(assignWords([w(1, 0, 100)], []).size).toBe(0);
  });
});

describe("sentenceSpeakers", () => {
  const words: Word[] = [
    { id: 1, segId: 0, text: "a", norm: "a", startMs: 0, endMs: 900, prob: 1 },
    { id: 2, segId: 0, text: "b", norm: "b", startMs: 900, endMs: 1000, prob: 1 },
  ];
  const sentences: Sentence[] = [{ id: 0, wordIds: [1, 2], startMs: 0, endMs: 1000, endsWithQuestion: false }];

  it("一句一個講者：取講最久的（少數幾個字判錯會被吸收掉）", () => {
    const byWord = new Map([
      [1, "a"],
      [2, "b"],
    ]);
    expect(sentenceSpeakers(sentences, words, byWord).get(0)).toBe("a");
  });

  it("整句都沒有講者就不給", () => {
    expect(sentenceSpeakers(sentences, words, new Map()).size).toBe(0);
  });
});

describe("speakerStats", () => {
  const list = [
    { id: "a", label: "A", colorIndex: 0 },
    { id: "b", label: "B", colorIndex: 1 },
  ];

  it("佔比是「佔有人在講的時間」而不是佔整集（靜音不屬於任何人）", () => {
    const s = speakerStats(
      [
        { startMs: 0, endMs: 3000, speakerId: "a" },
        { startMs: 60_000, endMs: 61_000, speakerId: "b" },
      ],
      list,
    );
    expect(s[0]).toMatchObject({ speakerId: "a", ms: 3000, turns: 1 });
    expect(s[0].share).toBeCloseTo(0.75, 5);
    expect(s[1].share).toBeCloseTo(0.25, 5);
  });

  it("一句話都沒講的人也要列出來（那本身就是資訊）", () => {
    const s = speakerStats([{ startMs: 0, endMs: 1000, speakerId: "a" }], list);
    expect(s.map((x) => x.speakerId)).toEqual(["a", "b"]);
    expect(s[1]).toMatchObject({ ms: 0, share: 0, turns: 0 });
  });

  it("最長的一段記下來（有人一口氣講了 8 分鐘是要知道的）", () => {
    const s = speakerStats(
      [
        { startMs: 0, endMs: 1000, speakerId: "a" },
        { startMs: 2000, endMs: 9000, speakerId: "a" },
      ],
      list,
    );
    expect(s[0].longestMs).toBe(7000);
  });

  it("完全沒有段落時不會除以零", () => {
    expect(speakerStats([], list).every((x) => x.share === 0)).toBe(true);
  });
});

describe("assignRange", () => {
  const turns: SpeakerTurn[] = [{ startMs: 0, endMs: 10_000, speakerId: "a" }];

  it("在中間指派會把原本那段挖成兩半", () => {
    const out = assignRange(turns, 3000, 5000, "b");
    expect(out).toEqual([
      { startMs: 0, endMs: 3000, speakerId: "a" },
      { startMs: 3000, endMs: 5000, speakerId: "b" },
      { startMs: 5000, endMs: 10_000, speakerId: "a" },
    ]);
  });

  it("結果不重疊（重疊會讓 speakerAtMs 的二分搜給出錯的答案）", () => {
    const out = assignRange(turns, 3000, 5000, "b");
    for (let i = 1; i < out.length; i++) expect(out[i].startMs).toBeGreaterThanOrEqual(out[i - 1].endMs);
  });

  it("指派給同一個人會接回一整段", () => {
    expect(assignRange(turns, 3000, 5000, "a")).toEqual([{ startMs: 0, endMs: 10_000, speakerId: "a" }]);
  });

  it("null 代表清掉這一段的講者", () => {
    expect(assignRange(turns, 3000, 5000, null)).toEqual([
      { startMs: 0, endMs: 3000, speakerId: "a" },
      { startMs: 5000, endMs: 10_000, speakerId: "a" },
    ]);
  });

  it("手動指派不套自動的最短長度（200 ms 的「對」是使用者的本意）", () => {
    const out = assignRange([], 1000, 1200, "b");
    expect(out).toEqual([{ startMs: 1000, endMs: 1200, speakerId: "b" }]);
  });

  it("反向或零長度的範圍原樣退回", () => {
    expect(assignRange(turns, 5000, 5000, "b")).toBe(turns);
  });

  it("蓋掉整段", () => {
    expect(assignRange(turns, 0, 10_000, "b")).toEqual([{ startMs: 0, endMs: 10_000, speakerId: "b" }]);
  });
});

describe("speakerLabelFromName", () => {
  it("去副檔名與日期尾巴", () => {
    expect(speakerLabelFromName("mark_20260907.wav")).toBe("mark");
    expect(speakerLabelFromName("amy.flac")).toBe("amy");
    expect(speakerLabelFromName("彥廷-20260907-01.wav")).toBe("彥廷");
  });

  it("整個都是數字時不要砍成空字串", () => {
    expect(speakerLabelFromName("20260907.wav")).toBe("20260907");
  });
});

describe("speakerColor", () => {
  it("超出色票數會繞回去，負數也不會炸", () => {
    expect(speakerColor(0)).toBe(speakerColor(6));
    expect(typeof speakerColor(-1)).toBe("string");
  });
});

describe("parseSpeakerState", () => {
  it("擋掉不是物件 / 缺欄位的", () => {
    expect(parseSpeakerState(null)).toBeNull();
    expect(parseSpeakerState({ list: [] })).toBeNull();
  });

  it("段落指到不存在的講者會被丟掉", () => {
    const s = parseSpeakerState({
      list: [{ id: "a", label: "A", colorIndex: 0 }],
      turns: [
        { startMs: 0, endMs: 100, speakerId: "a" },
        { startMs: 200, endMs: 300, speakerId: "ghost" },
      ],
    });
    expect(s?.turns).toHaveLength(1);
  });

  it("反向 / 零長度的段落丟掉", () => {
    const s = parseSpeakerState({
      list: [{ id: "a", label: "A", colorIndex: 0 }],
      turns: [{ startMs: 500, endMs: 100, speakerId: "a" }],
    });
    expect(s?.turns).toEqual([]);
  });

  it("重疊的段落截掉後面那段的頭（二分搜的前提是不重疊）", () => {
    const s = parseSpeakerState({
      list: [
        { id: "a", label: "A", colorIndex: 0 },
        { id: "b", label: "B", colorIndex: 1 },
      ],
      turns: [
        { startMs: 0, endMs: 1000, speakerId: "a" },
        { startMs: 500, endMs: 1500, speakerId: "b" },
      ],
    });
    expect(s?.turns).toEqual([
      { startMs: 0, endMs: 1000, speakerId: "a" },
      { startMs: 1000, endMs: 1500, speakerId: "b" },
    ]);
  });

  it("被完全包住的段落整個丟掉", () => {
    const s = parseSpeakerState({
      list: [
        { id: "a", label: "A", colorIndex: 0 },
        { id: "b", label: "B", colorIndex: 1 },
      ],
      turns: [
        { startMs: 0, endMs: 1000, speakerId: "a" },
        { startMs: 200, endMs: 800, speakerId: "b" },
      ],
    });
    expect(s?.turns).toHaveLength(1);
  });

  it("colorIndex 壞掉時退回 0", () => {
    const s = parseSpeakerState({ list: [{ id: "a", label: "A", colorIndex: "x" }], turns: [] });
    expect(s?.list[0].colorIndex).toBe(0);
  });
});
