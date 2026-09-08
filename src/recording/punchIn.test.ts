import { describe, expect, it } from "vitest";
import type { LocalAnalysis } from "../analysis/peaks";
import type { KeepSegment } from "../analysis/edl/build";
import { autoStopMs, fitDecision, planRedub, trimTake } from "./punchIn";
import { nextTakeIndex, takePath } from "./naming";
import { initialLevel, meterFraction, peakDb, pushLevel } from "./levels";

function fake(rmsDbs: number[]): LocalAnalysis {
  const n = rmsDbs.length;
  const rmsU8 = new Uint8Array(n);
  rmsDbs.forEach((db, i) => (rmsU8[i] = Math.round(((db + 60) / 60) * 255)));
  return { version: 3, pps: 200, hopMs: 100, sampleRate: 48000, nBuckets: n, nWin: 1, totalSamples: n * 240, durationMs: n * 5, mins: new Int8Array(n), maxs: new Int8Array(n), rmsU8, win: new Float32Array(3), zx: null };
}

describe("trimTake", () => {
  it("頭尾靜音修掉、各留 80 ms", () => {
    const a = fake([...Array(100).fill(-60), ...Array(200).fill(-20), ...Array(100).fill(-60)]);
    const t = trimTake(a);
    expect(t.startMs).toBe(500 - 80);
    expect(t.endMs).toBe(1500 + 80);
  });
  it("整段安靜 → 整段", () => {
    expect(trimTake(fake(Array(50).fill(-60)))).toEqual({ startMs: 0, endMs: 250 });
  });
});

describe("fitDecision", () => {
  it("邊界 0.69 / 0.7 / 1.3 / 1.31", () => {
    expect(fitDecision(690, 1000)).toBe("too_short");
    expect(fitDecision(700, 1000)).toBe("align");
    expect(fitDecision(1300, 1000)).toBe("align");
    expect(fitDecision(1310, 1000)).toBe("too_long");
    expect(fitDecision(0, 1000)).toBe("too_short");
  });
});

describe("planRedub", () => {
  const keeps: KeepSegment[] = [
    { id: 0, srcStartMs: 0, srcEndMs: 10_000, outStartMs: 0, outEndMs: 10_000, gainDb: 0 },
    { id: 1, srcStartMs: 15_000, srcEndMs: 25_000, outStartMs: 10_000, outEndMs: 20_000, gainDb: 0 },
  ];
  it("mute 原句 + overlay 落在成品對應位置，增益夾 ±12", () => {
    const p = planRedub({ slot: { startMs: 17_000, endMs: 19_000 }, takeMediaId: "take", takeRange: { startMs: 17_000, endMs: 19_000 }, keeps, gainDb: 20 });
    expect(p.effect).toMatchObject({ kind: "mute", startMs: 17_000, endMs: 19_000 });
    expect(p.overlay).toMatchObject({ lane: "sfx", role: "redub", mediaId: "take", srcInMs: 17_000, srcOutMs: 19_000, outStartMs: 12_000, gainDb: 12 });
  });
  it("硬停 = 2×槽 + 3 s（至少 5 s）", () => {
    expect(autoStopMs(1000)).toEqual({ hardStopMs: 5000, silenceMs: 1500 });
    expect(autoStopMs(4000).hardStopMs).toBe(11_000);
  });
});

describe("naming / levels", () => {
  it("take 編號從既有檔往上數（大小寫不分）", () => {
    expect(takePath("C:\\a\\ep.mp3", 2)).toBe("C:\\a\\ep_take2.wav");
    expect(nextTakeIndex("C:\\a\\ep.mp3", ["C:\\a\\EP_take1.wav", "C:\\a\\ep_take3.wav", "C:\\a\\other_take9.wav"])).toBe(4);
    expect(nextTakeIndex("C:\\a\\ep.mp3", [])).toBe(1);
  });
  it("峰值 / hold / 削波", () => {
    expect(peakDb(new Float32Array([0, 0.5, -0.25]))).toBeCloseTo(-6.02, 1);
    expect(peakDb(new Float32Array(10))).toBe(-120);
    let s = initialLevel();
    s = pushLevel(s, -6, 0);
    s = pushLevel(s, -20, 500);
    expect(s.holdDb).toBe(-6);
    s = pushLevel(s, -20, 2000);
    expect(s.holdDb).toBe(-20);
    expect(pushLevel(s, 0, 2100).clipped).toBe(true);
    expect(meterFraction(-60)).toBe(0);
    expect(meterFraction(-30)).toBeCloseTo(0.5, 6);
  });
});
