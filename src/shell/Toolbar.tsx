import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { BrainCircuit, Cog, FileMusic, FolderOpen, Info, Keyboard, MicOff, Save, Sparkles, WandSparkles, Zap } from "lucide-react";
import Icon from "../ui/Icon";
import { APP_NAME } from "../brand";
import { useT } from "../i18n";
import { useAssistant } from "../store/assistant";
import LanguageMenu from "./LanguageMenu";
import ThemeMenu from "./ThemeMenu";

export interface ToolbarProps {
  onOpen: () => void;
  onAnalyze: () => void;
  canAnalyze: boolean;
  onJudge: () => void;
  canJudge: boolean;
  onRender: () => void;
  canRender: boolean;
  onSeparate: () => void;
  canSeparate: boolean;
  onHighlight: () => void;
  canHighlight: boolean;
  onSave: () => void;
  dirty: boolean;
  onHelp: () => void;
  onAbout: () => void;
  onSettings: () => void;
}

// ---- 上方大圖示工具列（承襲 db-kit：放不下時收成純圖示，遲滯量測避免震盪）----
export default function Toolbar(p: ToolbarProps) {
  const t = useT();
  const assistantOpen = useAssistant((s) => s.open);
  const tools: { icon: ReactNode; label: string; onClick: () => void; disabled: boolean; active?: boolean; hint?: string; badge?: boolean }[] = [
    { icon: <Icon icon={FolderOpen} size={20} />, label: t("開啟音檔"), onClick: p.onOpen, disabled: false },
    { icon: <Icon icon={WandSparkles} size={20} />, label: t("分析"), onClick: p.onAnalyze, disabled: !p.canAnalyze, hint: t("先開啟一個音檔") },
    { icon: <Icon icon={BrainCircuit} size={20} />, label: t("AI 判讀"), onClick: p.onJudge, disabled: !p.canJudge, hint: t("先完成分析") },
    { icon: <Icon icon={FileMusic} size={20} />, label: t("輸出"), onClick: p.onRender, disabled: !p.canRender, hint: t("先開啟一個音檔") },
    { icon: <Icon icon={MicOff} size={20} />, label: t("去人聲"), onClick: p.onSeparate, disabled: !p.canSeparate, hint: t("先開啟一個音檔") },
    { icon: <Icon icon={Zap} size={20} />, label: t("精華片段"), onClick: p.onHighlight, disabled: !p.canHighlight, hint: t("先開啟一個音檔") },
    { icon: <Icon icon={Save} size={20} />, label: t("儲存專案"), onClick: p.onSave, disabled: false, badge: p.dirty },
    { icon: <Icon icon={Sparkles} size={20} />, label: t("AI 助手"), onClick: () => useAssistant.getState().toggle(), disabled: false, active: assistantOpen },
    { icon: <Icon icon={Keyboard} size={20} />, label: t("快捷鍵 (F1)"), onClick: p.onHelp, disabled: false },
    { icon: <Icon icon={Cog} size={20} />, label: t("設定"), onClick: p.onSettings, disabled: false },
    { icon: <Icon icon={Info} size={20} />, label: t("關於"), onClick: p.onAbout, disabled: false },
  ];

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

  return (
    <div ref={barRef} className="h-16 bg-bar border-b border-fg/10 flex items-center px-3 gap-1 shadow-e1">
      <div className="mr-4 pl-1 flex flex-col justify-center shrink-0 leading-tight">
        <div className="font-semibold text-fg/90 flex items-baseline gap-1.5">
          <span>{APP_NAME}</span>
          <button
            type="button"
            onClick={p.onAbout}
            title={t("版本 {version}", { version: __APP_VERSION__ })}
            className="text-[11px] font-normal text-fg/40 tabular-nums hover:text-fg/70 hover:underline focus-visible:outline-2 focus-visible:outline-accent/60 rounded"
          >
            v{__APP_VERSION__}
          </button>
        </div>
      </div>
      {tools.map((tool) => (
        <button
          type="button"
          key={tool.label}
          onClick={tool.onClick}
          disabled={tool.disabled}
          title={tool.disabled && tool.hint ? tool.hint : tool.label}
          {...(tool.active !== undefined ? { "aria-pressed": tool.active } : {})}
          className={`${compact ? "w-11" : "min-w-16 px-2"} relative shrink-0 h-12 flex flex-col items-center justify-center rounded hover:bg-fg/5 disabled:opacity-40 disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-accent/60 ${
            tool.active ? "bg-accent/12 text-accent" : ""
          }`}
        >
          <span className="text-lg leading-none">{tool.icon}</span>
          {!compact && <span className="text-[11px] text-fg/60 mt-1 whitespace-nowrap">{tool.label}</span>}
          {tool.badge && <span className="absolute top-1.5 right-2 w-1.5 h-1.5 rounded-full bg-warning" aria-hidden />}
        </button>
      ))}
      <div className="ml-auto shrink-0 flex items-center gap-3 pl-3">
        <LanguageMenu compact={compact} />
        <ThemeMenu compact={compact} />
      </div>
    </div>
  );
}
