import { describe, expect, it } from "vitest";
import type { Sentence, VadRegion } from "../types";
import { breathContextAt, breathFor, DEFAULT_BREATH_OPTIONS, planBreath, silenceFractionOf } from "./breath";

// 兩句：S0（0–1000）、S1（2000–3000），中間停 1000 ms。
// 標點在這裡不重要 —— breathContextAt 只看停頓長度，連字都不收了。
const SENTENCES: Sentence[] = [
  { id: 0, wordIds: [0, 1], startMs: 0, endMs: 1000, endsWithQuestion: false },
  { id: 1, wordIds: [2, 3], startMs: 2000, endMs: 3000, endsWithQuestion: false },
];

describe("breathContextAt", () => {
  it("句號收尾 + 講者本人停了 1 秒 → 段落", () => {
    expect(breathContextAt(SENTENCES, 1000, 2000)).toBe("paragraph");
  });

  it("句號收尾但只停 300 ms → 只是句尾，不是段落", () => {
    // 中文每個正常句子都以句號結尾。只看標點的話「每一句都是段落」，
    // 而 Whisper 給不給句號是浮動的 —— 成品這裡要留 340 還是 575 ms
    // 就變成由辨識器的一個 coin flip 決定。
    const sents: Sentence[] = [
      { id: 0, wordIds: [0, 1], startMs: 0, endMs: 1000, endsWithQuestion: false },
      { id: 1, wordIds: [2], startMs: 1300, endMs: 1800, endsWithQuestion: false },
    ];
    expect(breathContextAt(sents, 1000, 1300)).toBe("sentence");
  });

  it("停很久但沒有句尾標點 → 仍然是段落（Whisper 常常漏句號）", () => {
    const sents: Sentence[] = [
      { id: 0, wordIds: [0, 1], startMs: 0, endMs: 1000, endsWithQuestion: false },
      { id: 1, wordIds: [2], startMs: 3000, endMs: 3500, endsWithQuestion: false },
    ];
    expect(breathContextAt(sents, 1000, 3000)).toBe("paragraph");
  });

  it("句子中間 → within", () => {
    expect(breathContextAt(SENTENCES, 300, 450)).toBe("within");
    expect(breathContextAt(SENTENCES, 2200, 2400)).toBe("within");
  });

  it("最後一句結束之後沒有下一句 → 不算段落交界", () => {
    expect(breathContextAt([SENTENCES[1]], 3000, 3500)).toBe("sentence");
  });
});

describe("breathFor（隨激進度縮放）", () => {
  it("越積極留白越短", () => {
    const lo = breathFor(0);
    const hi = breathFor(100);
    expect(hi.withinMs).toBeLessThan(lo.withinMs);
    expect(hi.sentenceMs).toBeLessThan(lo.sentenceMs);
    expect(hi.paragraphMs).toBeLessThan(lo.paragraphMs);
  });

  it("三級一定是遞增的（句中 < 句尾 < 段落）", () => {
    for (const a of [0, 25, 50, 75, 100]) {
      const b = breathFor(a);
      expect(b.withinMs).toBeLessThan(b.sentenceMs);
      expect(b.sentenceMs).toBeLessThan(b.paragraphMs);
    }
  });
});

describe("silenceFractionOf", () => {
  const vad: VadRegion[] = [{ startMs: 0, endMs: 1000 }, { startMs: 2000, endMs: 3000 }];
  it("全在語音裡 → 0", () => expect(silenceFractionOf(vad, 100, 900)).toBeCloseTo(0, 6));
  it("全在靜音裡 → 1", () => expect(silenceFractionOf(vad, 1200, 1800)).toBeCloseTo(1, 6));
  it("一半一半", () => expect(silenceFractionOf(vad, 900, 1100)).toBeCloseTo(0.5, 6));
});

