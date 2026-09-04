import { describe, expect, it } from "vitest";
import { normText, normalizeTranscript, type ServerTranscript } from "./normalize";

function seg(id: number, start: number, words: [string, number][], opts: Partial<ServerTranscript["segments"][number]> = {}) {
  let t = start;
  const ws = words.map(([w, d]) => {
    const s = t;
    t += d;
    return { start: s, end: t, word: w, probability: 0.9 };
  });
  return { id, start, end: t, text: words.map((x) => x[0]).join(""), words: ws, ...opts };
}

describe("normalize", () => {
  it("normText strips punctuation and lowercases", () => {
    expect(normText("那個，")).toBe("那個");
    expect(normText(" Like! ")).toBe("like");
    expect(normText("ＯＫ")).toBe("ok");
  });

  it("converts seconds to ms and assigns ids", () => {
    const tr = normalizeTranscript({
      duration_sec: 3.5,
      segments: [seg(0, 0.5, [["嗯，", 0.2], ["今天", 0.3]])],
      vad: [{ start: 0.4, end: 1.2 }],
    });
    expect(tr.durationMs).toBe(3500);
    expect(tr.words.map((w) => w.id)).toEqual([0, 1]);
    expect(tr.words[0]).toMatchObject({ startMs: 500, endMs: 700, norm: "嗯" });
    expect(tr.vad[0]).toEqual({ startMs: 400, endMs: 1200 });
    expect(tr.segments[0].wordIds).toEqual([0, 1]);
  });

  it("splits sentences on punctuation, long gaps and marks questions", () => {
    const tr = normalizeTranscript({
      duration_sec: 10,
      segments: [
        seg(0, 0, [["你", 0.2], ["好", 0.2], ["嗎？", 0.2]]),
        seg(1, 0.7, [["我", 0.2], ["很好。", 0.3]]),
        seg(2, 2.0, [["然後", 0.3], ["呢", 0.2]]),
      ],
    });
    expect(tr.sentences.length).toBe(3);
    expect(tr.sentences[0].endsWithQuestion).toBe(true);
    expect(tr.sentences[1].endsWithQuestion).toBe(false);
    expect(tr.sentences[2].wordIds).toEqual([5, 6]);
    expect(tr.sentences[2].endsWithQuestion).toBe(true);
  });

  it("keeps hallucination flag on segments", () => {
    const tr = normalizeTranscript({ duration_sec: 2, segments: [seg(0, 0, [["感謝觀看", 0.2]], { hallucination: true })] });
    expect(tr.segments[0].hallucination).toBe(true);
  });
});
