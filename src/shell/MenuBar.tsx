import { useRef, useState } from "react";
import { GROUP_LABEL, groupMenu } from "../commands/menuModel";
import { useCommandTick } from "../commands/registry";
import type { CommandGroup } from "../commands/types";
import { useT } from "../i18n";
import MenuPanel from "../ui/MenuPanel";

/** 選單列的順序（GoldWave / 一般桌面軟體的慣例）。沒有任何指令的群組不畫。 */
const GROUPS: CommandGroup[] = ["file", "edit", "select", "playback", "effect", "repair", "tool", "ai", "view", "help"];

/**
 * 專業模式的選單列：全部由指令註冊表的 group / section 長出來（與右鍵、命令面板同一張表），
 * 沒有手寫的選單結構。開著時滑過另一個標題就切換（Windows 慣例）；鍵盤操作由 MenuPanel 處理。
 * 簡易模式不顯示 —— 小白只需要面板那幾顆按鈕。
 */
export default function MenuBar() {
  const t = useT();
  useCommandTick();
  const [open, setOpen] = useState<CommandGroup | null>(null);
  const refs = useRef<Partial<Record<CommandGroup, HTMLButtonElement | null>>>({});
  const groups = GROUPS.filter((g) => groupMenu(g, "menu").length > 0);
  const anchor = open ? refs.current[open] : null;
  const items = open ? groupMenu(open, "menu") : [];

  return (
    <div className="h-7 shrink-0 bg-bar border-b border-fg/10 flex items-center px-1 gap-0.5 text-xs select-none" role="menubar" data-testid="menubar">
      {groups.map((g) => (
        <button
          key={g}
          ref={(el) => {
            refs.current[g] = el;
          }}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={open === g}
          data-menu={g}
          onClick={() => setOpen((v) => (v === g ? null : g))}
          onMouseOver={() => {
            if (open && open !== g) setOpen(g);
          }}
          className={`h-6 px-2 rounded hover:bg-fg/8 focus-visible:outline-2 focus-visible:outline-accent/60 ${open === g ? "bg-accent/15 text-accent" : "text-fg/75"}`}
        >
          {t(GROUP_LABEL[g])}
        </button>
      ))}
      {open && anchor && items.length > 0 && (
        <MenuPanel anchor={{ rect: anchor.getBoundingClientRect(), side: "bottom" }} items={items} onClose={() => setOpen(null)} minWidthClass="min-w-60" />
      )}
    </div>
  );
}
