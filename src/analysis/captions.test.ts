import { describe, expect, it } from "vitest";
import {
  buildCues,
  DEFAULT_CAPTIONS,
  displayWidth,
  joinWords,
  renderCaptions,
  srtTime,
  stampOf,
  tidyCues,
  toMarkdown,
  toPlainText,
  toSrt,
  toVtt,
  vttTime,
  wordSurvives,
  type Cue,
} from "./captions";
import type { KeepSegment } from "./edl/build";
import type { Sentence, Word } from "./types";

function w(id: number, s: number, e: number, text: string): Word {
  return { id, segId: 0, text, norm: text.toLowerCase(), startMs: s, endMs: e, prob: 0.9 };
}

function sent(id: number, wordIds: number[], words: Word[]): Sentence {
  const first = words[wordIds[0]];
  const last = words[wordIds[wordIds.length - 1]];
  return { id, wordIds, startMs: first.startMs, endMs: last.endMs, endsWithQuestion: false };
}

/** 完整保留（來源時間 = 成品時間）。 */
function keepAll(durationMs: number): KeepSegment[] {
  return [{ id: 0, srcStartMs: 0, srcEndMs: durationMs, outStartMs: 0, outEndMs: durationMs, gainDb: 0 }];
}

describe("displayWidth", () => {
  it("中日韓算 2 格、拉丁算 1 格", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("你好")).toBe(4);
    expect(displayWidth("你好abc")).toBe(7);
  });

  it("全形標點也算 2 格（不然一行會爆出去）", () => {
    expect(displayWidth("，")).toBe(2);
  });

  it("空字串是 0", () => {
    expect(displayWidth("")).toBe(0);
  });
});

describe("joinWords", () => {
  it("中文之間不加空白", () => {
    expect(joinWords(["今天", "天氣", "很好"])).toBe("今天天氣很好");
  });

  it("英文之間加空白", () => {
    expect(joinWords(["hello", "world"])).toBe("hello world");
  });

  it("中英交界不硬加空白（Whisper 給的字本來就帶好了）", () => {
    expect(joinWords(["我用", "Vite"])).toBe("我用Vite");
  });

  it("空字與空白字丟掉", () => {
    expect(joinWords(["a", "", "  ", "b"])).toBe("a b");
  });
});

describe("wordSurvives", () => {
  const keeps: KeepSegment[] = [
    { id: 0, srcStartMs: 0, srcEndMs: 1000, outStartMs: 0, outEndMs: 1000, gainDb: 0 },
    { id: 1, srcStartMs: 2000, srcEndMs: 3000, outStartMs: 1000, outEndMs: 2000, gainDb: 0 },
  ];

  it("落在保留段內的活著", () => {
    expect(wordSurvives(keeps, w(0, 100, 300, "a"))).toBe(true);
  });

  it("落在剪除區的不見（不是往前挪，是根本沒說過）", () => {
    expect(wordSurvives(keeps, w(0, 1200, 1400, "a"))).toBe(false);
  });

  it("跨邊界時看中點（大部分還在就算活著）", () => {
    expect(wordSurvives(keeps, w(0, 900, 1100, "a"))).toBe(false); // 中點 1000 → 不在 [0,1000)，右開區間
    expect(wordSurvives(keeps, w(0, 800, 1100, "a"))).toBe(true); // 中點 950 → 在
    expect(wordSurvives(keeps, w(0, 950, 1300, "a"))).toBe(false); // 中點 1125 → 不在
  });
});

