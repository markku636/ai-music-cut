import { describe, expect, it } from "vitest";
import { clipOverlays, clipPath, clipUnits } from "./clip";

describe("clipUnits", () => {
  const units = [
    { id: 0, startMs: 0, endMs: 1000 },
    { id: 1, startMs: 1000, endMs: 2000 },
    { id: 2, startMs: 3000, endMs: 4000 },
  ];

  it("頭尾被切、中間原樣留著", () => {
    expect(clipUnits(units, { startMs: 500, endMs: 3500 })).toEqual([
      { id: 0, startMs: 500, endMs: 1000 },
      { id: 1, startMs: 1000, endMs: 2000 },
      { id: 2, startMs: 3000, endMs: 3500 },
    ]);
  });

  it("完全在範圍外的單元被丟掉", () => {
    expect(clipUnits(units, { startMs: 3000, endMs: 4000 })).toEqual([{ id: 2, startMs: 3000, endMs: 4000 }]);
  });

  it("只碰到邊界（長度 0）不算", () => {
    expect(clipUnits(units, { startMs: 2000, endMs: 3000 })).toEqual([]);
  });

  it("範圍涵蓋全部就等於沒夾", () => {
    expect(clipUnits(units, { startMs: 0, endMs: 99999 })).toEqual(units);
  });
});

describe("clipOverlays", () => {
  const ov = [{ outStartMs: 5000, srcInMs: 0, srcOutMs: 10000 }];

  it("換算到這一段的時間軸", () => {
    // 選取起點在成品的 3 秒 → 配樂從這一段的 2 秒開始
    expect(clipOverlays(ov, 3000, 20000)).toEqual([{ outStartMs: 2000, srcInMs: 0, srcOutMs: 10000 }]);
  });

  it("前面被切掉時來源進點跟著移（音樂不會從頭重播）", () => {
    // 選取起點在成品 7 秒：配樂已經播了 2 秒
    expect(clipOverlays(ov, 7000, 20000)).toEqual([{ outStartMs: 0, srcInMs: 2000, srcOutMs: 10000 }]);
  });

  it("後面超出這一段時尾巴被切", () => {
    // 這一段只有 4 秒，配樂從第 2 秒開始 → 只剩 2 秒
    expect(clipOverlays(ov, 3000, 4000)).toEqual([{ outStartMs: 2000, srcInMs: 0, srcOutMs: 2000 }]);
  });

  it("完全在範圍外就丟掉", () => {
    expect(clipOverlays(ov, 20000, 5000)).toEqual([]);
    expect(clipOverlays(ov, 0, 3000)).toEqual([]);
  });

  it("零長度的片段不會混進來", () => {
    expect(clipOverlays([{ outStartMs: 0, srcInMs: 100, srcOutMs: 100 }], 0, 10000)).toEqual([]);
  });
});

describe("clipPath", () => {
  it("在副檔名前加後綴", () => {
    expect(clipPath("D:/a/ep12_cut.mp3")).toBe("D:/a/ep12_cut_clip.mp3");
  });
  it("沒有副檔名就接在後面", () => {
    expect(clipPath("D:/a/ep12")).toBe("D:/a/ep12_clip");
  });
  it("路徑裡有點也不會切錯", () => {
    expect(clipPath("D:/my.podcast/ep12.mp3")).toBe("D:/my.podcast/ep12_clip.mp3");
  });
});
