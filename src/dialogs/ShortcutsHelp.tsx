import { Keyboard } from "lucide-react";
import { GROUP_LABEL, commandLabel } from "../commands/menuModel";
import { commandsWithShortcuts, useCommandTick } from "../commands/registry";
import { formatShortcut } from "../commands/shortcut";
import type { CommandGroup } from "../commands/types";
import { Button, Modal } from "../ui/index";
import { useT } from "../i18n";

/**
 * 沒有登記成指令、由手寫程式或滑鼠手勢處理的那幾條。
 * 其餘全部從指令註冊表產生 —— 以前這張表是手抄的，漏了 Alt+X、Shift+I/O 之類的東西。
 */
const MANUAL_ROWS: [string, string][] = [
  ["J / K / L", "轉盤：倒退 / 停 / 前進，連按加速 1x → 2x → 4x（J 與 L 互相抵銷；按住 K 再點是 0.5x 慢速）"],
  ["← / →", "±1 秒（Shift：±5 秒；Alt：微調 ±10 ms，Alt+Shift：±1 ms）"],
  ["Ctrl+滾輪 / 滾輪", "以游標為中心縮放 / 放大後水平捲動"],
  ["雙擊波形上的色塊", "剪 ↔ 不剪；拖色塊邊緣可調整範圍"],
  ["Shift+點逐字稿的字", "從上一個點的字選到這個字"],
];

const GROUP_ORDER: CommandGroup[] = ["playback", "edit", "select", "view", "effect", "repair", "file", "tool", "ai", "help"];

export default function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const t = useT();
  useCommandTick();
  const byGroup = new Map<CommandGroup, ReturnType<typeof commandsWithShortcuts>>();
  for (const c of commandsWithShortcuts()) {
    if (c.id === "playback.shuttle") continue; // MANUAL_ROWS 已經講得更清楚
    const arr = byGroup.get(c.group) ?? [];
    arr.push(c);
    byGroup.set(c.group, arr);
  }
  return (
    <Modal open onClose={onClose} title={t("快捷鍵")} icon={Keyboard} size="md" footer={<Button variant="primary" onClick={onClose}>{t("關閉")}</Button>}>
      <div className="text-[11px] text-fg/45 mb-3">{t("找不到功能在哪？按 Ctrl+K 直接搜。")}</div>
      <table className="w-full text-sm">
        <tbody>
          {GROUP_ORDER.map((g) => {
            const cmds = byGroup.get(g);
            if (!cmds?.length) return null;
            return [
              <tr key={`g-${g}`}>
                <td colSpan={2} className="pt-3 pb-1 text-[10px] uppercase tracking-wide text-fg/35">
                  {t(GROUP_LABEL[g])}
                </td>
              </tr>,
              ...cmds.map((c) => (
                <tr key={c.id} className="border-b border-fg/5">
                  <td className="py-1.5 pr-3 mono text-fg/80 whitespace-nowrap">{(c.shortcuts ?? []).map(formatShortcut).join(" / ")}</td>
                  <td className="py-1.5 text-fg/60">{commandLabel(c)}</td>
                </tr>
              )),
            ];
          })}
          <tr>
            <td colSpan={2} className="pt-3 pb-1 text-[10px] uppercase tracking-wide text-fg/35">
              {t("滑鼠與手勢")}
            </td>
          </tr>
          {MANUAL_ROWS.map(([k, v]) => (
            <tr key={k} className="border-b border-fg/5">
              <td className="py-1.5 pr-3 mono text-fg/80 whitespace-nowrap">{k}</td>
              <td className="py-1.5 text-fg/60">{t(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}
