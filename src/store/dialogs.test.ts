import { beforeEach, describe, expect, it } from "vitest";
import { useDialogs } from "./dialogs";

beforeEach(() => useDialogs.getState().closeAll());

describe("dialogs store", () => {
  it("open 疊上去、close 拿掉、isOpen 反映", () => {
    const d = useDialogs.getState();
    d.open("settings", { focus: "asr" });
    d.open("prompts");
    expect(useDialogs.getState().stack.map((e) => e.id)).toEqual(["settings", "prompts"]);
    expect(useDialogs.getState().isOpen("settings")).toBe(true);
    useDialogs.getState().close("settings");
    expect(useDialogs.getState().stack.map((e) => e.id)).toEqual(["prompts"]);
    expect(useDialogs.getState().isOpen("settings")).toBe(false);
  });
  it("重開同一個：同 props → 移到最上層、key 不變（不重掛）；props 不同 → key 遞增（重掛）", () => {
    const d = useDialogs.getState();
    d.open("render", { range: null });
    const k = useDialogs.getState().stack[0].key;
    d.open("about");
    d.open("render", { range: null });
    let st = useDialogs.getState().stack;
    expect(st.map((e) => e.id)).toEqual(["about", "render"]);
    expect(st[1].key).toBe(k);
    d.open("render", { range: { startMs: 1, endMs: 2 } });
    st = useDialogs.getState().stack;
    expect(st[1].key).not.toBe(k);
    expect(st[1].props).toEqual({ range: { startMs: 1, endMs: 2 } });
  });
  it("關掉再開：key 遞增 = 重新掛載", () => {
    const d = useDialogs.getState();
    d.open("cleanup");
    const k1 = useDialogs.getState().stack[0].key;
    d.close("cleanup");
    d.open("cleanup");
    expect(useDialogs.getState().stack[0].key).toBeGreaterThan(k1);
  });
  it("closeTop 只關最上層", () => {
    const d = useDialogs.getState();
    d.open("settings");
    d.open("prompts");
    d.closeTop();
    expect(useDialogs.getState().stack.map((e) => e.id)).toEqual(["settings"]);
  });
  it("close 沒開著的對話框不會產生新的 state 物件", () => {
    const before = useDialogs.getState().stack;
    useDialogs.getState().close("about");
    expect(useDialogs.getState().stack).toBe(before);
  });
});
