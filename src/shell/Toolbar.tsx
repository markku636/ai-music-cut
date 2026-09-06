import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { BrainCircuit, Link2, ChevronDown, Cog, Disc3, FileMusic, FileText, FolderOpen, Info, Keyboard, Layers, MessageSquareOff, MicOff, Save, ScrollText, Sparkles, Star, Wand2, WandSparkles, Zap } from "lucide-react";
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
  onSyncMics: () => void;
  canSyncMics: boolean;
  onHighlight: () => void;
  canHighlight: boolean;
  onMusic: () => void;
  onCleanup: () => void;
  canCleanup: boolean;
  onHighlights: () => void;
  canHighlights: boolean;
  onShowNotes: () => void;
  canShowNotes: boolean;
  onAutoCut: () => void;
  canAutoCut: boolean;
  onPrompts: () => void;
  onFillers: () => void;
  onBatch: () => void;
  canBatch: boolean;
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
  // 12 顆同權重的按鈕沒有主次可言，每次都要重新掃一遍才找得到「輸出」在哪。
  // 分成三層：主要動作 4 顆（開啟 / 分析 / 輸出 / 儲存）、AI 工具收成下拉、
  // 快捷鍵 / 設定 / 關於 移到最右邊（那是「偶爾才用一次」的東西）。
  type Tool = { icon: ReactNode; label: string; onClick: () => void; disabled: boolean; active?: boolean; hint?: string; badge?: boolean };
  const tools: Tool[] = [
    { icon: <Icon icon={FolderOpen} size={20} />, label: t("開啟音檔"), onClick: p.onOpen, disabled: false, hint: t("Ctrl+O") },
    { icon: <Icon icon={WandSparkles} size={20} />, label: t("分析"), onClick: p.onAnalyze, disabled: !p.canAnalyze, hint: t("先開啟一個音檔") },
    { icon: <Icon icon={FileMusic} size={20} />, label: t("輸出"), onClick: p.onRender, disabled: !p.canRender, hint: t("先開啟一個音檔") },
    { icon: <Icon icon={Zap} size={20} />, label: t("一鍵粗剪"), onClick: p.onAutoCut, disabled: !p.canAutoCut, hint: t("先開啟一個音檔") },
    { icon: <Icon icon={Save} size={20} />, label: t("儲存專案"), onClick: p.onSave, disabled: false, badge: p.dirty, hint: t("Ctrl+S") },
  ];
  const aiTools: Tool[] = [
    { icon: <Icon icon={BrainCircuit} size={16} />, label: t("AI 判讀（剪輯＋審核）"), onClick: p.onJudge, disabled: !p.canJudge, hint: t("先完成分析") },
    { icon: <Icon icon={Layers} size={16} />, label: t("批次處理（多集一次跑完）"), onClick: p.onBatch, disabled: !p.canBatch, hint: t("媒體清單裡要有檔案") },
    { icon: <Icon icon={MessageSquareOff} size={16} />, label: t("贅字管理（依詞整群處理）"), onClick: p.onFillers, disabled: false },
    { icon: <Icon icon={Sparkles} size={16} />, label: t("AI 助手"), onClick: () => useAssistant.getState().toggle(), disabled: false, active: assistantOpen },
    { icon: <Icon icon={Disc3} size={16} />, label: t("AI 配樂"), onClick: p.onMusic, disabled: false },
    { icon: <Icon icon={MicOff} size={16} />, label: t("去人聲"), onClick: p.onSeparate, disabled: !p.canSeparate, hint: t("先開啟一個音檔") },
    { icon: <Icon icon={Wand2} size={16} />, label: t("修聲（降噪 / 去隆隆 / 齒音）"), onClick: p.onCleanup, disabled: !p.canCleanup, hint: t("先開啟一個音檔") },
    { icon: <Icon icon={Zap} size={16} />, label: t("精華片段"), onClick: p.onHighlight, disabled: !p.canHighlight, hint: t("先開啟一個音檔") },
    { icon: <Icon icon={Star} size={16} />, label: t("精華合輯（串成一支預告）"), onClick: p.onHighlights, disabled: !p.canHighlights, hint: t("先開啟一個音檔") },
    { icon: <Icon icon={FileText} size={16} />, label: t("節目筆記（摘要 / 章節 / 節錄）"), onClick: p.onShowNotes, disabled: !p.canShowNotes, hint: t("先開啟一個音檔") },
    { icon: <Icon icon={Link2} size={16} />, label: t("同步麥克風"), onClick: p.onSyncMics, disabled: !p.canSyncMics, hint: t("媒體清單裡要有兩個以上的檔案") },
  ];
  const utilTools: Tool[] = [
    { icon: <Icon icon={Keyboard} size={18} />, label: t("快捷鍵 (F1)"), onClick: p.onHelp, disabled: false },
    { icon: <Icon icon={ScrollText} size={18} />, label: t("提示詞"), onClick: p.onPrompts, disabled: false },
    { icon: <Icon icon={Cog} size={18} />, label: t("設定"), onClick: p.onSettings, disabled: false },
    { icon: <Icon icon={Info} size={18} />, label: t("關於"), onClick: p.onAbout, disabled: false },
  ];

  const [aiOpen, setAiOpen] = useState(false);
  const aiRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!aiOpen) return;
    const close = (e: MouseEvent) => {
      if (!aiRef.current?.contains(e.target as Node)) setAiOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setAiOpen(false);
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [aiOpen]);

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
          title={tool.disabled && tool.hint ? tool.hint : tool.hint ? `${tool.label}（${tool.hint}）` : tool.label}
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

      <span className="w-px h-8 bg-fg/10 mx-1 shrink-0" aria-hidden />
      <div className="relative shrink-0" ref={aiRef}>
        <button
          type="button"
          onClick={() => setAiOpen((v) => !v)}
          aria-expanded={aiOpen}
          title={t("AI 工具")}
          className={`${compact ? "w-11" : "min-w-16 px-2"} h-12 flex flex-col items-center justify-center rounded hover:bg-fg/5 focus-visible:outline-2 focus-visible:outline-accent/60 ${
            aiOpen || assistantOpen ? "bg-accent/12 text-accent" : ""
          }`}
        >
          <span className="text-lg leading-none inline-flex items-center gap-0.5">
            <Icon icon={Sparkles} size={20} />
            <ChevronDown size={12} className="opacity-60" />
          </span>
          {!compact && <span className="text-[11px] text-fg/60 mt-1 whitespace-nowrap">{t("AI 工具")}</span>}
        </button>
        {aiOpen && (
          <div className="absolute left-0 top-full mt-1 z-50 min-w-56 rounded-md border border-fg/10 bg-elevated shadow-e2 py-1">
            {aiTools.map((tool) => (
              <button
                type="button"
                key={tool.label}
                disabled={tool.disabled}
                title={tool.disabled && tool.hint ? tool.hint : undefined}
                onClick={() => {
                  setAiOpen(false);
                  tool.onClick();
                }}
                className={`w-full px-3 py-1.5 flex items-center gap-2 text-sm text-left hover:bg-fg/5 disabled:opacity-40 disabled:hover:bg-transparent ${tool.active ? "text-accent" : "text-fg/85"}`}
              >
                {tool.icon}
                {tool.label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="ml-auto shrink-0 flex items-center gap-1 pl-3">
        {utilTools.map((tool) => (
          <button
            type="button"
            key={tool.label}
            onClick={tool.onClick}
            title={tool.label}
            className="w-8 h-8 grid place-items-center rounded text-fg/55 hover:bg-fg/5 hover:text-fg/85 focus-visible:outline-2 focus-visible:outline-accent/60"
          >
            {tool.icon}
          </button>
        ))}
        <span className="w-px h-5 bg-fg/10 mx-1" aria-hidden />
        <LanguageMenu compact={compact} />
        <ThemeMenu compact={compact} />
      </div>
    </div>
  );
}
