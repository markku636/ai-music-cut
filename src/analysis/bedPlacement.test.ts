import { describe, expect, it } from "vitest";
import { placeBed } from "./bedPlacement";

describe("placeBed", () => {
  it("片頭從 0 開始", () => {
    const p = placeBed("intro", 20_000, 180_000);
    expect(p.outStartMs).toBe(0);
    expect(p.outEndMs).toBe(20_000);
    expect(p.extendsOutputMs).toBe(0);
    expect(p.longerThanEpisode).toBe(false);
  });

  it("片尾收在節目結束的那一刻", () => {
    const p = placeBed("outro", 20_000, 180_000);
    expect(p.outStartMs).toBe(160_000);
    expect(p.outEndMs).toBe(180_000);
    expect(p.extendsOutputMs).toBe(0);
    expect(p.coverage).toBeCloseTo(20_000 / 180_000, 6);
  });

  it("音樂比節目長：片尾會被夾到 0，變成一整集的墊樂 —— 這件事要講出來", () => {
    // 30 秒的試剪配 3 分鐘的歌，第一次用的人很容易這樣做
    const p = placeBed("outro", 180_000, 30_000);
    expect(p.longerThanEpisode).toBe(true);
    expect(p.outStartMs).toBe(0);
    expect(p.coverage).toBe(1);
    // 成品會被音樂拉長 2.5 分鐘
    expect(p.extendsOutputMs).toBe(150_000);
  });

  it("片頭比節目長也一樣會蓋滿，而且會把成品拉長", () => {
    const p = placeBed("intro", 180_000, 30_000);
    expect(p.longerThanEpisode).toBe(true);
    expect(p.coverage).toBe(1);
    expect(p.extendsOutputMs).toBe(150_000);
  });

  it("剛好一樣長不算「比較長」", () => {
    const p = placeBed("outro", 30_000, 30_000);
    expect(p.longerThanEpisode).toBe(false);
    expect(p.outStartMs).toBe(0);
    expect(p.extendsOutputMs).toBe(0);
  });

  it("節目長度是 0（還沒探測）時不要除以 0", () => {
    const p = placeBed("outro", 20_000, 0);
    expect(p.coverage).toBe(0);
    expect(p.longerThanEpisode).toBe(false);
    expect(Number.isFinite(p.extendsOutputMs)).toBe(true);
  });

  it("負數 / 亂數不會做出負的區間", () => {
    const p = placeBed("outro", -5, -5);
    expect(p.outStartMs).toBeGreaterThanOrEqual(0);
    expect(p.outEndMs).toBeGreaterThanOrEqual(p.outStartMs);
  });
});
