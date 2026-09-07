import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, MoreHorizontal, Sparkles } from "lucide-react";
import { aiMenuItems, commandLabel, moreMenuItems } from "../commands/menuModel";
import { command, runCommand, useCommandTick } from "../commands/registry";
import { formatShortcut } from "../commands/shortcut";
import type { Command } from "../commands/types";
import Icon from "../ui/Icon";
import MenuPanel from "../ui/MenuPanel";
import { APP_NAME } from "../brand";
import { useT } from "../i18n";
import { useAssistant } from "../store/assistant";

/** 五顆主要動作：開檔 / 分析 / 輸出 / 一鍵智慧剪輯 / 儲存 —— 流程列講的就是這五個動詞。 */
const PRIMARY = ["file.open", "ai.analyze", "file.export", "ai.autoCut", "file.save"];

/**
 * 上方大圖示工具列。沒有 props：五顆主要按鈕與兩個下拉都從指令註冊表長出來。
 * 放不下時收成純圖示（承襲 db-kit：遲滯量測避免震盪）。
 */
export default function Toolbar() {
  const t = useT();
  useCommandTick();
  const assistantOpen = useAssistant((s) => s.open);
  const primary = PRIMARY.map(command).filter((c): c is Command => !!c);

  const [open, setOpen] = useState<null | "more" | "ai">(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const aiRef = useRef<HTMLButtonElement>(null);

  const barRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const neededRef = useRef(0);
  useLayoutEffect(() => {
    neededRef.current = 0;
    setCompact(false);
  }, [t]);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const measure = () => {
      if (!compact) {
        if (bar.scrollWidth > bar.clientWidth) {
          neededRef.current = bar.scrollWidth;
          setCompact(true);
        }
      } else if (neededRef.current && bar.clientWidth >= neededRef.current) {
        setCompact(false);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(bar);
    return () => ro.disconnect();
  }, [compact, t]);

  const bigButton = (key: string, icon: ReactNode, label: string, opts: { onClick: () => void; disabled?: boolean; title?: string; active?: boolean; badge?: boolean; dataCmd?: string; expanded?: boolean; ref?: React.Ref<HTMLButtonElement> }) => (
    <button
      type="button"
      key={key}
      ref={opts.ref}
      onClick={opts.onClick}
      disabled={opts.disabled}
      title={opts.title}
      data-cmd={opts.dataCmd}
      {...(opts.expanded !== undefined ? { "aria-expanded": opts.expanded } : {})}
      className={`${compact ? "w-11" : "min-w-16 px-2"} relative shrink-0 h-12 flex flex-col items-center justify-center rounded hover:bg-fg/5 disabled:opacity-40 disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-accent/60 ${
        opts.active ? "bg-accent/12 text-accent" : ""
      }`}
    >
      <span className="text-lg leading-none inline-flex items-center gap-0.5">{icon}</span>
      {!compact && <span className="text-[11px] text-fg/60 mt-1 whitespace-nowrap">{label}</span>}
      {opts.badge && <span className="absolute top-1.5 right-2 w-1.5 h-1.5 rounded-full bg-warning" aria-hidden />}
    </button>
  );

  return (
    <div ref={barRef} className="h-16 bg-bar border-b border-fg/10 flex items-center px-3 gap-1 shadow-e1">
      <div className="mr-4 pl-1 flex flex-col justify-center shrink-0 leading-tight">
        <div className="font-semibold text-fg/90 flex items-baseline gap-1.5">
          <span>{APP_NAME}</span>
          <button
            type="button"
            onClick={() => void runCommand("help.about", "toolbar")}
            title={t("版本 {version}", { version: __APP_VERSION__ })}
            className="text-[11px] font-normal text-fg/40 tabular-nums hover:text-fg/70 hover:underline focus-visible:outline-2 focus-visible:outline-accent/60 rounded"
          >
            v{__APP_VERSION__}
          </button>
        </div>
      </div>
      {primary.map((c) => {
        const en = c.enabled();
        const label = commandLabel(c);
        const sc = c.shortcuts?.length ? formatShortcut(c.shortcuts[0]) : null;
        return bigButton(c.id, c.icon ? <Icon icon={c.icon} size={20} /> : null, label, {
          // 不灰掉要解釋：停用時 tooltip 就是原因；能用時附快捷鍵
          onClick: () => void runCommand(c.id, "toolbar"),
          disabled: !en.ok,
          title: en.ok ? (sc ? `${label}（${sc}）` : label) : t(en.why),
          badge: c.badge?.(),
          dataCmd: c.id,
        });
      })}

      <span className="w-px h-8 bg-fg/10 mx-1 shrink-0" aria-hidden />
      {bigButton(
        "ai",
        <>
          <Icon icon={Sparkles} size={20} />
          <ChevronDown size={12} className="opacity-60" />
        </>,
        t("AI 與交付"),
        { onClick: () => setOpen((v) => (v === "ai" ? null : "ai")), active: open === "ai" || assistantOpen, expanded: open === "ai", ref: aiRef, dataCmd: "toolbar.ai" },
      )}

      <div className="ml-auto shrink-0 flex items-center gap-1 pl-3">
        <button
          ref={moreRef}
          type="button"
          onClick={() => setOpen((v) => (v === "more" ? null : "more"))}
          aria-expanded={open === "more"}
          title={t("更多（檢視 / 工具 / 說明）")}
          data-cmd="toolbar.more"
          className={`h-8 px-2 flex items-center gap-1 rounded text-xs text-fg/60 hover:bg-fg/5 hover:text-fg/85 focus-visible:outline-2 focus-visible:outline-accent/60 ${open === "more" ? "bg-accent/12 text-accent" : ""}`}
        >
          <Icon icon={MoreHorizontal} size={18} />
          {!compact && <span>{t("更多")}</span>}
          <ChevronDown size={12} className="opacity-60" />
        </button>
      </div>

      {open === "ai" && aiRef.current && <MenuPanel anchor={{ rect: aiRef.current.getBoundingClientRect(), side: "bottom" }} items={aiMenuItems()} onClose={() => setOpen(null)} minWidthClass="min-w-64" />}
      {open === "more" && moreRef.current && <MenuPanel anchor={{ rect: moreRef.current.getBoundingClientRect(), side: "bottom" }} items={moreMenuItems()} onClose={() => setOpen(null)} minWidthClass="min-w-56" />}
    </div>
  );
}