describe("planBreath", () => {
  // 語音 0–1000、靜音 1000–2000、語音 2000–3000
  const vad: VadRegion[] = [{ startMs: 0, endMs: 1000 }, { startMs: 2000, endMs: 3000 }];

  it("剪的不是語音就不動（純靜音 / 雜音本來就沒有接得順不順的問題）", () => {
    const r = planBreath(vad, SENTENCES, { startMs: 1000, endMs: 2000, speech: false }, DEFAULT_BREATH_OPTIONS);
    expect(r).toMatchObject({ startMs: 1000, endMs: 2000, restoredMs: 0, gapMs: 0 });
  });

  it("尾端有足夠靜音 → 先還尾端（像講者開口前換氣）", () => {
    const opts = { ...DEFAULT_BREATH_OPTIONS, paragraphMs: 300 };
    const r = planBreath(vad, SENTENCES, { startMs: 1000, endMs: 2000, speech: true }, opts);
    expect(r.context).toBe("paragraph");
    expect(r.restoredMs).toBe(300);
    expect(r.endMs).toBe(1700); // 尾端還了 300ms
    expect(r.startMs).toBe(1000); // 頭端沒動
    expect(r.gapMs).toBe(0);
  });

  it("靜音不夠就能還多少還多少，剩下的用 room tone 補（不是全有全無）", () => {
    // 只有 1000–1120 是靜音
    const tight: VadRegion[] = [{ startMs: 0, endMs: 1000 }, { startMs: 1120, endMs: 3000 }];
    const opts = { ...DEFAULT_BREATH_OPTIONS, paragraphMs: 300, allowGapInsert: true, minGapMs: 0 };
    const r = planBreath(tight, SENTENCES, { startMs: 1000, endMs: 1500, speech: true }, opts);
    expect(r.restoredMs).toBeGreaterThan(0);
    expect(r.restoredMs).toBeLessThan(300);
    expect(r.gapMs).toBeGreaterThan(0);
    expect(r.restoredMs + r.gapMs).toBeCloseTo(300, 0);
  });

  it("不允許插 room tone 時就只還找得到的那些", () => {
    const tight: VadRegion[] = [{ startMs: 0, endMs: 1000 }, { startMs: 1120, endMs: 3000 }];
    const opts = { ...DEFAULT_BREATH_OPTIONS, paragraphMs: 300, allowGapInsert: false };
    const r = planBreath(tight, SENTENCES, { startMs: 1000, endMs: 1500, speech: true }, opts);
    expect(r.gapMs).toBe(0);
  });

  it("句中的留白目標比段落短（同一刀、同樣的靜音，只有 context 不同）", () => {
    const opts = breathFor(50);
    // 同一個剪除區：兩句話中間 vs 一整句的中間
    const oneSentence: Sentence[] = [{ id: 0, wordIds: [0, 1, 2, 3], startMs: 0, endMs: 3000, endsWithQuestion: false }];
    const para = planBreath(vad, SENTENCES, { startMs: 1000, endMs: 2000, speech: true }, opts);
    const within = planBreath(vad, oneSentence, { startMs: 1000, endMs: 2000, speech: true }, opts);
    expect(para.context).toBe("paragraph");
    expect(within.context).toBe("within");
    expect(para.restoredMs).toBeGreaterThan(within.restoredMs);
  });

  it("激進度 0 與 100 還回去的量不一樣", () => {
    const r0 = planBreath(vad, SENTENCES, { startMs: 1000, endMs: 2000, speech: true }, breathFor(0));
    const r100 = planBreath(vad, SENTENCES, { startMs: 1000, endMs: 2000, speech: true }, breathFor(100));
    expect(r0.restoredMs).toBeGreaterThan(r100.restoredMs);
  });

  it("只差一點點就不插 room tone（塞一小段合成雜訊比直接交叉還假）", () => {
    // 靜音 1000–1280（280ms），目標 300ms → 只差 20ms
    const near: VadRegion[] = [{ startMs: 0, endMs: 1000 }, { startMs: 1280, endMs: 3000 }];
    const opts = { ...DEFAULT_BREATH_OPTIONS, paragraphMs: 300, allowGapInsert: true, minGapMs: 60 };
    const r = planBreath(near, SENTENCES, { startMs: 1000, endMs: 1500, speech: true }, opts);
    expect(r.gapMs).toBe(0);
    expect(r.restoredMs).toBeGreaterThan(200);
  });

  it("句子中間不插 room tone —— 剛拿掉的猶豫不要又放回去", () => {
    const oneSentence: Sentence[] = [{ id: 0, wordIds: [0, 1, 2, 3], startMs: 0, endMs: 3000, endsWithQuestion: false }];
    const tight: VadRegion[] = [{ startMs: 0, endMs: 1000 }, { startMs: 1020, endMs: 3000 }];
    const opts = { ...DEFAULT_BREATH_OPTIONS, withinMs: 200, minGapMs: 60, allowGapInsert: true };
    const within = planBreath(tight, oneSentence, { startMs: 1000, endMs: 1500, speech: true }, opts);
    expect(within.context).toBe("within");
    expect(within.gapMs).toBe(0);
    // 同樣的一刀，換成段落交界就會補
    const para = planBreath(tight, SENTENCES, { startMs: 1000, endMs: 1500, speech: true }, { ...opts, paragraphMs: 400 });
    expect(para.context).toBe("paragraph");
    expect(para.gapMs).toBeGreaterThan(0);
  });

  it("剪除區本身是空的不會爆", () => {
    const r = planBreath(vad, SENTENCES, { startMs: 1500, endMs: 1500, speech: true }, DEFAULT_BREATH_OPTIONS);
    expect(r.restoredMs).toBe(0);
  });
});
