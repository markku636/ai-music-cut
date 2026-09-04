import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Candidate } from "../analysis/types";
import { candidateId } from "../analysis/types";

vi.mock("./project", () => ({ useProject: { getState: () => ({ markDirty: () => {} }) } }));

const { useDecisions, defaultStateFor } = await import("./decisions");

function c(kind: Candidate["kind"], s: number, e: number, score: number, source: Candidate["source"] = "rule"): Candidate {
  return { id: candidateId(kind, s, e, source), kind, startMs: s, endMs: e, wordIds: [], reason: "r", score, source, sentenceId: 0 };
}

describe("decisions store", () => {
  beforeEach(() => useDecisions.setState({ candidates: {}, decisions: {}, past: [], future: [], selectedIds: [] }));

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
});
