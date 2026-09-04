import { describe, expect, it } from "vitest";
import { normalizeTranscript, type ServerTranscript } from "../normalize";
import { thresholdsFor } from "../thresholds";
import type { Candidate, LoudnessWindow } from "../types";
import { runRules } from "./index";
import { lcsLen } from "./repeats";

/** 以 [text, startMs, endMs, prob?] 建一段逐字稿（單 segment）。 */
type Spec = [string, number, number, number?];
function tr(specs: Spec[], opts: { durationMs?: number; vad?: [number, number][]; segBreaks?: number[]; segOpts?: Record<number, Partial<ServerTranscript["segments"][number]>> } = {}) {
  const breaks = new Set(opts.segBreaks ?? []);
  const segments: ServerTranscript["segments"] = [];
  let cur: Spec[] = [];
  const flush = () => {
    if (!cur.length) return;
    const id = segments.length;
    segments.push({
      id,
      start: cur[0][1] / 1000,
      end: cur[cur.length - 1][2] / 1000,
      text: cur.map((s) => s[0]).join(""),
      words: cur.map((s) => ({ start: s[1] / 1000, end: s[2] / 1000, word: s[0], probability: s[3] ?? 0.9 })),
      ...(opts.segOpts?.[id] ?? {}),
    });
    cur = [];
  };
  specs.forEach((s, i) => {
    if (breaks.has(i)) flush();
    cur.push(s);
  });
  flush();
  const last = specs[specs.length - 1]?.[2] ?? 0;
  return normalizeTranscript({
    duration_sec: (opts.durationMs ?? last + 500) / 1000,
    segments,
    vad: (opts.vad ?? [[specs[0]?.[1] ?? 0, last]]).map(([a, b]) => ({ start: a / 1000, end: b / 1000 })),
  });
}

function run(specs: Spec[], aggr = 50, opts: Parameters<typeof tr>[1] = {}, loudness: LoudnessWindow[] = []) {
  return runRules({ transcript: tr(specs, opts), loudness, loudnessHopMs: 100 }, thresholdsFor(aggr));
}

const kinds = (c: Candidate[]) => c.map((x) => x.kind);
const texts = (c: Candidate[], t: ReturnType<typeof tr>) => c.map((x) => x.wordIds.map((id) => t.words[id].text).join(""));

describe("thresholds", () => {
  it("interpolates and rounds integer keys", () => {
    expect(thresholdsFor(50).pauseKeepMs).toBe(350);
    expect(thresholdsFor(0).unclearMinRun).toBe(3);
    expect(thresholdsFor(100).unclearMinRun).toBe(2);
    expect(thresholdsFor(50).fillerAutoScore).toBeCloseTo(0.75);
  });
});

describe("filler rule", () => {
  it("pure filler 嗯 is a strong candidate", () => {
    const c = run([["嗯", 0, 200], ["今天", 400, 700], ["我們", 700, 1000], ["來", 1000, 1200], ["聊", 1200, 1400]]);
    const f = c.find((x) => x.kind === "filler");
    expect(f).toBeDefined();
    expect(f!.score).toBeGreaterThanOrEqual(0.9);
    expect(f!.startMs).toBe(0);
  });

  it("那個 + noun without pause is a determiner (kept); with pause it is a filler", () => {
    const keep = run([["我", 0, 200], ["用", 200, 400], ["那個", 400, 700], ["系統", 750, 1100], ["很", 1100, 1300], ["久", 1300, 1500]]);
    expect(keep.filter((x) => x.kind === "filler")).toHaveLength(0);
    const cut = run([["我", 0, 200], ["用", 200, 400], ["那個", 400, 700], ["系統", 1200, 1500], ["很", 1500, 1700], ["久", 1700, 1900]]);
    const f = cut.filter((x) => x.kind === "filler");
    expect(f).toHaveLength(1);
    expect(f[0].reason).toContain("那個");
  });

  it("對 after a question is an answer (low score); standalone 對 mid-monologue is a filler", () => {
    const t1: Spec[] = [["你", 0, 150], ["好", 150, 300], ["嗎？", 300, 500], ["對", 1200, 1400], ["我", 2200, 2400], ["很", 2400, 2600], ["好", 2600, 2800]];
    const c1 = run(t1);
    const d1 = c1.find((x) => x.kind === "filler" && x.startMs === 1200);
    expect(d1?.score ?? 0).toBeLessThan(0.3);
    const t2: Spec[] = [["這", 0, 150], ["很", 150, 300], ["重要。", 300, 600], ["對", 1000, 1200], ["然後", 1600, 1900], ["我們", 1900, 2100], ["繼續", 2100, 2400]];
    const c2 = run(t2);
    const d2 = c2.find((x) => x.kind === "filler" && x.startMs === 1000);
    expect(d2?.score ?? 0).toBeGreaterThanOrEqual(0.7);
  });

  it("sentence-initial 然後 without pause stays low; 然後 mid-sentence before a pause is high", () => {
    const c = run([["然後", 0, 250], ["我們", 300, 500], ["就", 500, 650], ["走", 650, 800], ["了。", 800, 1000], ["然後", 1300, 1550], ["我們", 1600, 1800], ["到", 1800, 2000], ["然後", 2000, 2250], ["那裡", 2800, 3100], ["休息", 3100, 3400]]);
    const f = c.filter((x) => x.kind === "filler");
    const first = f.find((x) => x.startMs === 0);
    expect(first?.score ?? 0).toBeLessThanOrEqual(0.35);
    const mid = f.find((x) => x.startMs === 2000);
    expect(mid?.score ?? 0).toBeGreaterThanOrEqual(0.7);
  });

  it("never proposes cutting a sentence down to fewer than 2 content words", () => {
    const c = run([["嗯", 0, 200], ["好", 400, 600]]);
    expect(c.filter((x) => x.kind === "filler")).toHaveLength(0);
  });
});

