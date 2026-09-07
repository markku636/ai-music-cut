import { describe, expect, it } from "vitest";
import { chordKey, chordOf, formatShortcut, parseShortcut, sameChord } from "./shortcut";

function ev(p: Partial<{ key: string; code: string; isComposing: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }>) {
  return { key: "", code: "", isComposing: false, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...p };
}

describe("parseShortcut", () => {
  it("修飾鍵不分大小寫、字母小寫化", () => {
    expect(parseShortcut("ctrl+shift+Z")).toEqual({ key: "z", ctrl: true, shift: true, alt: false });
    expect(parseShortcut("Alt+Shift+]")).toEqual({ key: "]", ctrl: false, shift: true, alt: true });
  });
  it("Cmd / Meta 視同 Ctrl", () => {
    expect(parseShortcut("Cmd+S").ctrl).toBe(true);
    expect(parseShortcut("Meta+S").ctrl).toBe(true);
  });
  it("特殊鍵別名", () => {
    expect(parseShortcut("Space").key).toBe(" ");
    expect(parseShortcut("Esc").key).toBe("Escape");
    expect(parseShortcut("Shift+Delete").key).toBe("Delete");
    expect(parseShortcut("F1").key).toBe("F1");
    expect(parseShortcut("f1").key).toBe("F1");
  });
  it("Ctrl+= 與 Ctrl++ 是同一個鍵", () => {
    expect(parseShortcut("Ctrl+=").key).toBe("=");
    expect(parseShortcut("Ctrl++").key).toBe("=");
  });
});

describe("chordOf", () => {
  it("中文輸入法：key 是 Process 時從 code 推回字母，Shift 看 shiftKey 不看大小寫", () => {
    const c = chordOf(ev({ key: "Process", code: "KeyS", shiftKey: true }));
    expect(sameChord(c, parseShortcut("Shift+S"))).toBe(true);
    expect(sameChord(c, parseShortcut("S"))).toBe(false);
  });
  it("一般情況：大寫 S（實體 Shift）也對到 Shift+S", () => {
    const c = chordOf(ev({ key: "S", code: "KeyS", shiftKey: true }));
    expect(sameChord(c, parseShortcut("Shift+S"))).toBe(true);
  });
  it("metaKey 視同 Ctrl", () => {
    const c = chordOf(ev({ key: "s", code: "KeyS", metaKey: true }));
    expect(sameChord(c, parseShortcut("Ctrl+S"))).toBe(true);
  });
  it("Ctrl+Shift+= 打出來的 + 也算 Ctrl+=（縮放）", () => {
    const c = chordOf(ev({ key: "+", code: "Equal", ctrlKey: true, shiftKey: true }));
    // 修飾鍵精確相等：這裡 shift 是 true，所以要註冊兩個寫法才吃得到
    expect(c.key).toBe("=");
    expect(sameChord(c, parseShortcut("Ctrl+Shift+="))).toBe(true);
  });
  it("Delete 與 Backspace 是不同的 chord（呼叫端各自註冊）", () => {
    expect(chordKey(chordOf(ev({ key: "Delete", code: "Delete" })))).toBe("Delete");
    expect(chordKey(chordOf(ev({ key: "Backspace", code: "Backspace" })))).toBe("Backspace");
  });
  it("Ctrl+Z 與 Ctrl+Shift+Z 不同", () => {
    const undo = chordOf(ev({ key: "z", code: "KeyZ", ctrlKey: true }));
    const redo = chordOf(ev({ key: "Z", code: "KeyZ", ctrlKey: true, shiftKey: true }));
    expect(sameChord(undo, parseShortcut("Ctrl+Z"))).toBe(true);
    expect(sameChord(redo, parseShortcut("Ctrl+Z"))).toBe(false);
    expect(sameChord(redo, parseShortcut("Ctrl+Shift+Z"))).toBe(true);
  });
});

describe("formatShortcut", () => {
  it("顯示用字", () => {
    expect(formatShortcut("ctrl+shift+z")).toBe("Ctrl+Shift+Z");
    expect(formatShortcut("Space")).toBe("Space");
    expect(formatShortcut("Escape")).toBe("Esc");
    expect(formatShortcut("Alt+ArrowLeft")).toBe("Alt+←");
    expect(formatShortcut("Ctrl+=")).toBe("Ctrl+=");
    expect(formatShortcut("F1")).toBe("F1");
  });
});
