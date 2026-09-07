import { beforeEach, describe, expect, it } from "vitest";
import { collapseSeparators, commandsToMenu, selectionMenuItems } from "./menuModel";
import { OK, commandsIn, registerCommands, resetCommands } from "./registry";
import type { Command } from "./types";
import type { MenuItem } from "../ui/MenuPanel";

function cmd(p: Partial<Command> & { id: string }): Command {
  return { title: p.id, group: "effect", enabled: () => OK, run: () => {}, ...p };
}

function kids(it: MenuItem): MenuItem[] {
  return typeof it.children === "function" ? it.children() : (it.children ?? []);
}

beforeEach(() => resetCommands());

describe("collapseSeparators", () => {
  it("頭尾與連續的分隔線收掉", () => {
    const sep = { separator: true };
    const a = { label: "a" };
    const b = { label: "b" };
    expect(collapseSeparators([sep, a, sep, sep, b, sep])).toEqual([a, sep, b]);
  });
});

describe("commandsToMenu", () => {
  it("section 變了才畫線；停用的變 muted + title；quick 先於 dialog", () => {
    registerCommands([
      cmd({ id: "x.dialog", section: "噪音", pairId: "x", variant: "dialog" }),
      cmd({ id: "x.quick", section: "噪音", pairId: "x", variant: "quick" }),
      cmd({ id: "y", section: "音量", enabled: () => ({ ok: false, why: "先開啟一個音檔" }) }),
    ]);
    const items = commandsToMenu(commandsIn("effect"));
    expect(items.map((i) => (i.separator ? "---" : i.dataId))).toEqual(["x.quick", "x.dialog", "---", "y"]);
    const y = items[3];
    expect(y.muted).toBe(true);
    expect(y.title).toBe("先開啟一個音檔");
    expect(items[0].muted).toBe(false);
  });
  it("hideWhy：那個原因的項目直接不畫", () => {
    registerCommands([cmd({ id: "a", enabled: () => ({ ok: false, why: "先在波形上拖一段" }) }), cmd({ id: "b" })]);
    expect(commandsToMenu(commandsIn("effect"), { hideWhy: "先在波形上拖一段" }).map((i) => i.dataId)).toEqual(["b"]);
  });
  it("動態子指令變成子選單", () => {
    registerCommands([cmd({ id: "p", children: () => [cmd({ id: "p.1", title: "one" }), cmd({ id: "p.2", title: "two" })] })]);
    const [it] = commandsToMenu(commandsIn("effect"));
    expect(kids(it).map((k) => k.label)).toEqual(["one", "two"]);
    expect(it.onClick).toBeUndefined();
  });
});

function seedSelectionCommands() {
  registerCommands([
    cmd({ id: "playback.playSelection", title: "播放選取", simpleLabel: "播放這段", group: "playback", surfaces: ["context"] }),
    cmd({ id: "playback.loop", group: "playback", surfaces: ["context"] }),
    cmd({ id: "edit.cut", title: "剪掉", simpleLabel: "剪掉選的這段", group: "edit", surfaces: ["context"], shortcuts: ["Delete"] }),
    cmd({ id: "edit.keepOnly", group: "edit", surfaces: ["context"] }),
    cmd({ id: "effect.mute", group: "effect", surfaces: ["context"] }),
    cmd({ id: "effect.hidden", group: "effect", surfaces: ["context"], enabled: () => ({ ok: false, why: "先在波形上拖一段" }) }),
    cmd({ id: "effect.gain.preset.p6", group: "effect", surfaces: ["context"] }),
    cmd({ id: "repair.cleanup.quick", group: "repair", surfaces: ["context"], pairId: "c", variant: "quick", enabled: () => ({ ok: false, why: "還沒有波形分析，量不到底噪" }) }),
    cmd({ id: "repair.cleanup.dialog", group: "repair", surfaces: ["context"], pairId: "c", variant: "dialog" }),
    cmd({ id: "select.clear", group: "select", surfaces: ["context"] }),
  ]);
}

describe("selectionMenuItems（專業）", () => {
  it("效果 ▸ / 修復 ▸ 子選單來自註冊表；needsSelection 的原因直接隱藏、其他原因 muted", () => {
    seedSelectionCommands();
    const items = selectionMenuItems({ mode: "pro" });
    const labels = items.map((i) => (i.separator ? "---" : String(i.label)));
    const effect = items.find((i) => i.label === "效果")!;
    expect(kids(effect).map((k) => k.dataId)).toEqual(["effect.mute", "effect.gain.preset.p6"]);
    const repair = items.find((i) => i.label === "修復")!;
    const rk = kids(repair);
    expect(rk.map((k) => k.dataId)).toEqual(["repair.cleanup.quick", "repair.cleanup.dialog"]);
    expect(rk[0].muted).toBe(true);
    expect(rk[0].title).toBe("還沒有波形分析，量不到底噪");
    expect(labels.some((l, i) => l === "---" && labels[i + 1] === "---")).toBe(false);
    expect(labels[labels.length - 1]).not.toBe("---");
    // 沒登記的 id（edit.lift）不會留下空位：每個非分隔線項目都有標籤
    expect(items.every((i) => i.separator || (typeof i.label === "string" && i.label.length > 0))).toBe(true);
    expect(items.map((i) => i.dataId)).not.toContain("edit.lift");
  });
});

describe("selectionMenuItems（簡易）", () => {
  it("平的、用白話標籤、沒有快捷鍵、沒有子選單；候選退回第一個已註冊的 id", () => {
    seedSelectionCommands();
    const items = selectionMenuItems({ mode: "simple" });
    expect(items.every((i) => !i.separator && !i.children)).toBe(true);
    expect(items.map((i) => i.dataId)).toEqual(["playback.playSelection", "edit.cut", "edit.keepOnly", "repair.cleanup.quick", "effect.gain.preset.p6"]);
    expect(items[0].label).toBe("播放這段");
    expect(items[1].label).toBe("剪掉選的這段");
    expect(items[1].shortcut).toBeUndefined();
  });
});
