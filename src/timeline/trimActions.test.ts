// 剪輯動作層（刀片 / 提起 / 接縫）的行為契約。
//
// 這一層是快捷鍵、右鍵選單、修剪把手與 MCP 工具**共用**的語意來源，而它一直沒有測試。
// 特別要釘住的是刀片的冪等性：原始碼註解記著一次真實事故 —— agent 連續呼叫兩次，
// toggle 把自己剛切的那一刀砍掉，回傳值看起來還像成功。那種行為只有測試擋得住。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Edl } from "../analysis/edl/build";

vi.mock("../pipeline/rules", () => ({ edlFor: () => currentTestEdl }));

const { seamsOfEdl, bladeAt, liftSelection } = await import("./trimActions");
const { useDecisions } = await import("../store/decisions");
const { useProject } = await import("../store/project");
const { useTimeline } = await import("../store/timeline");
const { useTranscript } = await import("../store/transcript");

let currentTestEdl: Edl | null = null;

function keep(id: number, srcStartMs: number, srcEndMs: number, outStartMs: number): Edl["keeps"][number] {
  return { id, srcStartMs, srcEndMs, outStartMs, outEndMs: outStartMs + (srcEndMs - srcStartMs), gainDb: 0 };
}

function edlOf(keeps: Edl["keeps"], joins: Edl["joins"]): Edl {
  const outMs = keeps.length ? keeps[keeps.length - 1].outEndMs : 0;
  return { keeps, joins, stats: { srcMs: 0, outMs, keptMs: outMs, removedMs: 0, ratio: 0 } } as unknown as Edl;
}

const MEDIA = "m1";

beforeEach(() => {
  currentTestEdl = null;
  useProject.setState({ activeMediaId: MEDIA, media: [{ id: MEDIA, name: "a.wav", path: "/a.wav", probe: { duration_ms: 60_000 } }] as never });
  useTranscript.setState({ byMedia: {}, local: {} } as never);
  useDecisions.setState({ candidates: {}, decisions: {}, effects: {}, splits: {}, markers: {}, overlays: {}, speakers: {}, past: [], future: [], selectedIds: [] });
  useTimeline.setState({ selection: null });
});

describe("seamsOfEdl", () => {
  it("兩段之間就是一個接縫，帶著前後的來源時間", () => {
    const edl = edlOf(
      [keep(0, 0, 1000, 0), keep(1, 2000, 3000, 1000)],
      [{ afterKeepId: 0, kind: "crossfade", ms: 24 }] as never,
    );
    const seams = seamsOfEdl(edl);
    expect(seams).toHaveLength(1);
    expect(seams[0]).toMatchObject({ afterKeepId: 0, srcBeforeMs: 1000, srcAfterMs: 2000, kind: "crossfade", gapMs: 0 });
  });

  it("gap 接縫帶出留白長度（其他種類是 0）", () => {
    const edl = edlOf(
      [keep(0, 0, 1000, 0), keep(1, 1000, 2000, 1500)],
      [{ afterKeepId: 0, kind: "gap", ms: 500 }] as never,
    );
    expect(seamsOfEdl(edl)[0]).toMatchObject({ kind: "gap", gapMs: 500 });
  });

  it("刀片切出來的接縫帶著 splitId（右鍵才知道能不能移除這一刀）", () => {
    const edl = edlOf(
      [keep(0, 0, 1000, 0), keep(1, 1000, 2000, 1000)],
      [{ afterKeepId: 0, kind: "seam", ms: 0, splitId: "sp1" }] as never,
    );
    expect(seamsOfEdl(edl)[0].splitId).toBe("sp1");
  });

  it("只有一段就沒有接縫；沒有 EDL 回空陣列", () => {
    expect(seamsOfEdl(edlOf([keep(0, 0, 1000, 0)], [] as never))).toEqual([]);
    expect(seamsOfEdl(null)).toEqual([]);
  });

  it("找不到對應的 join 時退回 crossfade（不要因為缺一筆就整份壞掉）", () => {
    const edl = edlOf([keep(0, 0, 1000, 0), keep(1, 2000, 3000, 1000)], [] as never);
    expect(seamsOfEdl(edl)[0].kind).toBe("crossfade");
  });
});

describe("bladeAt", () => {
  beforeEach(() => {
    currentTestEdl = edlOf([keep(0, 0, 30_000, 0)], [] as never);
  });

  it("切一刀之後那裡有切點", () => {
    expect(bladeAt(10_000)).toBe(true);
    expect(useDecisions.getState().splits[MEDIA]).toHaveLength(1);
  });

  it("**再呼叫一次不會把自己剛切的那一刀砍掉**（agent 重試是常態）", () => {
    bladeAt(10_000);
    expect(bladeAt(10_000)).toBe(true);
    expect(useDecisions.getState().splits[MEDIA], "第二次呼叫不該移除切點").toHaveLength(1);
  });

  it("鍵盤的 B 才是 toggle（按兩次＝反悔）", () => {
    bladeAt(10_000, { toggle: true });
    expect(bladeAt(10_000, { toggle: true })).toBe(false);
    expect(useDecisions.getState().splits[MEDIA] ?? []).toHaveLength(0);
  });

  it("附近 20ms 內算同一刀（不要因為差幾毫秒就切出兩刀）", () => {
    bladeAt(10_000);
    bladeAt(10_015);
    expect(useDecisions.getState().splits[MEDIA]).toHaveLength(1);
  });

  it("切在會產生過短碎片的位置回 null（不動任何東西）", () => {
    // 保留段只有 0–30000，切在 10ms 會留下一個 10ms 的碎片
    expect(bladeAt(10)).toBeNull();
    expect(useDecisions.getState().splits[MEDIA] ?? []).toHaveLength(0);
  });

  it("沒有開啟的媒體時回 null 而不是丟例外", () => {
    useProject.setState({ activeMediaId: null } as never);
    expect(bladeAt(10_000)).toBeNull();
  });
});

describe("liftSelection", () => {
  it("把選取變成靜音效果，而且**不關洞**（時間感不變）", () => {
    useTimeline.setState({ selection: { startMs: 5000, endMs: 6000 } });
    const id = liftSelection();
    expect(id).toBeTruthy();
    const fx = useDecisions.getState().effects[MEDIA] ?? [];
    expect(fx).toHaveLength(1);
    expect(fx[0]).toMatchObject({ kind: "mute", startMs: 5000, endMs: 6000 });
    // 提起不會產生剪除候選 —— 那才是「關洞」
    expect(useDecisions.getState().candidates[MEDIA] ?? []).toHaveLength(0);
  });

  it("提起之後清掉選取（不然下一個動作會不小心套在同一段上）", () => {
    useTimeline.setState({ selection: { startMs: 5000, endMs: 6000 } });
    liftSelection();
    expect(useTimeline.getState().selection).toBeNull();
  });

  it("沒有選取時回 null", () => {
    useTimeline.setState({ selection: null });
    expect(liftSelection()).toBeNull();
  });
});