describe("repeat rule", () => {
  it("lcs", () => {
    expect(lcsLen("我們今天要", "我們今天要來")).toBe(5);
    expect(lcsLen("", "x")).toBe(0);
  });

  it("stutter 我我我 keeps the last one", () => {
    const specs: Spec[] = [["我", 0, 150], ["我", 200, 350], ["我", 400, 550], ["覺得", 600, 900], ["這", 900, 1050], ["很", 1050, 1200], ["好", 1200, 1400]];
    const t = tr(specs);
    const c = run(specs);
    const s = c.find((x) => x.kind === "stutter");
    expect(s).toBeDefined();
    expect(texts([s!], t)).toEqual(["我我"]);
    expect(s!.score).toBeGreaterThanOrEqual(0.85);
  });

  it("whitelisted reduplication 謝謝 is not a stutter", () => {
    const c = run([["謝", 0, 150], ["謝", 150, 300], ["大家", 400, 700], ["收聽", 700, 1000]]);
    expect(kinds(c)).not.toContain("stutter");
  });

  it("restart: partial phrase then re-said", () => {
    const specs: Spec[] = [["我們", 0, 250], ["今天", 250, 500], ["要", 500, 650], ["呃", 900, 1050], ["我們", 1300, 1550], ["今天", 1550, 1800], ["要", 1800, 1950], ["來", 1950, 2100], ["聊", 2100, 2300], ["剪輯", 2300, 2600]];
    const t = tr(specs);
    const c = run(specs);
    const r = c.find((x) => x.kind === "restart");
    expect(r).toBeDefined();
    expect(texts([r!], t)[0]).toContain("我們今天要");
    expect(r!.endMs).toBe(1050);
  });
});

describe("pause rule", () => {
  it("shortens a 1.8 s pause between sentences to 350 ms and keeps 500 ms lead silence", () => {
    const c = run([["大家好。", 1500, 2000], ["今天", 3800, 4100], ["聊", 4100, 4300], ["剪輯", 4300, 4700]], 50, { durationMs: 6000, vad: [[1500, 2000], [3800, 4700]] });
    const pauses = c.filter((x) => x.kind === "long_pause");
    const lead = pauses.find((p) => p.startMs === 0);
    expect(lead?.endMs).toBe(1000);
    const mid = pauses.find((p) => p.startMs > 2000 && p.endMs < 3800);
    expect(mid).toBeDefined();
    expect(mid!.startMs).toBe(2175);
    expect(mid!.endMs).toBe(3625);
    const tail = pauses.find((p) => p.endMs === 6000);
    expect(tail?.startMs).toBe(5200);
  });

  it("pause with sound inside becomes noise, not long_pause", () => {
    const c = run([["大家好。", 0, 500], ["今天", 2500, 2800], ["聊", 2800, 3000], ["剪輯", 3000, 3300]], 50, { vad: [[0, 500], [900, 2200], [2500, 3300]] });
    expect(c.some((x) => x.kind === "noise" && x.startMs > 500 && x.endMs < 2500)).toBe(true);
    expect(c.some((x) => x.kind === "long_pause" && x.startMs > 500 && x.endMs < 2500)).toBe(false);
  });
});

describe("unclear rule", () => {
  it("flags runs of low-probability words", () => {
    const c = run([["這", 0, 150, 0.9], ["個", 150, 300, 0.9], ["東西", 300, 600, 0.2], ["是", 600, 750, 0.3], ["那樣", 750, 1000, 0.25], ["用", 1000, 1200, 0.9], ["的", 1200, 1350, 0.9]]);
    const u = c.find((x) => x.kind === "unclear");
    expect(u).toBeDefined();
    expect(u!.startMs).toBe(300);
    expect(u!.endMs).toBe(1000);
  });

  it("flags quiet words relative to the speaker median", () => {
    const specs: Spec[] = [["我們", 0, 400], ["今天", 400, 800], ["來聊", 800, 1200], ["這個", 1200, 1600], ["小聲", 1600, 2000], ["的話", 2000, 2400], ["好嗎", 2400, 2800]];
    const loud: LoudnessWindow[] = [];
    for (let t = 0; t < 3000; t += 100) {
      const quiet = t >= 1600 && t < 2400;
      loud.push({ tMs: t, momentary: quiet ? -40 : -18, shortTerm: -18, rmsDb: -20 });
    }
    const c = run(specs, 50, {}, loud);
    const u = c.find((x) => x.kind === "unclear" && x.reason.includes("音量"));
    expect(u).toBeDefined();
    expect(u!.startMs).toBe(1600);
  });
});

describe("dedupe", () => {
  it("keeps higher score for overlapping same-kind candidates", () => {
    const specs: Spec[] = [["嗯", 0, 200], ["嗯", 250, 450], ["今天", 700, 1000], ["我們", 1000, 1300], ["來", 1300, 1500]];
    const c = run(specs);
    const fillers = c.filter((x) => x.kind === "filler");
    const stutters = c.filter((x) => x.kind === "stutter");
    expect(fillers.length + stutters.length).toBeGreaterThanOrEqual(2);
    // 同類不重疊
    for (let i = 1; i < fillers.length; i++) expect(fillers[i].startMs).toBeGreaterThanOrEqual(fillers[i - 1].endMs);
  });
});