describe("buildCues：時間", () => {
  const words = [w(0, 0, 500, "今天"), w(1, 500, 1000, "天氣"), w(2, 4000, 4500, "很好")];
  const sentences = [sent(0, [0, 1], words), sent(1, [2], words)];

  it("**被剪掉的字整個不出現**", () => {
    // 只留 0–1000ms；「很好」在剪掉的區間
    const keeps: KeepSegment[] = [{ id: 0, srcStartMs: 0, srcEndMs: 1000, outStartMs: 0, outEndMs: 1000, gainDb: 0 }];
    const cues = buildCues({ words, sentences, keeps });
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("今天天氣");
  });

  it("**時間是成品時間不是來源時間**（剪掉中間之後後面要往前挪）", () => {
    // 保留 0–1000 與 4000–4500；成品裡第二段從 1000 開始
    const keeps: KeepSegment[] = [
      { id: 0, srcStartMs: 0, srcEndMs: 1000, outStartMs: 0, outEndMs: 1000, gainDb: 0 },
      { id: 1, srcStartMs: 4000, srcEndMs: 4500, outStartMs: 1000, outEndMs: 1500, gainDb: 0 },
    ];
    const cues = buildCues({ words, sentences, keeps, opts: { minMs: 0 } });
    expect(cues.map((c) => c.text)).toEqual(["今天天氣", "很好"]);
    expect(cues[1].startMs).toBe(1000);
    expect(cues[1].endMs).toBe(1500);
  });

  it("沒有 keeps 時回空的（還沒建 EDL）", () => {
    expect(buildCues({ words, sentences, keeps: [] })).toEqual([]);
  });

  it("整份都被剪掉時回空的，不是一則空字幕", () => {
    const keeps: KeepSegment[] = [{ id: 0, srcStartMs: 9000, srcEndMs: 9500, outStartMs: 0, outEndMs: 500, gainDb: 0 }];
    expect(buildCues({ words, sentences, keeps })).toEqual([]);
  });
});

describe("buildCues：斷句", () => {
  it("句子之間一定斷開（一則跨兩句會黏在一起）", () => {
    const words = [w(0, 0, 400, "你好。"), w(1, 400, 800, "今天")];
    const cues = buildCues({ words, sentences: [sent(0, [0], words), sent(1, [1], words)], keeps: keepAll(1000), opts: { minMs: 0 } });
    expect(cues.map((c) => c.text)).toEqual(["你好。", "今天"]);
  });

  it("剪掉一個贅字不打碎句子（只有兩三百毫秒）", () => {
    const words = [w(0, 0, 400, "然後"), w(1, 700, 1100, "我們")];
    const cues = buildCues({ words, sentences: [sent(0, [0, 1], words)], keeps: keepAll(2000), opts: { minMs: 0 } });
    expect(cues).toHaveLength(1);
  });

  it("剪掉一大段就斷開（那是真的換場景）", () => {
    const words = [w(0, 0, 400, "然後"), w(1, 5000, 5400, "我們")];
    const cues = buildCues({ words, sentences: [sent(0, [0, 1], words)], keeps: keepAll(6000), opts: { minMs: 0 } });
    expect(cues).toHaveLength(2);
  });

  it("超過字數上限就斷（中文以顯示寬度算）", () => {
    const words = [w(0, 0, 400, "一二三四"), w(1, 400, 800, "五六七八")];
    // maxWidth 8 → 兩個字組合起來是 16 格，塞不下
    const cues = buildCues({ words, sentences: [sent(0, [0, 1], words)], keeps: keepAll(1000), opts: { maxWidth: 8, minMs: 0 } });
    expect(cues.map((c) => c.text)).toEqual(["一二三四", "五六七八"]);
  });

  it("超過時長上限就斷（就算字很少）", () => {
    const words = [w(0, 0, 400, "嗯"), w(1, 400, 9000, "啊")];
    const cues = buildCues({ words, sentences: [sent(0, [0, 1], words)], keeps: keepAll(10_000), opts: { maxMs: 3000, minMs: 0 } });
    expect(cues).toHaveLength(2);
  });

  it("換講者一定另起一則（一則混兩個人的話不能讀）", () => {
    const words = [w(0, 0, 400, "你好"), w(1, 400, 800, "你好")];
    const cues = buildCues({
      words,
      sentences: [sent(0, [0, 1], words)],
      keeps: keepAll(1000),
      speakerOf: new Map([
        [0, "a"],
        [1, "b"],
      ]),
      opts: { minMs: 0 },
    });
    expect(cues.map((c) => c.speakerId)).toEqual(["a", "b"]);
  });

  it("沒有內容的字跳過（Whisper 偶爾給空字串）", () => {
    const words = [w(0, 0, 400, "  "), w(1, 400, 800, "在")];
    const cues = buildCues({ words, sentences: [sent(0, [0, 1], words)], keeps: keepAll(1000), opts: { minMs: 0 } });
    expect(cues.map((c) => c.text)).toEqual(["在"]);
  });
});

