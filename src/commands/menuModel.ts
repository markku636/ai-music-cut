import { t } from "../i18n";
import type { MenuItem } from "../ui/MenuPanel";
import { commandsIn, runCommandObject } from "./registry";
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
