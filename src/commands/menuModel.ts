import { t } from "../i18n";
import type { MenuItem } from "../ui/MenuPanel";
import { command, commandsIn, runCommandObject } from "./registry";
import { formatShortcut } from "./shortcut";
import type { Command, CommandGroup, Surface } from "./types";

/**
 * 指令 → 選單項目。工具列下拉、右鍵、（之後的）選單列都從這裡產生，
 * 所以「停用原因放 tooltip」「quick 排在 dialog 前面」「section 之間畫線」只寫一次。
 */

/** 命令面板右側的群組標籤。 */
export const GROUP_LABEL: Record<CommandGroup, string> = {
  file: "檔案",
  edit: "編輯",
  select: "選取",
  playback: "播放",
  effect: "效果",
  repair: "修復",
  tool: "工具",
  ai: "AI",
  view: "檢視",
  help: "說明",
};

export interface ToMenuOpts {
  /** 用簡易模式的白話標籤。 */
  simpleLabel?: boolean;
  /** 不顯示快捷鍵提示。 */
  noShortcut?: boolean;
  /** 這個原因的停用項目直接不畫（例如選取選單裡「先選一段」是廢話）。 */
  hideWhy?: string;
  /** 覆蓋標籤。 */
  label?: string;
}

export function commandLabel(c: Command, simple = false): string {
  const key = simple && c.simpleLabel ? c.simpleLabel : c.title;
  return t(key, c.titleParams);
}

export function commandToMenuItem(c: Command, opts: ToMenuOpts = {}): MenuItem | null {
  const en = c.enabled();
  if (!en.ok && opts.hideWhy && en.why === opts.hideWhy) return null;
  const label = opts.label ?? commandLabel(c, opts.simpleLabel);
  const kids = c.children?.();
  return {
    label,
    icon: c.icon,
    shortcut: opts.noShortcut || !c.shortcuts?.length ? undefined : formatShortcut(c.shortcuts[0]),
    checked: c.checked?.(),
    muted: !en.ok,
    title: en.ok ? (opts.simpleLabel && c.simpleHint ? t(c.simpleHint) : undefined) : t(en.why),
    dataId: c.id,
    children: kids ? () => kids.map((k) => commandToMenuItem(k, { noShortcut: true })).filter((x): x is MenuItem => !!x) : undefined,
    onClick: kids ? undefined : () => void runCommandObject(c, "menu"),
  };
}

/** 一串指令 → 依 section 插分隔線的選單；頭尾與連續的分隔線會被收掉。 */
export function commandsToMenu(cmds: Command[], opts: ToMenuOpts = {}): MenuItem[] {
  const out: MenuItem[] = [];
  let lastSection: string | undefined;
  let first = true;
  for (const c of cmds) {
    const it = commandToMenuItem(c, opts);
    if (!it) continue;
    if (!first && c.section !== lastSection) out.push({ separator: true });
    out.push(it);
    lastSection = c.section;
    first = false;
  }
  return collapseSeparators(out);
}

export function collapseSeparators(items: MenuItem[]): MenuItem[] {
  const out: MenuItem[] = [];
  for (const it of items) {
    if (it.separator) {
      if (!out.length || out[out.length - 1].separator) continue;
      out.push(it);
    } else out.push(it);
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
}

export function groupMenu(group: CommandGroup, surface: Surface = "menu", opts: ToMenuOpts = {}): MenuItem[] {
  return commandsToMenu(commandsIn(group, surface), opts);
}

function byIds(ids: string[], opts: ToMenuOpts = {}): MenuItem[] {
  const out: MenuItem[] = [];
  for (const id of ids) {
    const c = command(id);
    if (!c) continue;
    const it = commandToMenuItem(c, opts);
    if (it) out.push(it);
  }
  return out;
}

/** 選取選單裡「先選一段」是廢話 —— 選單本身就隱含有選取，這個原因的項目直接不畫。 */
const SELECTION_WHY = "先在波形上拖一段";

export interface SelectionMenuCtx {
  mode: "pro" | "simple";
}

/**
 * 簡易模式的右鍵：固定 9 格，每格一串候選指令 id，取第一個已註冊的。
 * 例如「去雜音」在範圍降噪（R4）進來之前退回整檔降噪。
 */
const SIMPLE_SELECTION: string[][] = [
  ["playback.playSelection"],
  ["edit.cut"],
  ["edit.keepOnly"],
  ["repair.denoise.quick", "repair.cleanup.quick"],
  ["effect.gain.preset.p6"],
  ["effect.gain.preset.m6"],
  ["effect.fadeBoth"],
  // 選取區間單獨匯出：小白最常要的「把這一段存成一個檔」
  ["file.exportRange"],
  // 選取區間單獨匯入：把一個音檔放進選的這一段
  ["edit.importIntoSelection"],
];

/** 波形上有選取時的右鍵選單。 */
export function selectionMenuItems(ctx: SelectionMenuCtx): MenuItem[] {
  if (ctx.mode === "simple") {
    const out: MenuItem[] = [];
    for (const slot of SIMPLE_SELECTION) {
      const c = slot.map(command).find((x): x is Command => !!x);
      if (!c) continue;
      const it = commandToMenuItem(c, { simpleLabel: true, noShortcut: true, hideWhy: SELECTION_WHY });
      if (it) out.push(it);
    }
    return out;
  }
  const opts: ToMenuOpts = { hideWhy: SELECTION_WHY };
  const effect = commandsToMenu(commandsIn("effect", "context"), opts);
  const repair = commandsToMenu(commandsIn("repair", "context"), opts);
  return collapseSeparators([
    ...byIds(["playback.playSelection", "playback.loop"], opts),
    { separator: true },
    ...byIds(["edit.cut", "edit.lift", "edit.keepOnly"], opts),
    { separator: true },
    ...(effect.length ? [{ label: t("效果"), children: effect } as MenuItem] : []),
    ...(repair.length ? [{ label: t("修復"), children: repair } as MenuItem] : []),
    { separator: true },
    ...byIds(["ai.style"], opts),
    { separator: true },
    ...byIds(["file.exportRange", "select.highlight"], opts),
    { separator: true },
    ...byIds(["select.zoom", "select.clear"], opts),
  ]);
}

/** 工具列「更多 ▾」：效果 ▸ / 修復 ▸ 兩個子選單 + 檢視 / 工具 / 說明。 */
export function moreMenuItems(): MenuItem[] {
  const effect = groupMenu("effect", "menu");
  const repair = groupMenu("repair", "menu");
  const items: MenuItem[] = [];
  if (effect.length) items.push({ label: t("效果"), children: effect });
  if (repair.length) items.push({ label: t("修復"), children: repair });
  items.push({ separator: true });
  items.push(...groupMenu("view", "menu"));
  items.push({ separator: true });
  items.push(...groupMenu("tool", "menu"));
  items.push({ separator: true });
  items.push(...groupMenu("help", "menu"));
  return collapseSeparators(items);
}

/** 工具列「AI 與交付 ▾」：AI 群組 + 檔案群組裡 section 是「交付」的那幾條。 */
export function aiMenuItems(): MenuItem[] {
  const ai = commandsIn("ai", "menu");
  const deliver = commandsIn("file", "menu").filter((c) => c.section === "交付");
  return collapseSeparators([...commandsToMenu(ai), { separator: true }, ...commandsToMenu(deliver)]);
}