describe("tidyCues", () => {
  const o = { ...DEFAULT_CAPTIONS, minMs: 800, cueGapMs: 40 };

  it("太短的拉長到 minMs", () => {
    const out = tidyCues([{ index: 0, startMs: 0, endMs: 200, text: "a" }], o);
    expect(out[0].endMs).toBe(800);
  });

  it("拉長不可以吃到下一則（重疊播放器會亂）", () => {
    const out = tidyCues(
      [
        { index: 0, startMs: 0, endMs: 200, text: "a" },
        { index: 0, startMs: 500, endMs: 1500, text: "b" },
      ],
      o,
    );
    expect(out[0].endMs).toBe(460); // 500 - 40
    expect(out[0].endMs).toBeLessThan(out[1].startMs);
  });

  it("結果一定遞增且不重疊", () => {
    const out = tidyCues(
      [
        { index: 0, startMs: 1000, endMs: 2000, text: "b" },
        { index: 0, startMs: 0, endMs: 1500, text: "a" },
      ],
      o,
    );
    for (let i = 1; i < out.length; i++) expect(out[i].startMs).toBeGreaterThanOrEqual(out[i - 1].endMs);
  });

  it("擠不下的整則丟掉，不產生零長度字幕", () => {
    const out = tidyCues(
      [
        { index: 0, startMs: 0, endMs: 100, text: "a" },
        { index: 0, startMs: 100, endMs: 120, text: "b" },
        { index: 0, startMs: 5000, endMs: 6000, text: "c" },
      ],
      o,
    );
    expect(out.every((c) => c.endMs > c.startMs)).toBe(true);
  });

  it("重新編號從 1 開始且連續", () => {
    const out = tidyCues(
      [
        { index: 9, startMs: 0, endMs: 1000, text: "a" },
        { index: 9, startMs: 2000, endMs: 3000, text: "b" },
      ],
      o,
    );
    expect(out.map((c) => c.index)).toEqual([1, 2]);
  });

  it("空清單不會炸", () => {
    expect(tidyCues([], o)).toEqual([]);
  });
});

describe("時間格式", () => {
  it("SRT 用逗號、VTT 用小數點", () => {
    expect(srtTime(3_723_456)).toBe("01:02:03,456");
    expect(vttTime(3_723_456)).toBe("01:02:03.456");
  });

  it("毫秒補到三位（456 不能寫成 45）", () => {
    expect(srtTime(1_020)).toBe("00:00:01,020");
    expect(srtTime(1_002)).toBe("00:00:01,002");
  });

  it("負數夾到 0（不要輸出 -00:00:01）", () => {
    expect(srtTime(-500)).toBe("00:00:00,000");
  });

  it("stampOf 一小時以下不寫小時", () => {
    expect(stampOf(75_000)).toBe("1:15");
    expect(stampOf(3_675_000)).toBe("1:01:15");
  });
});

