import { describe, expect, it } from "vitest";
import { DEFAULT_SKIM, IDLE_SKIM, nextGrain, type SkimState } from "./skim";

const DUR = 60_000;

describe("nextGrain", () => {
  it("第一次移到某個位置就會播", () => {
    const r = nextGrain(IDLE_SKIM, 5000, 1000, DUR);
    expect(r).not.toBeNull();
    expect(r!.grain.startMs).toBe(5000);
    expect(r!.grain.endMs).toBe(5000 + DEFAULT_SKIM.grainMs);
  });

  it("太快就不重播 —— 每次 pointermove 都播會變成連續爆音", () => {
    const first = nextGrain(IDLE_SKIM, 5000, 1000, DUR)!;
    // 移動夠遠，但只過了 10 ms
    expect(nextGrain(first.state, 9000, 1010, DUR)).toBeNull();
    // 等滿間隔就會播
    expect(nextGrain(first.state, 9000, 1000 + DEFAULT_SKIM.minIntervalMs, DUR)).not.toBeNull();
  });

  it("游標停著不動就安靜 —— 只用時間節流會變成壞掉的唱片", () => {
    const first = nextGrain(IDLE_SKIM, 5000, 1000, DUR)!;
    // 過了很久，但位置完全沒變
    expect(nextGrain(first.state, 5000, 99_000, DUR)).toBeNull();
    // 手的微抖動也不該觸發
    expect(nextGrain(first.state, 5000 + DEFAULT_SKIM.minMoveMs - 1, 99_000, DUR)).toBeNull();
    expect(nextGrain(first.state, 5000 + DEFAULT_SKIM.minMoveMs, 99_000, DUR)).not.toBeNull();
  });

  it("兩個條件要同時成立", () => {
    const s: SkimState = { lastMs: 5000, lastAt: 1000 };
    expect(nextGrain(s, 5010, 5000, DUR)).toBeNull(); // 等夠久、沒移動
    expect(nextGrain(s, 20_000, 1005, DUR)).toBeNull(); // 移動夠遠、太快
    expect(nextGrain(s, 20_000, 5000, DUR)).not.toBeNull(); // 兩個都成立
  });

  it("往回滑也算移動（絕對值）", () => {
    const s: SkimState = { lastMs: 20_000, lastAt: 1000 };
    const r = nextGrain(s, 10_000, 5000, DUR);
    expect(r).not.toBeNull();
    expect(r!.grain.startMs).toBe(10_000);
  });

  it("grain 不會超出檔案結尾", () => {
    const r = nextGrain(IDLE_SKIM, DUR - 50, 1000, DUR)!;
    expect(r.grain.endMs).toBe(DUR);
    expect(r.grain.startMs).toBeLessThan(r.grain.endMs);
  });

  it("游標滑出結尾就夾在結尾", () => {
    const r = nextGrain(IDLE_SKIM, DUR + 5000, 1000, DUR)!;
    expect(r.grain.startMs).toBe(DUR);
  });

  it("無效輸入回 null 而不是丟例外", () => {
    expect(nextGrain(IDLE_SKIM, -1, 1000, DUR)).toBeNull();
    expect(nextGrain(IDLE_SKIM, Number.NaN, 1000, DUR)).toBeNull();
    expect(nextGrain(IDLE_SKIM, 100, 1000, 0)).toBeNull();
  });

  it("回傳的 state 可以直接餵回去（連續掃過一整條時間軸）", () => {
    let st = IDLE_SKIM;
    let played = 0;
    // 模擬 1 秒內 60 幀、游標等速掃過 6 秒
    for (let f = 0; f < 60; f++) {
      const r = nextGrain(st, f * 100, f * 16.7, DUR);
      if (r) {
        played++;
        st = r.state;
      }
    }
    // 60 幀不該播 60 次；90 ms 間隔下大約 10 次上下
    expect(played).toBeGreaterThan(4);
    expect(played).toBeLessThan(20);
  });
});
