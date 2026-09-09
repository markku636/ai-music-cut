import { describe, expect, it } from "vitest";
import { cutSpansOf, msFromX, overviewBars, scrollTargetMs, spansToRects, viewportOf, xFromMs } from "./overview";

describe("overviewBars", () => {
  it("壓成指定根數", () => {
    expect(overviewBars(new Uint8Array(1000), 200)).toHaveLength(200);
  });

  it("每根取區間最大值，不是平均", () => {
    // 平均會把這個爆音抹平；總覽要看的是「哪裡有聲音」
    const src = new Uint8Array(100);
    src[50] = 255;
    const bars = overviewBars(src, 10);
    expect(bars[5]).toBe(255);
    expect(bars.filter((b) => b > 0)).toHaveLength(1);
  });

  it("來源比目標短時每根都對得到（不會有空洞）", () => {
    const bars = overviewBars([10, 20, 30], 9);
    expect([...bars]).toEqual([10, 10, 10, 20, 20, 20, 30, 30, 30]);
  });

  it("空輸入回全零而不是炸掉", () => {
    expect([...overviewBars(new Uint8Array(0), 4)]).toEqual([0, 0, 0, 0]);
  });

  it("寬度 0 或負數退回 1 根", () => {
    expect(overviewBars([1, 2], 0)).toHaveLength(1);
    expect(overviewBars([1, 2], -5)).toHaveLength(1);
  });
});

describe("座標換算", () => {
  it("x 與 ms 互為反函數", () => {
    for (const ms of [0, 1234, 500_000, 3_420_000]) {
      expect(msFromX(xFromMs(ms, 800, 3_420_000), 800, 3_420_000)).toBeCloseTo(ms, -1);
    }
  });

  it("超出範圍會被夾住", () => {
    expect(msFromX(-50, 800, 100_000)).toBe(0);
    expect(msFromX(9999, 800, 100_000)).toBe(100_000);
    expect(xFromMs(-1, 800, 100_000)).toBe(0);
    expect(xFromMs(999_999, 800, 100_000)).toBe(800);
  });

  it("時長 0 不會除以零", () => {
    expect(xFromMs(1000, 800, 0)).toBe(0);
    expect(msFromX(400, 0, 100_000)).toBe(0);
  });
});

describe("viewportOf", () => {
  const base = { durationMs: 3_420_000, stripWidth: 800, viewWidthPx: 1000 };

  it("整段適配時標成 full", () => {
    // 1000px 顯示 3420 秒 → 每秒 0.292px
    const v = viewportOf({ ...base, viewStartMs: 0, pxPerSec: 1000 / 3420 });
    expect(v.full).toBe(true);
    expect(v.w).toBeCloseTo(800, 0);
  });

  it("放大後視窗只佔一小塊", () => {
    const v = viewportOf({ ...base, viewStartMs: 600_000, pxPerSec: 50 });
    expect(v.full).toBe(false);
    expect(v.endMs - v.startMs).toBeCloseTo(20_000, -2); // 1000px / 50px每秒 = 20 秒
    expect(v.x).toBeCloseTo((600_000 / 3_420_000) * 800, 1);
  });

  it("視窗再小也畫得出來（至少 2px）", () => {
    const v = viewportOf({ ...base, viewStartMs: 0, pxPerSec: 5000 });
    expect(v.w).toBeGreaterThanOrEqual(2);
  });

  it("起點超過可捲範圍會被夾回去", () => {
    const v = viewportOf({ ...base, viewStartMs: 99_999_999, pxPerSec: 50 });
    expect(v.endMs).toBeCloseTo(3_420_000, -2);
    expect(v.startMs).toBeCloseTo(3_400_000, -2);
  });

  it("負的起點夾成 0", () => {
    expect(viewportOf({ ...base, viewStartMs: -5000, pxPerSec: 50 }).startMs).toBe(0);
  });
});

describe("scrollTargetMs", () => {
  const base = { stripWidth: 800, durationMs: 3_420_000, viewWidthPx: 1000, pxPerSec: 50 };

  it("點到的位置會落在視窗正中間", () => {
    const target = scrollTargetMs({ ...base, x: 400 }); // 正中間 = 1710 秒
    expect(target).toBeCloseTo(1_710_000 - 10_000, -2);
  });

  it("點最前面不會捲成負的", () => {
    expect(scrollTargetMs({ ...base, x: 0 })).toBe(0);
  });

  it("點最後面不會捲出結尾", () => {
    const target = scrollTargetMs({ ...base, x: 800 });
    expect(target).toBeCloseTo(3_420_000 - 20_000, -2);
  });
});

describe("spansToRects", () => {
  it("極短的剪除區間也畫得出來（至少 1px）", () => {
    // 57 分鐘裡的 200ms 贅字換算不到 0.1px，沒有下限整條會是空的
    const rects = spansToRects([{ startMs: 100_000, endMs: 100_200 }], 800, 3_420_000);
    expect(rects[0].w).toBeGreaterThanOrEqual(1);
  });

  it("跳過長度不正的區間", () => {
    expect(spansToRects([{ startMs: 500, endMs: 500 }, { startMs: 900, endMs: 100 }], 800, 100_000)).toEqual([]);
  });

  it("時長 0 回空陣列", () => {
    expect(spansToRects([{ startMs: 0, endMs: 100 }], 800, 0)).toEqual([]);
  });
});

describe("cutSpansOf", () => {
  it("一般剪輯：保留段之間的空隙就是剪掉的", () => {
    expect(cutSpansOf([{ srcStartMs: 0, srcEndMs: 1000 }, { srcStartMs: 2000, srcEndMs: 3000 }], 4000)).toEqual([
      { startMs: 1000, endMs: 2000 },
      { startMs: 3000, endMs: 4000 },
    ]);
  });

  it("搬移：搬到後面的那一段還在成品裡，不能被畫成剪掉", () => {
    // 成品順序＝來源 10–14 秒在前、0–4 秒在後
    const keeps = [{ srcStartMs: 10_000, srcEndMs: 14_000 }, { srcStartMs: 0, srcEndMs: 4000 }];
    // 舊寫法（照陣列順序推游標）會回 [0,10000]，把使用者剛搬走的那 4 秒也算進去
    expect(cutSpansOf(keeps, 20_000)).toEqual([
      { startMs: 4000, endMs: 10_000 },
      { startMs: 14_000, endMs: 20_000 },
    ]);
  });

  it("貼上：同一段來源出現兩次只算一次（問的是素材還在不在）", () => {
    const keeps = [{ srcStartMs: 0, srcEndMs: 4000 }, { srcStartMs: 1000, srcEndMs: 3000 }];
    expect(cutSpansOf(keeps, 6000)).toEqual([{ startMs: 4000, endMs: 6000 }]);
  });

  it("完整保留就沒有剪掉的地方", () => {
    expect(cutSpansOf([{ srcStartMs: 0, srcEndMs: 5000 }], 5000)).toEqual([]);
  });

  it("空的 / 長度 0 不會爆", () => {
    expect(cutSpansOf([], 0)).toEqual([]);
    expect(cutSpansOf([], 1000)).toEqual([{ startMs: 0, endMs: 1000 }]);
  });

  it("超出檔案長度的保留段會被夾住（貼上可以拉到檔尾之外）", () => {
    expect(cutSpansOf([{ srcStartMs: 0, srcEndMs: 9999 }], 3000)).toEqual([]);
  });
});