describe("輸出格式", () => {
  const cues: Cue[] = [
    { index: 1, startMs: 0, endMs: 1500, text: "你好", speakerId: "a" },
    { index: 2, startMs: 2000, endMs: 3500, text: "很高興認識你", speakerId: "b" },
  ];
  const labelOf = (id: string) => (id === "a" ? "Mark" : "來賓");

  it("SRT 的每一則是「編號 / 時間 / 文字 / 空行」", () => {
    expect(toSrt(cues)).toBe("1\n00:00:00,000 --> 00:00:01,500\n你好\n\n2\n00:00:02,000 --> 00:00:03,500\n很高興認識你\n");
  });

  it("VTT 第一行必須是 WEBVTT（少了整份不合法）", () => {
    expect(toVtt(cues).startsWith("WEBVTT\n\n")).toBe(true);
    expect(toVtt(cues)).toContain("00:00:00.000 --> 00:00:01.500");
  });

  it("講者名字可以寫進字幕文字", () => {
    expect(toSrt(cues, { speakerPrefix: true, labelOf })).toContain("Mark：你好");
    expect(toPlainText(cues, { speakerPrefix: true, labelOf })).toBe("Mark：你好\n來賓：很高興認識你\n");
  });

  it("沒開 speakerPrefix 就不寫名字", () => {
    expect(toSrt(cues)).not.toContain("Mark");
  });

  it("Markdown 換人時另起一段並加粗名字", () => {
    const md = toMarkdown(cues, { labelOf });
    expect(md).toContain("**Mark**");
    expect(md).toContain("**來賓**");
    expect(md).toContain("`0:00` 你好");
  });

  it("Markdown 可以不要時間戳", () => {
    expect(toMarkdown(cues, { labelOf, timestamps: false })).not.toContain("`0:00`");
  });

  it("renderCaptions 四種格式都通", () => {
    for (const f of ["srt", "vtt", "md", "txt"] as const) {
      expect(renderCaptions(cues, f, { labelOf }).length).toBeGreaterThan(0);
    }
  });

  it("空的 cues 不會產生壞檔（VTT 仍有表頭）", () => {
    expect(toVtt([])).toBe("WEBVTT\n\n");
    expect(toSrt([])).toBe("");
  });
});

describe("端到端：剪掉贅字之後字幕不會飄", () => {
  it("後面的字幕時間跟著往前挪，且與成品長度一致", () => {
    // 三句話，中間第二句被整段剪掉
    const words = [
      w(0, 0, 900, "第一句"),
      w(1, 2000, 2900, "第二句"),
      w(2, 4000, 4900, "第三句"),
    ];
    const sentences = [sent(0, [0], words), sent(1, [1], words), sent(2, [2], words)];
    const keeps: KeepSegment[] = [
      { id: 0, srcStartMs: 0, srcEndMs: 1000, outStartMs: 0, outEndMs: 1000, gainDb: 0 },
      { id: 1, srcStartMs: 3800, srcEndMs: 5000, outStartMs: 1000, outEndMs: 2200, gainDb: 0 },
    ];
    const cues = buildCues({ words, sentences, keeps, opts: { minMs: 0 } });
    expect(cues.map((c) => c.text)).toEqual(["第一句", "第三句"]);
    // 第三句在來源 4000，在成品是 1000 + (4000 - 3800) = 1200
    expect(cues[1].startMs).toBe(1200);
    // 沒有任何一則超出成品長度
    expect(Math.max(...cues.map((c) => c.endMs))).toBeLessThanOrEqual(2200);
  });
});

