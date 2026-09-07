import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Candidate } from "../analysis/types";
import { candidateId } from "../analysis/types";

vi.mock("./project", () => ({ useProject: { getState: () => ({ markDirty: () => {} }) } }));

const { useDecisions, defaultStateFor } = await import("./decisions");

function c(kind: Candidate["kind"], s: number, e: number, score: number, source: Candidate["source"] = "rule"): Candidate {
  return { id: candidateId(kind, s, e, source), kind, startMs: s, endMs: e, wordIds: [], reason: "r", score, source, sentenceId: 0 };
}

describe("decisions store", () => {
  beforeEach(() => useDecisions.setState({ candidates: {}, decisions: {}, overlays: {}, speakers: {}, past: [], future: [], selectedIds: [] }));

  it("default states: suggest-only kinds are pending, high-score fillers auto", () => {
    expect(defaultStateFor(c("filler", 0, 100, 0.9), 50)).toBe("auto");
    expect(defaultStateFor(c("filler", 0, 100, 0.5), 50)).toBe("pending");
    expect(defaultStateFor(c("unclear", 0, 100, 0.99), 100)).toBe("pending");
    expect(defaultStateFor(c("manual", 0, 100, 1, "user"), 0)).toBe("accepted");
  });

  it("setCandidates preserves user decisions across re-runs and records undo", () => {
    const a = c("filler", 0, 100, 0.9);
    const b = c("filler", 200, 300, 0.9);
    const st = useDecisions.getState();
    st.setCandidates("m", [a, b], { label: "rules", aggressiveness: 50 });
    expect(useDecisions.getState().decisions.m[a.id].state).toBe("auto");
    st.decide("m", [a.id], "rejected");
    st.setCandidates("m", [a, b], { label: "rules again", aggressiveness: 50 });
    expect(useDecisions.getState().decisions.m[a.id]).toMatchObject({ state: "rejected", origin: "user" });
    expect(useDecisions.getState().past).toHaveLength(3);
    st.undo();
    st.undo();
    expect(useDecisions.getState().decisions.m[a.id].state).toBe("auto");
    st.redo();
    expect(useDecisions.getState().decisions.m[a.id].state).toBe("rejected");
  });

  it("toggleWordCut flips covering candidates or creates a manual cut", () => {
    const a = { ...c("filler", 0, 100, 0.9), wordIds: [3] };
    const st = useDecisions.getState();
    st.setCandidates("m", [a], { label: "rules", aggressiveness: 50 });
    st.toggleWordCut("m", 3, { startMs: 0, endMs: 100, text: "嗯" }, 0);
    expect(useDecisions.getState().decisions.m[a.id].state).toBe("rejected");
    st.toggleWordCut("m", 9, { startMs: 500, endMs: 600, text: "的" }, 0);
    const manual = useDecisions.getState().candidates.m.find((x) => x.kind === "manual");
    expect(manual).toBeDefined();
    expect(useDecisions.getState().decisions.m[manual!.id].state).toBe("accepted");
    // 規則重跑後手動候選仍在
    st.setCandidates("m", [a], { label: "rules", aggressiveness: 50 });
    expect(useDecisions.getState().candidates.m.some((x) => x.kind === "manual")).toBe(true);
  });

  it("applyJudge never overrides user decisions and adds new suggestions as pending", () => {
    const a = c("filler", 0, 100, 0.9);
    const st = useDecisions.getState();
    st.setCandidates("m", [a], { label: "rules", aggressiveness: 50 });
    st.decide("m", [a.id], "accepted");
    const nu = c("rambling", 1000, 3000, 0.5, "llm");
    st.applyJudge("m", [{ id: a.id, state: "rejected", reason: "llm says keep" }], [nu], 50);
    expect(useDecisions.getState().decisions.m[a.id].state).toBe("accepted");
    expect(useDecisions.getState().decisions.m[nu.id]).toMatchObject({ state: "pending", origin: "llm" });
  });

  it("bulk applies predicate", () => {
    const a = c("filler", 0, 100, 0.9);
    const b = c("long_pause", 500, 900, 0.8);
    const st = useDecisions.getState();
    st.setCandidates("m", [a, b], { label: "rules", aggressiveness: 50 });
    expect(st.bulk("m", (x) => x.kind === "filler", "rejected")).toBe(1);
    expect(useDecisions.getState().decisions.m[a.id].state).toBe("rejected");
    expect(useDecisions.getState().decisions.m[b.id].state).toBe("auto");
  });

  it("bulkIds：47 筆整組決定只算一筆 undo", () => {
    const many = Array.from({ length: 47 }, (_, i) => c("filler", i * 1000, i * 1000 + 200, 0.5));
    const st = useDecisions.getState();
    st.setCandidates("m", many, { label: "rules", aggressiveness: 50 });
    const base = useDecisions.getState().past.length;
    expect(st.bulkIds("m", many.map((x) => x.id), "accepted", "整組接受")).toBe(47);
    expect(useDecisions.getState().past).toHaveLength(base + 1);
    expect(useDecisions.getState().decisions.m[many[0].id].state).toBe("accepted");
    st.undo();
    // 一次 undo 就要把 47 筆全部退回去
    expect(useDecisions.getState().decisions.m[many[0].id].state).toBe("pending");
    expect(useDecisions.getState().decisions.m[many[46].id].state).toBe("pending");
  });

  it("bulkIds：不認識的 id 直接忽略（不會塞出幽靈決策）", () => {
    const a = c("filler", 0, 100, 0.9);
    const st = useDecisions.getState();
    st.setCandidates("m", [a], { label: "rules", aggressiveness: 50 });
    expect(st.bulkIds("m", ["不存在", a.id], "rejected")).toBe(1);
    expect(Object.keys(useDecisions.getState().decisions.m)).toEqual([a.id]);
    expect(st.bulkIds("m", [], "rejected")).toBe(0);
  });

  it("bulkIds 之後使用者的個別決策仍然贏過重跑規則", () => {
    const many = Array.from({ length: 5 }, (_, i) => c("filler", i * 1000, i * 1000 + 200, 0.9));
    const st = useDecisions.getState();
    st.setCandidates("m", many, { label: "rules", aggressiveness: 50 });
    st.bulkIds("m", many.map((x) => x.id), "rejected", "整組拒絕");
    st.setCandidates("m", many, { label: "rules again", aggressiveness: 50 });
    for (const x of many) expect(useDecisions.getState().decisions.m[x.id]).toMatchObject({ state: "rejected", origin: "user" });
  });
});

