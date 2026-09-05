import { describe, expect, it } from "vitest";
import type { Decision, Opinion } from "../types";
import { isConflict, resolveOpinions } from "./resolve";

const op = (verdict: Opinion["verdict"], reason = "r"): Opinion => ({ verdict, reason, at: "2026-01-01T00:00:00Z" });
const dec = (state: Decision["state"], origin: Decision["origin"] = "llm"): Decision => ({ state, origin, at: "" });

describe("resolveOpinions 真值表", () => {
  const VERDICTS = ["cut", "keep", "unsure"] as const;
  // 剪輯 × 審核 的完整 3×3
  const EXPECT: Record<string, { state: Decision["state"]; conflict: boolean }> = {
    "cut|cut": { state: "auto", conflict: false },
    "cut|keep": { state: "pending", conflict: true },
    "cut|unsure": { state: "pending", conflict: false },
    "keep|cut": { state: "pending", conflict: true },
    "keep|keep": { state: "rejected", conflict: false },
    "keep|unsure": { state: "pending", conflict: false },
    "unsure|cut": { state: "pending", conflict: false },
    "unsure|keep": { state: "pending", conflict: false },
    "unsure|unsure": { state: "pending", conflict: false },
  };

  for (const e of VERDICTS) {
    for (const r of VERDICTS) {
      it(`剪輯=${e} 審核=${r}`, () => {
        const got = resolveOpinions({ current: dec("pending"), editor: op(e), reviewer: op(r), suggestOnly: false });
        expect({ state: got.state, conflict: got.conflict }).toEqual(EXPECT[`${e}|${r}`]);
      });
    }
  }
});

describe("resolveOpinions 邊界", () => {
  it("使用者決定過的絕對不動（但意見仍記錄下來給面板顯示）", () => {
    const got = resolveOpinions({ current: dec("rejected", "user"), editor: op("cut"), reviewer: op("cut"), suggestOnly: false });
    expect(got.state).toBe("rejected");
    expect(got.conflict).toBe(false);
    expect(got.opinions.editor?.verdict).toBe("cut");
  });

  it("只有剪輯有意見 → 等同舊行為", () => {
    expect(resolveOpinions({ current: dec("pending"), editor: op("cut"), reviewer: undefined, suggestOnly: false }).state).toBe("auto");
    expect(resolveOpinions({ current: dec("pending"), editor: op("keep"), reviewer: undefined, suggestOnly: false }).state).toBe("rejected");
    expect(resolveOpinions({ current: dec("pending"), editor: op("unsure"), reviewer: undefined, suggestOnly: false }).state).toBe("pending");
  });

  it("只有審核有意見（剪輯那格失敗）也能用", () => {
    expect(resolveOpinions({ current: dec("pending"), editor: undefined, reviewer: op("keep"), suggestOnly: false }).state).toBe("rejected");
  });

  it("兩邊都沒意見 → 維持原狀", () => {
    const got = resolveOpinions({ current: dec("auto"), editor: undefined, reviewer: undefined, suggestOnly: false });
    expect(got.state).toBe("auto");
    expect(got.changed).toBe(false);
  });

  it("建議類即使兩邊都說剪也只到 pending", () => {
    const got = resolveOpinions({ current: dec("pending"), editor: op("cut"), reviewer: op("cut"), suggestOnly: true });
    expect(got.state).toBe("pending");
  });

  it("意見相反時把審核的理由端到最前面（那是「為什麼不該剪」）", () => {
    const got = resolveOpinions({
      current: dec("pending"),
      editor: op("cut", "口頭禪"),
      reviewer: op("keep", "剪掉會缺主詞"),
      suggestOnly: false,
    });
    expect(got.reason).toBe("剪掉會缺主詞");
  });

  it("沿用既有意見：這一輪只有審核跑，剪輯的舊意見要留著", () => {
    const current: Decision = { ...dec("auto"), opinions: { editor: op("cut") } };
    const got = resolveOpinions({ current, editor: undefined, reviewer: op("keep"), suggestOnly: false });
    expect(got.conflict).toBe(true);
    expect(got.state).toBe("pending");
    expect(got.opinions.editor?.verdict).toBe("cut");
  });
});

describe("isConflict", () => {
  it("要兩個角色都表態而且方向相反", () => {
    expect(isConflict({ ...dec("pending"), opinions: { editor: op("cut"), reviewer: op("keep") } })).toBe(true);
    expect(isConflict({ ...dec("pending"), opinions: { editor: op("cut"), reviewer: op("unsure") } })).toBe(false);
    expect(isConflict({ ...dec("pending"), opinions: { editor: op("cut") } })).toBe(false);
    expect(isConflict(undefined)).toBe(false);
  });
});