describe("buildCues：亂序的 EDL（剪下貼上 / 搬移）", () => {
  // 來源：四句各 1 秒，中間空 200 ms
  const words = [w(0, 0, 800, "第一句"), w(1, 1000, 1800, "第二句"), w(2, 2000, 2800, "第三句"), w(3, 3000, 3800, "第四句")];
  const sentences = [sent(0, [0], words), sent(1, [1], words), sent(2, [2], words), sent(3, [3], words)];

  it("搬移：字幕依成品順序排，而且結束不會早於開始", () => {
    // 成品順序＝第三句、第一句（來源往回跳）
    const keeps: KeepSegment[] = [
      { id: 0, srcStartMs: 1900, srcEndMs: 2900, outStartMs: 0, outEndMs: 1000, gainDb: 0 },
      { id: 1, srcStartMs: 0, srcEndMs: 900, outStartMs: 1000, outEndMs: 1900, gainDb: 0 },
    ];
    const cues = buildCues({ words, sentences, keeps, opts: { minMs: 0 } });
    expect(cues.map((c) => c.text)).toEqual(["第三句", "第一句"]);
    // 每一則都必須是正長度，而且依成品時間遞增
    for (const c of cues) expect(c.endMs).toBeGreaterThan(c.startMs);
    expect(cues[0].startMs).toBeLessThan(cues[1].startMs);
    // 第三句在來源 2000，這一段的位移是 -1900 → 成品 100
    expect(cues[0].startMs).toBe(100);
    // 第一句在來源 0，這一段的位移是 +1000 → 成品 1000
    expect(cues[1].startMs).toBe(1000);
  });

  it("貼上：同一句在成品出現兩次，字幕也要出現兩次", () => {
    // 成品＝第一句、第三句（貼上的那一份）、第三句（原本的位置）
    const keeps: KeepSegment[] = [
      { id: 0, srcStartMs: 0, srcEndMs: 900, outStartMs: 0, outEndMs: 900, gainDb: 0 },
      { id: 1, srcStartMs: 1900, srcEndMs: 2900, outStartMs: 900, outEndMs: 1900, gainDb: 0 },
      { id: 2, srcStartMs: 1900, srcEndMs: 2900, outStartMs: 1900, outEndMs: 2900, gainDb: 0 },
    ];
    const cues = buildCues({ words, sentences, keeps, opts: { minMs: 0 } });
    expect(cues.map((c) => c.text)).toEqual(["第一句", "第三句", "第三句"]);
    expect(cues[1].startMs).toBe(1000); // 900 + (2000 - 1900)
    expect(cues[2].startMs).toBe(2000); // 1900 + (2000 - 1900)
    for (const c of cues) expect(c.endMs).toBeGreaterThan(c.startMs);
  });

  it("接縫兩邊不會被黏成同一則字幕", () => {
    // 第一句與第四句在成品裡緊鄰，但來源上差了 2 秒以上
    const keeps: KeepSegment[] = [
      { id: 0, srcStartMs: 2900, srcEndMs: 3900, outStartMs: 0, outEndMs: 1000, gainDb: 0 },
      { id: 1, srcStartMs: 0, srcEndMs: 900, outStartMs: 1000, outEndMs: 1900, gainDb: 0 },
    ];
    const cues = buildCues({ words, sentences, keeps, opts: { minMs: 0, maxWidth: 999, maxMs: 999_999 } });
    expect(cues.map((c) => c.text)).toEqual(["第四句", "第一句"]);
  });
});

describe("buildCues：同一句話被搬移拆到接縫兩邊", () => {
  it("不會做出一則「結束早於開始」的字幕", () => {
    // 一句話的兩個字，成品裡「乙」在前、「甲」在後（搬移）
    const words = [w(0, 0, 400, "甲"), w(1, 3000, 3400, "乙")];
    const sentences = [sent(0, [0, 1], words)];
    const keeps: KeepSegment[] = [
      { id: 0, srcStartMs: 2900, srcEndMs: 3500, outStartMs: 0, outEndMs: 600, gainDb: 0 },
      { id: 1, srcStartMs: 0, srcEndMs: 500, outStartMs: 600, outEndMs: 1100, gainDb: 0 },
    ];
    // breakGapMs 開到很大，把「大段剪除就斷開」那條規則排除掉 ——
    // 這裡要測的是「來源往回跳」本身有沒有被當成斷點。
    const cues = buildCues({ words, sentences, keeps, opts: { minMs: 0, breakGapMs: 999_999, maxWidth: 999 } });
    expect(cues.map((c) => c.text)).toEqual(["乙", "甲"]);
    for (const c of cues) expect(c.endMs).toBeGreaterThan(c.startMs);
    expect(cues[0].startMs).toBe(100); // 3000 - 2900
    expect(cues[1].startMs).toBe(600); // 0 + 600
  });
});
