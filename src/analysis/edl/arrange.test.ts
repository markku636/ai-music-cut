import { describe, expect, it } from "vitest";
import { applyPastes, isRearranged, layoutOut, MIN_PASTE_MS, srcToOutArranged, type Paste } from "./arrange";
import { isRearrangedKeeps, mapSrcToOut } from "./map";
import type { KeepSegment } from "./build";

const MIN_KEEP = 80;

function keep(id: number, a: number, b: number): KeepSegment {
  return { id, srcStartMs: a, srcEndMs: b, outStartMs: 0, outEndMs: 0, gainDb: 0 };
}
function paste(id: string, a: number, b: number, at: number): Paste {
  return { id, srcStartMs: a, srcEndMs: b, atMs: at };
}
/** 只看順序與內容，方便斷言。 */
const shape = (ks: { srcStartMs: number; srcEndMs: number; pasteId?: string }[]) =>
  ks.map((k) => `${k.srcStartMs}-${k.srcEndMs}${k.pasteId ? `(${k.pasteId})` : ""}`);

describe("applyPastes", () => {
  it("沒有貼上時原封不動（整條路徑要跟以前一樣）", () => {
    const keeps = [keep(0, 0, 1000), keep(1, 2000, 3000)];
    const out = applyPastes(keeps, [], MIN_KEEP);
    expect(shape(out)).toEqual(["0-1000", "2000-3000"]);
    expect(isRearranged(out)).toBe(false);
  });

  it("貼在一段中間 → 那一段被切成兩半，中間夾進去", () => {
    const out = applyPastes([keep(0, 0, 1000)], [paste("p1", 5000, 5500, 400)], MIN_KEEP);
    expect(shape(out)).toEqual(["0-400", "5000-5500(p1)", "400-1000"]);
  });

  it("貼在剪除區裡 → 插在下一段前面", () => {
    const keeps = [keep(0, 0, 1000), keep(1, 2000, 3000)];
    const out = applyPastes(keeps, [paste("p1", 5000, 5500, 1500)], MIN_KEEP);
    expect(shape(out)).toEqual(["0-1000", "5000-5500(p1)", "2000-3000"]);
  });

  it("貼在最前面", () => {
    const out = applyPastes([keep(0, 1000, 2000)], [paste("p1", 5000, 5500, 0)], MIN_KEEP);
    expect(shape(out)).toEqual(["5000-5500(p1)", "1000-2000"]);
  });

  it("貼在最後面", () => {
    const out = applyPastes([keep(0, 0, 1000)], [paste("p1", 5000, 5500, 9999)], MIN_KEEP);
    expect(shape(out)).toEqual(["0-1000", "5000-5500(p1)"]);
  });

  it("切開之後半邊太短就不切，整塊貼在旁邊", () => {
    // 左半只有 30 ms（< 80）
    const left = applyPastes([keep(0, 0, 1000)], [paste("p1", 5000, 5500, 30)], MIN_KEEP);
    expect(shape(left)).toEqual(["5000-5500(p1)", "0-1000"]);
    // 右半只有 20 ms
    const right = applyPastes([keep(0, 0, 1000)], [paste("p1", 5000, 5500, 980)], MIN_KEEP);
    expect(shape(right)).toEqual(["0-1000", "5000-5500(p1)"]);
  });

  it("太短的貼上直接忽略（手滑貼進 3 毫秒的東西）", () => {
    const out = applyPastes([keep(0, 0, 1000)], [paste("p1", 5000, 5000 + MIN_PASTE_MS - 1, 400)], MIN_KEEP);
    expect(shape(out)).toEqual(["0-1000"]);
  });

  it("兩塊貼在不同位置，各自就位", () => {
    const keeps = [keep(0, 0, 1000), keep(1, 2000, 3000)];
    const out = applyPastes(keeps, [paste("p2", 8000, 8500, 2500), paste("p1", 5000, 5500, 500)], MIN_KEEP);
    expect(shape(out)).toEqual(["0-500", "5000-5500(p1)", "500-1000", "2000-2500", "8000-8500(p2)", "2500-3000"]);
  });

  it("第二塊不會被插進第一塊裡面", () => {
    const out = applyPastes([keep(0, 0, 1000)], [paste("p1", 5000, 6000, 400), paste("p2", 7000, 7500, 400)], MIN_KEEP);
    // 兩塊都貼在同一個來源位置：先來的在前，第二塊不會切開第一塊
    expect(out.filter((k) => k.pasteId).map((k) => k.pasteId)).toEqual(["p1", "p2"]);
    expect(shape(out).join("|")).not.toContain("5000-5400");
  });

  it("id 重新編號，成品順序連續", () => {
    const out = applyPastes([keep(0, 0, 1000)], [paste("p1", 5000, 5500, 400)], MIN_KEEP);
    expect(out.map((k) => k.id)).toEqual([0, 1, 2]);
  });

  it("複製貼上：同一段來源出現兩次", () => {
    const out = applyPastes([keep(0, 0, 1000)], [paste("p1", 200, 400, 800)], MIN_KEEP);
    expect(shape(out)).toEqual(["0-800", "200-400(p1)", "800-1000"]);
    expect(isRearranged(out)).toBe(true);
  });
});