describe("addManualCuts（逐字稿批次剪除）", () => {
  beforeEach(() => useDecisions.setState({ candidates: {}, decisions: {}, overlays: {}, past: [], future: [], selectedIds: [] }));

  const cuts = [
    { startMs: 100, endMs: 200, wordIds: [1], sentenceId: 0 },
    { startMs: 500, endMs: 620, wordIds: [5], sentenceId: 1 },
    { startMs: 900, endMs: 1000, wordIds: [9], sentenceId: 2 },
  ];

  it("N 筆剪除只佔一筆 undo —— 剪掉 23 個「呃」不該要按 23 次 Ctrl+Z", () => {
    const st = useDecisions.getState();
    expect(st.addManualCuts("m", cuts)).toBe(3);
    expect(useDecisions.getState().candidates.m).toHaveLength(3);
    expect(useDecisions.getState().past).toHaveLength(1);

    useDecisions.getState().undo();
    expect(useDecisions.getState().candidates.m ?? []).toHaveLength(0);
    useDecisions.getState().redo();
    expect(useDecisions.getState().candidates.m).toHaveLength(3);
  });

  it("每一筆都直接是 accepted（人說要剪就是要剪，不用再審一次）", () => {
    useDecisions.getState().addManualCuts("m", cuts);
    const { candidates, decisions } = useDecisions.getState();
    for (const c of candidates.m) {
      expect(decisions.m[c.id].state).toBe("accepted");
      expect(c.source).toBe("user");
      expect(c.kind).toBe("manual");
    }
  });

  it("候選依時間排序，重複範圍不會生出第二筆", () => {
    useDecisions.getState().addManualCuts("m", [...cuts].reverse());
    expect(useDecisions.getState().candidates.m.map((c) => c.startMs)).toEqual([100, 500, 900]);
    // 同一段再剪一次：不新增（回 0），總數不變
    expect(useDecisions.getState().addManualCuts("m", [cuts[0]])).toBe(0);
    expect(useDecisions.getState().candidates.m).toHaveLength(3);
  });

  it("重複剪同一段不留下空的 undo —— 助手重試時最容易踩到", () => {
    useDecisions.getState().addManualCuts("m", cuts);
    expect(useDecisions.getState().past).toHaveLength(1);
    // 第二次一模一樣的指令：沒有東西可改，就不該多一筆 undo
    expect(useDecisions.getState().addManualCuts("m", cuts)).toBe(0);
    expect(useDecisions.getState().past).toHaveLength(1);
    // 按一次 Ctrl+Z 就要真的回到沒剪的狀態，不是還原一個空操作
    useDecisions.getState().undo();
    expect(useDecisions.getState().candidates.m ?? []).toHaveLength(0);
  });

  it("先前被拒絕的同一段，再剪一次要生效", () => {
    useDecisions.getState().addManualCuts("m", [cuts[0]]);
    const id = useDecisions.getState().candidates.m[0].id;
    useDecisions.getState().decide("m", [id], "rejected");
    const depth = useDecisions.getState().past.length;
    expect(useDecisions.getState().addManualCuts("m", [cuts[0]])).toBe(0);
    expect(useDecisions.getState().decisions.m[id].state).toBe("accepted");
    expect(useDecisions.getState().past).toHaveLength(depth + 1);
  });

  it("空陣列不留下 undo 紀錄", () => {
    expect(useDecisions.getState().addManualCuts("m", [])).toBe(0);
    expect(useDecisions.getState().past).toHaveLength(0);
  });

  it("addOverlays 整批算一筆 undo（套一個範本不該按五次 Ctrl+Z）", () => {
    const st = useDecisions.getState();
    const ov = (outStartMs: number, id: string) => ({
      id,
      lane: "music" as const,
      mediaId: "m",
      srcInMs: 0,
      srcOutMs: 5000,
      outStartMs,
      gainDb: -18,
      fadeInMs: 1000,
      fadeOutMs: 1000,
      points: [],
    });
    st.addOverlays("m", [ov(9000, "b"), ov(0, "a"), ov(4000, "c")], "套用範本");
    expect(useDecisions.getState().overlays.m.map((o) => o.id)).toEqual(["a", "c", "b"]);
    expect(useDecisions.getState().past).toHaveLength(1);
    useDecisions.getState().undo();
    expect(useDecisions.getState().overlays.m ?? []).toEqual([]);
  });

  it("addOverlays 空陣列不留下一筆什麼都沒做的 undo", () => {
    useDecisions.getState().addOverlays("m", [], "套用範本");
    expect(useDecisions.getState().past).toHaveLength(0);
  });

  it("重跑講者指派**留著使用者改好的名字**（不然改完名再跑一次就打回檔名）", () => {
    const st = useDecisions.getState();
    st.setSpeakers("m", { list: [{ id: "sp0", label: "_mark_raw", colorIndex: 0 }], turns: [] }, "指派");
    st.renameSpeaker("m", "sp0", "Mark");
    st.setSpeakers("m", { list: [{ id: "sp0", label: "_mark_raw", colorIndex: 0 }], turns: [{ startMs: 0, endMs: 100, speakerId: "sp0" }] }, "重跑");
    const now = useDecisions.getState().speakers.m;
    expect(now.list[0].label).toBe("Mark");
    expect(now.turns).toHaveLength(1);
  });

  it("講者跟決策共用 undo（指派錯了要能 Ctrl+Z）", () => {
    const st = useDecisions.getState();
    st.setSpeakers("m", { list: [{ id: "sp0", label: "A", colorIndex: 0 }], turns: [{ startMs: 0, endMs: 1000, speakerId: "sp0" }] }, "指派");
    st.assignSpeaker("m", 200, 400, null, "清掉");
    expect(useDecisions.getState().speakers.m.turns).toHaveLength(2);
    useDecisions.getState().undo();
    expect(useDecisions.getState().speakers.m.turns).toHaveLength(1);
  });

  it("改一個不存在的講者不留下空的 undo 步", () => {
    useDecisions.getState().renameSpeaker("m", "ghost", "X");
    expect(useDecisions.getState().past).toHaveLength(0);
  });
});
