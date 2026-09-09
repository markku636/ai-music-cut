// 簡易面板那八顆按鈕的文案不變式。
//
// 面板上每一顆只有兩行：白話標籤，以及第二行 ——
// **能按的時候顯示 `simpleHint`（按下去會怎樣），不能按的時候顯示 `enabled().why`（還缺什麼）**。
// 這兩件事寫成同一句的話，使用者做完前置動作之後那一行不會變，看起來像「還是不行」。
//
// 實際發生過：`edit.cut` 的 `simpleHint` 是「先在波形上拖一段」，跟它的停用理由
// 一字不差。使用者拖完選取、按鈕已經可以按了，第二行還在叫他去拖。
// 隔壁的「只留選的這段」與「重錄這句」都會換成說明，只有它不會。
import { beforeEach, describe, expect, it } from "vitest";
import { CORE_COMMANDS } from "./core";
import { EFFECT_COMMANDS } from "./effectCommands";
import { CLIP_COMMANDS } from "./clipCommands";
import { useProject } from "../store/project";
import { useTimeline } from "../store/timeline";
import { useDecisions } from "../store/decisions";

const ALL = [...CORE_COMMANDS, ...EFFECT_COMMANDS, ...CLIP_COMMANDS];
const SIMPLE = ALL.filter((c) => c.simple && c.simpleOrder != null);

/** 有檔案、但什麼都還沒做 —— 第一次開 App 的人看到的狀態。 */
beforeEach(() => {
  useProject.setState({
    activeMediaId: "m1",
    media: [{ id: "m1", name: "a.wav", path: "/a.wav", probe: { duration_ms: 60_000 }, analysis: "none" }] as never,
  });
  useTimeline.setState({ selection: null });
  useDecisions.setState({ selectedIds: [], candidates: {}, decisions: {} } as never);
});

describe("簡易面板的說明", () => {
  it("面板上就是八顆（多了要決定拿掉哪一顆，不能默默被 slice 掉）", () => {
    expect(SIMPLE).toHaveLength(8);
    expect(SIMPLE.map((c) => c.simpleOrder).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("每一顆都有白話標籤與說明", () => {
    for (const c of SIMPLE) {
      expect(c.simpleLabel, `${c.id} 少了 simpleLabel`).toBeTruthy();
      expect(c.simpleHint, `${c.id} 少了 simpleHint`).toBeTruthy();
    }
  });

  it("說明不能跟停用理由是同一句", () => {
    for (const c of SIMPLE) {
      const e = c.enabled();
      if (e.ok) continue;
      expect(c.simpleHint, `${c.id} 的說明與停用理由同一句：「${c.simpleHint}」—— 前置做完之後那一行不會變`).not.toBe(e.why);
    }
  });

  it("需要選取的那幾顆：拖了一段之後說明要換成「按下去會怎樣」", () => {
    const blockedWithoutSelection = SIMPLE.filter((c) => !c.enabled().ok);
    expect(blockedWithoutSelection.length, "沒有選取時本來就該有幾顆按不了").toBeGreaterThan(0);

    useTimeline.setState({ selection: { startMs: 1000, endMs: 2000 } });
    for (const c of blockedWithoutSelection) {
      const e = c.enabled();
      if (!e.ok) continue; // 不是被選取擋住的，跳過
      expect(c.simpleHint, `${c.id} 現在可以按了，但說明還是停用時那一句`).toBeTruthy();
      // 這一句是「會怎樣」，不是「還缺什麼」——「先…」開頭的是前置條件的寫法
      expect(c.simpleHint?.startsWith("先"), `${c.id} 的說明是前置條件的寫法：「${c.simpleHint}」`).toBe(false);
    }
  });
});
