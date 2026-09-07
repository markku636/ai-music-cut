import { Undo2 } from "lucide-react";
import { commandLabel } from "../commands/menuModel";
import { command, runCommand, simplePanelCommands, useCommandTick } from "../commands/registry";
import type { Command } from "../commands/types";
import { useT } from "../i18n";
import { useDecisions } from "../store/decisions";
import Icon from "../ui/Icon";
import HintCard from "./HintCard";

/**
 * 簡易模式右側的「你可以做的事」面板：最上面永遠是復原，然後 ≤8 顆白話大按鈕，
 * 最下面一顆大的「輸出」。每一顆都是註冊表裡的指令（`simple: true` + `simpleOrder`），
 * 停用時不灰掉不講：第二行灰字就是原因。
 */
export default function SimplePanel() {
  const t = useT();
  useCommandTick();
  const past = useDecisions((s) => s.past);
  const cmds = simplePanelCommands();
  const exportCmd = cmds.find((c) => c.id === "file.export") ?? command("file.export");
  const rest = cmds.filter((c) => c.id !== "file.export");
  const lastLabel = past.length ? past[past.length - 1].label : null;

  const Big = ({ c, primary = false }: { c: Command; primary?: boolean }) => {
    const en = c.enabled();
    const hint = en.ok ? (c.simpleHint ? t(c.simpleHint) : null) : t(en.why);
    return (
      <button
        type="button"
        data-cmd={c.id}
        onClick={() => void runCommand(c.id, "simple")}
        title={hint ?? undefined}
        className={`w-full text-left rounded-md border px-3 py-2 transition-colors focus-visible:outline-2 focus-visible:outline-accent/60 ${
          primary
            ? "h-12 flex items-center justify-center bg-accent text-white border-accent shadow-e1 hover:bg-accent/90 text-sm font-medium"
            : en.ok
              ? "border-fg/10 bg-elevated hover:bg-fg/5"
              : "border-fg/8 bg-elevated/60"
        }`}
      >
        <span className={`flex items-center gap-2 ${primary ? "" : "text-[13px]"} ${en.ok || primary ? "" : "text-fg/45"}`}>
          {c.icon && <Icon icon={c.icon} size={primary ? 18 : 15} className={primary ? "" : "text-fg/55"} />}
          <span className="font-medium">{commandLabel(c, true)}</span>
          {c.checked && !primary && <span className={`ml-auto text-[11px] ${c.checked() ? "text-accent" : "text-fg/35"}`}>{c.checked() ? t("開") : t("關")}</span>}
        </span>
        {!primary && hint && <span className={`block mt-0.5 text-[11px] leading-snug ${en.ok ? "text-fg/45" : "text-warning/80"}`}>{hint}</span>}
      </button>
    );
  };

  const undo = command("edit.undo");

  return (
    <div className="w-64 shrink-0 bg-panel border-l border-fg/10 flex flex-col min-h-0" data-testid="simple-panel">
      <div className="p-3 border-b border-fg/10">
        <button
          type="button"
          data-cmd="edit.undo"
          disabled={!past.length}
          onClick={() => void runCommand("edit.undo", "simple")}
          title={past.length ? undefined : t("還沒有可以復原的動作")}
          className="w-full h-9 flex items-center gap-2 px-3 rounded-md border border-fg/10 bg-elevated text-[13px] hover:bg-fg/5 disabled:opacity-45 focus-visible:outline-2 focus-visible:outline-accent/60"
        >
          <Icon icon={undo?.icon ?? Undo2} size={15} className="text-fg/55" />
          <span className="font-medium">{t("復原")}</span>
          {lastLabel && <span className="ml-auto truncate text-[11px] text-fg/45 max-w-[9rem]">{t(lastLabel)}</span>}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-3 space-y-2">
        <div className="text-[11px] text-fg/40 uppercase tracking-wide">{t("你可以做的事")}</div>
        {rest.map((c) => (
          <Big key={c.id} c={c} />
        ))}
        <HintCard id="simple.workspace" />
      </div>
      {exportCmd && (
        <div className="p-3 border-t border-fg/10">
          <Big c={exportCmd} primary />
        </div>
      )}
    </div>
  );
}
