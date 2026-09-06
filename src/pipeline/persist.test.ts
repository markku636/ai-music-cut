import { beforeEach, describe, expect, it } from "vitest";
import { useDecisions } from "../store/decisions";
import { useProject } from "../store/project";
import { enrichAnalysis, restoreDecisions, type StoredAnalysis } from "./persist";

// 專案檔的往返最怕「安靜地掉東西」：存檔看起來成功、下次開起來少了配樂或章節，
// 而且沒有任何錯誤。每加一種會存進專案檔的資料，都要在這裡補一條。
const MEDIA = "m1";

describe("專案檔往返（存 → 讀）", () => {
  beforeEach(() => {
    useDecisions.setState({ candidates: {}, decisions: {}, effects: {}, splits: {}, markers: {}, overlays: {}, past: [], future: [] });
    useProject.setState({ media: [], activeMediaId: null, analysis: {} });
  });

  function seed() {
    const d = useDecisions.getState();
    d.addManualCut(MEDIA, 4000, 5000, [], "手動剪除");
    d.toggleSplit(MEDIA, 12000);
    const split = useDecisions.getState().splits[MEDIA][0];
    d.setSplitGap(MEDIA, split.id, 500);
    d.addMarker(MEDIA, 0, "chapter", "開場");
    d.addMarker(MEDIA, 20000, "todo", "補音效");
    d.addOverlay(MEDIA, {
      lane: "music",
      mediaId: "m2",
      srcInMs: 0,
      srcOutMs: 20000,
      outStartMs: 0,
      gainDb: -18,
      fadeInMs: 1000,
      fadeOutMs: 2000,
      points: [
        { ms: 0, db: 0 },
        { ms: 5000, db: -9 },
      ],
    });
    d.addEffect(MEDIA, { id: "fx1", kind: "mute", startMs: 1000, endMs: 2000 });
  }

  it("切點 / 標記 / 配樂 / 效果 / 候選都寫得進去也讀得回來", () => {
    seed();
    const before = useDecisions.getState();
    const snapshot = {
      splits: before.splits[MEDIA],
      markers: before.markers[MEDIA],
      overlays: before.overlays[MEDIA],
      effects: before.effects[MEDIA],
      candidates: before.candidates[MEDIA],
      decisions: before.decisions[MEDIA],
    };

    const stored = enrichAnalysis({})[MEDIA] as StoredAnalysis;
    expect(stored.splits).toHaveLength(1);
    expect(stored.markers).toHaveLength(2);
    expect(stored.overlays).toHaveLength(1);
    expect(stored.effects).toHaveLength(1);

    useDecisions.getState().clear(MEDIA);
    expect(useDecisions.getState().splits[MEDIA]).toBeUndefined();

    restoreDecisions(MEDIA, stored);
    const after = useDecisions.getState();
    expect(after.splits[MEDIA]).toEqual(snapshot.splits);
    expect(after.markers[MEDIA]).toEqual(snapshot.markers);
    expect(after.overlays[MEDIA]).toEqual(snapshot.overlays);
    expect(after.effects[MEDIA]).toEqual(snapshot.effects);
    expect(after.candidates[MEDIA]).toEqual(snapshot.candidates);
    expect(after.decisions[MEDIA]).toEqual(snapshot.decisions);
  });

  it("留白與閃避控制點這種細節不會在往返中掉掉", () => {
    seed();
    const stored = enrichAnalysis({})[MEDIA] as StoredAnalysis;
    useDecisions.getState().clear(MEDIA);
    restoreDecisions(MEDIA, stored);
    const s = useDecisions.getState();
    expect(s.splits[MEDIA][0].gapMs).toBe(500);
    expect(s.overlays[MEDIA][0].points).toHaveLength(2);
    expect(s.overlays[MEDIA][0].points?.[1]).toEqual({ ms: 5000, db: -9 });
    expect(s.markers[MEDIA].find((m) => m.kind === "todo")?.title).toBe("補音效");
  });

  it("只有配樂 / 標記、沒有逐字稿也要存得下來（開檔就能剪）", () => {
    const d = useDecisions.getState();
    d.addMarker(MEDIA, 1000, "standard", "笑場");
    const stored = enrichAnalysis({})[MEDIA] as StoredAnalysis;
    expect(stored).toBeTruthy();
    expect(stored.markers).toHaveLength(1);
    useDecisions.getState().clear(MEDIA);
    restoreDecisions(MEDIA, stored);
    expect(useDecisions.getState().markers[MEDIA]).toHaveLength(1);
  });

  it("空的欄位不會寫進檔案（專案檔不要有一堆空陣列）", () => {
    useDecisions.getState().addMarker(MEDIA, 1000, "standard", "只有標記");
    const stored = enrichAnalysis({})[MEDIA] as StoredAnalysis;
    expect(stored.splits).toBeUndefined();
    expect(stored.overlays).toBeUndefined();
    expect(stored.effects).toBeUndefined();
  });
});
