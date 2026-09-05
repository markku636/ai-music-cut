import { describe, expect, it } from "vitest";
import { edlOutDurationMs, effectiveXfFrames, effectiveXfMs, joinOverlapFrames, msToFrames, planOutFrames } from "./joins";

const F = msToFrames;

describe("effectiveXfFrames", () => {
  it("兩段都夠長 → 用規格值", () => {
    expect(effectiveXfFrames(20, F(1000), F(1000))).toBe(F(20));
  });

  it("兩段都要夾一半（只夾前一段是錯的）", () => {
    expect(effectiveXfFrames(20, 100, F(1000))).toBe(50);
    expect(effectiveXfFrames(20, F(1000), 100)).toBe(50);
    expect(effectiveXfFrames(20, 1, F(1000))).toBe(0);
  });

  it("跟 Rust 的 effective_xf_frames 對得上（同一組數字）", () => {
    // src-tauri/src/render.rs 的 effective_crossfade_is_clamped_by_both_sides
    expect(effectiveXfFrames(20, 4800, 4800)).toBe(F(20));
    expect(effectiveXfFrames(20, 100, 4800)).toBe(50);
    expect(effectiveXfFrames(20, 4800, 100)).toBe(50);
    expect(effectiveXfFrames(20, 1, 4800)).toBe(0);
  });

  it("毫秒版是 frame 版的換算，不是另一條公式", () => {
    expect(effectiveXfMs(20, 1000, 1000)).toBeCloseTo(20, 9);
    expect(effectiveXfMs(20, 2, 1000)).toBeCloseTo(1, 9);
  });
});

describe("planOutFrames", () => {
  it("crossfade 是重疊，要扣掉（對應 Rust 的 keeps_two_segments_and_crossfades_between）", () => {
    const segs = [
      { startMs: 0, endMs: 100 },
      { startMs: 200, endMs: 300 },
    ];
    expect(planOutFrames(segs, [{ kind: "crossfade", ms: 20 }])).toBe(F(100) + F(100) - F(20));
  });

  it("gap 是插入，要加上（對應 Rust 的 gap_join_inserts_room_tone）", () => {
    const segs = [
      { startMs: 0, endMs: 100 },
      { startMs: 200, endMs: 300 },
    ];
    expect(planOutFrames(segs, [{ kind: "gap", ms: 150 }])).toBe(F(100) + F(150) + F(100));
  });

  it("seam 不增不減（同一保留段內的響度單元邊界）", () => {
    const segs = [
      { startMs: 0, endMs: 5000 },
      { startMs: 5000, endMs: 9000 },
    ];
    expect(planOutFrames(segs, [{ kind: "seam", ms: 0 }])).toBe(F(9000));
  });

  it("響度單元切過的段總長等於原本的保留段（telescoping）", () => {
    const whole = [{ startMs: 1000, endMs: 20000 }];
    const split = [
      { startMs: 1000, endMs: 8123 },
      { startMs: 8123, endMs: 15456 },
      { startMs: 15456, endMs: 20000 },
    ];
    expect(planOutFrames(split, [
      { kind: "seam", ms: 0 },
      { kind: "seam", ms: 0 },
    ])).toBe(planOutFrames(whole, []));
  });

  it("很短的段不會被扣成負的", () => {
    const segs = [
      { startMs: 0, endMs: 3 },
      { startMs: 100, endMs: 103 },
    ];
    const n = planOutFrames(segs, [{ kind: "crossfade", ms: 500 }]);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBe(F(3) * 2 - Math.floor(F(3) / 2));
  });

  it("多刀的漂移會累積 —— 這正是舊公式的 bug", () => {
    const segs = Array.from({ length: 6 }, (_, i) => ({ startMs: i * 2000, endMs: i * 2000 + 1000 }));
    const joins = Array.from({ length: 5 }, () => ({ kind: "crossfade" as const, ms: 20 }));
    const naive = F(1000) * 6; // 舊版：只把保留段長度加起來
    expect(planOutFrames(segs, joins)).toBe(naive - 5 * F(20));
    // 5 刀 × 20 ms = 100 ms，遠超過 spliceAudit 的 LAG_OK_MS = 25
    expect(naive - planOutFrames(segs, joins)).toBe(F(100));
  });
});

describe("joinOverlapFrames", () => {
  it("只有 crossfade 有重疊", () => {
    const segs = [
      { startMs: 0, endMs: 1000 },
      { startMs: 2000, endMs: 3000 },
      { startMs: 4000, endMs: 5000 },
      { startMs: 6000, endMs: 7000 },
    ];
    expect(joinOverlapFrames(segs, [
      { kind: "crossfade", ms: 20 },
      { kind: "gap", ms: 150 },
      { kind: "seam", ms: 0 },
    ])).toEqual([F(20), 0, 0]);
  });
});

describe("edlOutDurationMs", () => {
  it("等於保留段總長扣掉重疊、加上 room tone", () => {
    const edl = {
      keeps: [
        { srcStartMs: 0, srcEndMs: 1000 },
        { srcStartMs: 1500, srcEndMs: 2500 },
        { srcStartMs: 3000, srcEndMs: 4000 },
      ],
      joins: [
        { kind: "crossfade", ms: 20 },
        { kind: "gap", ms: 150 },
      ],
    };
    expect(edlOutDurationMs(edl)).toBeCloseTo(3000 - 20 + 150, 6);
  });

  it("沒有保留段就是 0", () => {
    expect(edlOutDurationMs({ keeps: [], joins: [] })).toBe(0);
  });
});