describe("layoutOut", () => {
  it("成品時間照順序累加，跟來源順序無關", () => {
    const arranged = applyPastes([keep(0, 0, 1000)], [paste("p1", 5000, 5500, 400)], MIN_KEEP);
    const laid = layoutOut(arranged);
    expect(laid.map((k) => [k.outStartMs, k.outEndMs])).toEqual([
      [0, 400],
      [400, 900],
      [900, 1500],
    ]);
  });

  it("總長 = 各段長度總和", () => {
    const laid = layoutOut(applyPastes([keep(0, 0, 1000), keep(1, 2000, 2500)], [paste("p1", 5000, 5500, 400)], MIN_KEEP));
    const total = laid[laid.length - 1].outEndMs;
    expect(total).toBe(1000 + 500 + 500);
  });
});

describe("srcToOutArranged", () => {
  const laid = layoutOut(applyPastes([keep(0, 0, 1000), keep(1, 2000, 3000)], [paste("p1", 2400, 2600, 400)], MIN_KEEP));
  // 排列：0-400 | 2400-2600(p1) | 400-1000 | 2000-3000
  // 成品：0-400 | 400-600      | 600-1200  | 1200-2200

  it("落在原本就在那裡的段落", () => {
    expect(srcToOutArranged(laid, 0)).toBe(0);
    expect(srcToOutArranged(laid, 200)).toBe(200);
    expect(srcToOutArranged(laid, 500)).toBe(700); // 600 + (500-400)
  });

  it("一段來源出現兩次時，回**成品裡最早**的那一次", () => {
    // 2500 同時落在貼上的 2400-2600（成品 400-600）與原本的 2000-3000（成品 1200-2200）
    expect(srcToOutArranged(laid, 2500)).toBe(500); // 400 + (2500-2400)
  });

  it("落在剪除區時靠到來源時間上最近的鄰居", () => {
    expect(srcToOutArranged(laid, 1500, "next")).toBe(1200); // 靠 2000-3000 的開頭
    expect(srcToOutArranged(laid, 1500, "prev")).toBe(1200); // 靠 400-1000 的結尾（成品 1200）
  });

  it("超出範圍夾在頭尾", () => {
    expect(srcToOutArranged(laid, -100)).toBe(0);
    expect(srcToOutArranged(laid, 99999)).toBe(2200);
  });

  it("空的 keeps 不會爆", () => {
    expect(srcToOutArranged([], 500)).toBe(0);
  });

  it("沒有貼上時，行為跟原本的順序查表一致", () => {
    const plain = layoutOut(applyPastes([keep(0, 0, 1000), keep(1, 2000, 3000)], [], MIN_KEEP));
    expect(srcToOutArranged(plain, 0)).toBe(0);
    expect(srcToOutArranged(plain, 999)).toBe(999);
    expect(srcToOutArranged(plain, 2000)).toBe(1000);
    expect(srcToOutArranged(plain, 2500)).toBe(1500);
  });
});

describe("mapSrcToOut 會自己認出重排（字幕 / 章節 / 節目筆記全靠它）", () => {
  it("沒有重排時走原本的路徑，結果一模一樣", () => {
    const plain = layoutOut(applyPastes([keep(0, 0, 1000), keep(1, 2000, 3000)], [], MIN_KEEP));
    expect(isRearrangedKeeps(plain)).toBe(false);
    for (const t of [0, 500, 999, 1500, 2000, 2500, 3000]) {
      expect(mapSrcToOut(plain, t)).toBe(srcToOutArranged(plain, t));
    }
  });

  it("有重排時**不會**再用「回第一個命中」那條捷徑", () => {
    const laid = layoutOut(applyPastes([keep(0, 0, 1000), keep(1, 2000, 3000)], [paste("p1", 2400, 2600, 400)], MIN_KEEP));
    expect(isRearrangedKeeps(laid)).toBe(true);
    // 2500 同時落在貼上的那一塊與原本的段落；要回成品裡最早的那一次（500），
    // 而不是依來源順序掃到的 2000-3000（1200 起）
    expect(mapSrcToOut(laid, 2500)).toBe(500);
  });

  it("搬移之後，字幕的時間會落在搬過去的位置", () => {
    // 把 2000-3000 剪掉、貼到 400 —— 這就是「搬移」
    const moved = layoutOut(applyPastes([keep(0, 0, 1000)], [paste("m1", 2000, 3000, 400)], MIN_KEEP));
    // 排列：0-400 | 2000-3000(m1) | 400-1000
    expect(mapSrcToOut(moved, 2500)).toBe(900); // 400 + (2500-2000)
    expect(mapSrcToOut(moved, 500)).toBe(1500); // 1400 + (500-400)
  });
});
