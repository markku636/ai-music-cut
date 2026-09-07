import { describe, expect, it } from "vitest";
import { redoMarkerOf, redoRule } from "./redo";
import { RuleContext } from "./context";
import { normText } from "../normalize";
import { thresholdsFor } from "../thresholds";
import type { Sentence, Transcript, Word } from "../types";

/**
 * 用「一句一列」的方式做逐字稿。每一句給文字與起訖，字平均分配。
 *
 * norm 一定要用真的那支算 —— 自己寫一個 toLowerCase 版本就會做出一份跟真實管線
 * 不一樣的假資料，測起來全綠但保護不到任何東西。
 */
function transcript(rows: { text: string[]; startMs: number; endMs: number }[]): Transcript {
  const words: Word[] = [];
  const sentences: Sentence[] = [];
  for (const [sid, r] of rows.entries()) {
    const step = (r.endMs - r.startMs) / r.text.length;
    const ids: number[] = [];
    r.text.forEach((t, i) => {
      const id = words.length;
      words.push({
        id,
        segId: sid,
        text: t,
        norm: normText(t),
        startMs: Math.round(r.startMs + i * step),
        endMs: Math.round(r.startMs + (i + 1) * step),
        prob: 0.9,
      });
      ids.push(id);
    });
    sentences.push({ id: sid, wordIds: ids, startMs: r.startMs, endMs: r.endMs, endsWithQuestion: false });
  }
  return {
    words,
    segments: rows.map((r, i) => ({ id: i, startMs: r.startMs, endMs: r.endMs, text: r.text.join(""), wordIds: sentences[i].wordIds })),
    sentences,
    vad: [],
    durationMs: rows[rows.length - 1]?.endMs ?? 0,
    language: "zh",
    model: "test",
  } as unknown as Transcript;
}

function run(rows: { text: string[]; startMs: number; endMs: number }[]) {
  const ctx = new RuleContext({ transcript: transcript(rows), loudness: [], loudnessHopMs: 100 }, thresholdsFor(50));
  return redoRule(ctx);
}

describe("redoMarkerOf", () => {
  it("開頭是指令詞才算", () => {
    expect(redoMarkerOf("重講")).toBe("重講");
    expect(redoMarkerOf("再來一次好了")).toBe("再來一次");
  });

  it("**指令詞埋在句子中間的是內容，不是指令**", () => {
    expect(redoMarkerOf("我覺得我們可以重來一次")).toBeNull();
    expect(redoMarkerOf("那個活動明年會再來一次")).toBeNull();
  });

  it("空字串 / 純標點回 null", () => {
    expect(redoMarkerOf("")).toBeNull();
    expect(redoMarkerOf("，。")).toBeNull();
  });

  it("標點與大小寫不影響比對（走 normText）", () => {
    expect(redoMarkerOf("重講，")).toBe("重講");
    expect(redoMarkerOf("CUT掉")).toBe("cut掉");
  });
});

describe("redoRule", () => {
  it("把失敗的那次連同指令一起提出來", () => {
    const c = run([
      { text: ["今天", "要", "講", "的", "是"], startMs: 0, endMs: 2000 },
      { text: ["啊", "講", "錯", "了"], startMs: 2100, endMs: 3000 },
      { text: ["重講"], startMs: 3100, endMs: 3500 },
      { text: ["今天", "要", "講", "的", "是", "剪輯"], startMs: 3600, endMs: 6000 },
    ]);
    expect(c).toHaveLength(1);
    // 從前一句的開頭一路剪到指令結束
    expect(c[0].startMs).toBe(2100);
    expect(c[0].endMs).toBe(3500);
    expect(c[0].kind).toBe("redo");
  });

  it("**只建議不自動剪**：分數壓在自動門檻以下", () => {
    const c = run([
      { text: ["講", "錯", "了"], startMs: 0, endMs: 1000 },
      { text: ["重講"], startMs: 1100, endMs: 1500 },
    ]);
    expect(c[0].score).toBeLessThan(0.75);
  });

  it("第一句就是指令時只剪指令本身（前面沒有東西可以重錄）", () => {
    const c = run([
      { text: ["重來"], startMs: 0, endMs: 500 },
      { text: ["今天", "要", "講"], startMs: 600, endMs: 2000 },
    ]);
    expect(c).toHaveLength(1);
    expect(c[0].startMs).toBe(0);
    expect(c[0].endMs).toBe(500);
    expect(c[0].meta?.includesTake).toBe(false);
  });

  it("指令詞在句中不算（「我們重來一次好不好」是內容）", () => {
    const c = run([
      { text: ["這", "個", "遊戲"], startMs: 0, endMs: 1000 },
      { text: ["我們", "重來", "一次", "好", "不", "好"], startMs: 1100, endMs: 3000 },
    ]);
    expect(c).toEqual([]);
  });

  it("指令句太長不算 —— 真的在下指令的人不會講一長串", () => {
    const c = run([
      { text: ["前", "一", "句"], startMs: 0, endMs: 1000 },
      { text: ["重講", "一", "下", "因為", "我", "剛剛", "看", "到", "有", "人", "進來"], startMs: 1100, endMs: 5000 },
    ]);
    expect(c).toEqual([]);
  });

  it("離前一句太遠就不連著剪（那多半已經是別的內容了）", () => {
    const c = run([
      { text: ["很", "久", "以前"], startMs: 0, endMs: 1000 },
      { text: ["重講"], startMs: 60_000, endMs: 60_500 },
    ]);
    expect(c[0].startMs).toBe(60_000);
    expect(c[0].meta?.includesTake).toBe(false);
  });

  it("一集裡有好幾次重錄就提好幾筆", () => {
    const c = run([
      { text: ["第", "一", "次"], startMs: 0, endMs: 1000 },
      { text: ["重講"], startMs: 1100, endMs: 1500 },
      { text: ["第", "二", "次"], startMs: 1600, endMs: 2600 },
      { text: ["再來一次"], startMs: 2700, endMs: 3200 },
      { text: ["好", "的", "版本"], startMs: 3300, endMs: 4300 },
    ]);
    expect(c).toHaveLength(2);
    expect(c.map((x) => x.startMs)).toEqual([0, 1600]);
  });

  it("沒有指令詞就什麼都不提", () => {
    expect(run([{ text: ["今天", "天氣", "很好"], startMs: 0, endMs: 2000 }])).toEqual([]);
  });

  it("空逐字稿不會炸", () => {
    expect(run([])).toEqual([]);
  });

  it("理由要寫出是哪一句被連帶剪掉（人要看得懂為什麼）", () => {
    const c = run([
      { text: ["今天", "要", "講", "剪輯"], startMs: 0, endMs: 2000 },
      { text: ["重講"], startMs: 2100, endMs: 2500 },
    ]);
    expect(c[0].reason).toContain("重講");
    expect(c[0].reason).toContain("今天要講剪輯");
  });
});
