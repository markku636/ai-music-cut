import { beforeEach, describe, expect, it, vi } from "vitest";
import { OK, allCommands, commandsIn, duplicateChords, registerCommands, resetCommands, runCommand, setCommandHost, simplePanelCommands } from "./registry";
import type { Command } from "./types";

function cmd(p: Partial<Command> & { id: string }): Command {
  return { title: p.id, group: "file", enabled: () => OK, run: () => {}, ...p };
}

beforeEach(() => resetCommands());

describe("registerCommands", () => {
  it("重複註冊同一個 id 不會變兩份，順序保留第一次的位置", () => {
    registerCommands([cmd({ id: "a" }), cmd({ id: "b" })]);
    registerCommands([cmd({ id: "a", title: "A2" }), cmd({ id: "c" })]);
    expect(allCommands().map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(allCommands()[0].title).toBe("A2");
  });
});

describe("commandsIn", () => {
  it("依 section 首次出現順序、order、quick 先於 dialog", () => {
    registerCommands([
      cmd({ id: "x.dialog", group: "repair", section: "噪音", pairId: "x", variant: "dialog" }),
      cmd({ id: "y", group: "repair", section: "音量", order: 5 }),
      cmd({ id: "x.quick", group: "repair", section: "噪音", pairId: "x", variant: "quick" }),
      cmd({ id: "z", group: "repair", section: "音量", order: 1 }),
      cmd({ id: "other", group: "file" }),
    ]);
    expect(commandsIn("repair").map((c) => c.id)).toEqual(["x.quick", "x.dialog", "z", "y"]);
  });
  it("表面過濾：預設只在 menu / palette", () => {
    registerCommands([cmd({ id: "a", group: "effect" }), cmd({ id: "b", group: "effect", surfaces: ["context"] })]);
    expect(commandsIn("effect", "menu").map((c) => c.id)).toEqual(["a"]);
    expect(commandsIn("effect", "context").map((c) => c.id)).toEqual(["b"]);
    expect(commandsIn("effect").map((c) => c.id)).toEqual(["a", "b"]);
  });
});

describe("runCommand", () => {
  it("不能做：不執行、toast 原因、同一句 1.5 秒內只講一次", async () => {
    const info = vi.fn();
    setCommandHost({ info, error: vi.fn(), errMessage: String });
    const run = vi.fn();
    registerCommands([cmd({ id: "a", enabled: () => ({ ok: false, why: "先開啟一個音檔" }), run })]);
    expect(await runCommand("a")).toEqual({ ran: false, why: "先開啟一個音檔" });
    await runCommand("a");
    expect(run).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledTimes(1);
  });
  it("執行丟例外：接住並 toast，不往外炸", async () => {
    const error = vi.fn();
    setCommandHost({ info: vi.fn(), error, errMessage: (e) => `E:${(e as Error).message}` });
    registerCommands([cmd({ id: "boom", run: () => Promise.reject(new Error("x")) })]);
    expect(await runCommand("boom")).toEqual({ ran: false, why: "error" });
    expect(error).toHaveBeenCalledWith("E:x");
  });
  it("未知 id", async () => {
    expect(await runCommand("nope")).toEqual({ ran: false, why: "unknown" });
  });
});

describe("duplicateChords", () => {
  it("兩個指令綁同一個 chord 會被抓到；shortcutManual 不算", () => {
    registerCommands([
      cmd({ id: "a", shortcuts: ["Ctrl+S"] }),
      cmd({ id: "b", shortcuts: ["ctrl+s"] }),
      cmd({ id: "c", shortcuts: ["Shift+S"] }),
      cmd({ id: "j", shortcuts: ["J"], shortcutManual: true }),
      cmd({ id: "j2", shortcuts: ["J"], shortcutManual: true }),
    ]);
    expect(duplicateChords()).toEqual([{ chord: "C-s", ids: ["a", "b"] }]);
  });
});

describe("simplePanelCommands", () => {
  it("只取有 simpleOrder 的、依格位排、最多 8 顆", () => {
    registerCommands([
      ...Array.from({ length: 10 }, (_, i) => cmd({ id: `s${i}`, simple: true, simpleOrder: 10 - i })),
      cmd({ id: "nosimple", simple: true }),
      cmd({ id: "pro", simpleOrder: 0 }),
    ]);
    const ids = simplePanelCommands().map((c) => c.id);
    expect(ids).toHaveLength(8);
    expect(ids[0]).toBe("s9");
    expect(ids).not.toContain("nosimple");
    expect(ids).not.toContain("pro");
  });
});
