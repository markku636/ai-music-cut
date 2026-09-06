import { ChevronRight, ListChecks, ListTree, ShieldCheck, Sparkles } from "lucide-react";
import AssistantPanel from "../assistant/AssistantPanel";
import DecisionPanel from "../decisions/DecisionPanel";
import IndexPanel from "../decisions/IndexPanel";
import { useT } from "../i18n";
import { useDecisions } from "../store/decisions";
import { useUi, RAIL_LIMITS, type RailTab } from "../store/ui";
import { useVerify } from "../store/verify";
import type { DecisionMap } from "../analysis/types";
import type { AnalysisState } from "../store/project";
import type { AudioEffect } from "../analysis/effects";
import type { Marker } from "../analysis/types";
import type { SeamInfo } from "../timeline/trimActions";
import { Badge, IconButton } from "../ui/index";

/**
 * 右側單一側欄 + 分頁。
 *
 * 以前決策面板與 AI 助手是兩個常駐面板：全螢幕（2576px）時波形只剩約 1/3 的寬度，
 * 而且兩個面板九成時間只會用到一個。改成分頁之後波形拿回主場，
 * 分頁上的小數字仍然看得到「有幾筆待決 / 有沒有分歧」。
 */
export default function RightRail({
  mediaId,
  analysisState,
  onRerunRules,
  onVerify,
  seams,
  effects,
}: {
  mediaId: string | null;
  analysisState: AnalysisState | null;
  onRerunRules: () => void;
  onVerify: () => void;
  seams: SeamInfo[];
  effects: AudioEffect[];
}) {
  const t = useT();
  const tab = useUi((s) => s.tab);
  const open = useUi((s) => s.railOpen);
  const width = useUi((s) => s.railWidth);
  const toggleTab = useUi((s) => s.toggleTab);
  const setRailOpen = useUi((s) => s.setRailOpen);
  const setRailWidth = useUi((s) => s.setRailWidth);
  const candidates = useDecisions((s) => (mediaId ? s.candidates[mediaId] ?? EMPTY : EMPTY));
  const decisions = useDecisions((s) => (mediaId ? s.decisions[mediaId] ?? EMPTY_D : EMPTY_D));
  const report = useVerify((s) => (mediaId ? s.byMedia[mediaId] ?? null : null));
  const splice = useVerify((s) => (mediaId ? s.spliceByMedia[mediaId] ?? null : null));

  const markers = useDecisions((s) => (mediaId ? s.markers[mediaId] ?? EMPTY_MK : EMPTY_MK));
  const todoOpen = markers.reduce((n, m) => n + (m.kind === "todo" && !m.done ? 1 : 0), 0);
  const pending = candidates.reduce((n, c) => n + ((decisions[c.id]?.state ?? "pending") === "pending" ? 1 : 0), 0);
  const conflicts = candidates.reduce((n, c) => n + (decisions[c.id]?.conflict ? 1 : 0), 0);
  const verifyBadge = report ? report.findings.filter((f) => !f.lowConfidence).length : splice ? splice.segments.length - splice.okCount : 0;

  const TABS: { id: RailTab; icon: typeof ListChecks; label: string; badge: number; tone: "warning" | "danger" | "neutral" }[] = [
    { id: "decisions", icon: ListChecks, label: t("決策"), badge: conflicts || pending, tone: conflicts ? "danger" : "warning" },
    { id: "index", icon: ListTree, label: t("索引"), badge: todoOpen, tone: "warning" },
    { id: "assistant", icon: Sparkles, label: t("AI 助手"), badge: 0, tone: "neutral" },
    { id: "verify", icon: ShieldCheck, label: t("驗收"), badge: verifyBadge, tone: "danger" },
  ];

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: PointerEvent) => setRailWidth(startW + (startX - ev.clientX));
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  };

  return (
    <div className="shrink-0 flex min-h-0">
      {open && (
        <div className="relative shrink-0 bg-panel border-l border-fg/10 flex flex-col min-h-0" style={{ width, minWidth: RAIL_LIMITS.min }}>
          <div onPointerDown={startResize} title={t("拖曳調整寬度")} className="absolute left-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent/40 z-10" />
          <div className="flex-1 min-h-0 flex flex-col">
            {tab === "decisions" && <DecisionPanel mediaId={mediaId} analysisState={analysisState} onRerunRules={onRerunRules} embedded />}
            {tab === "index" && <IndexPanel mediaId={mediaId} seams={seams} candidates={candidates} decisions={decisions} effects={effects} />}
            {tab === "assistant" && <AssistantPanel embedded />}
            {tab === "verify" && <VerifyTab mediaId={mediaId} onVerify={onVerify} />}
          </div>
        </div>
      )}
      {/* 分頁條永遠在，收合時就是一條窄軌 */}
      <div className="w-9 shrink-0 bg-bar border-l border-fg/10 flex flex-col items-center py-1.5 gap-1">
        {open && <IconButton icon={ChevronRight} label={t("收合側欄")} iconSize={15} box="w-7 h-7" onClick={() => setRailOpen(false)} />}
        {TABS.map((x) => (
          <button
            key={x.id}
            type="button"
            title={x.label}
            aria-pressed={open && tab === x.id}
            onClick={() => toggleTab(x.id)}
            className={`relative w-7 h-7 rounded-sm grid place-items-center ${open && tab === x.id ? "bg-accent/20 text-accent" : "text-fg/50 hover:bg-fg/5"}`}
          >
            <x.icon size={15} />
            {x.badge > 0 && (
              <span
                className={`absolute -top-0.5 -right-0.5 min-w-3.5 h-3.5 px-0.5 rounded-full text-[9px] leading-[14px] text-center ${x.tone === "danger" ? "bg-danger text-white" : "bg-warning text-black"}`}
              >
                {x.badge > 99 ? "99+" : x.badge}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 驗收分頁：報告摘要 + 開啟完整報告。詳細內容仍在 VerifyDialog（那裡有「聽 / 去修」）。 */
function VerifyTab({ mediaId, onVerify }: { mediaId: string | null; onVerify: () => void }) {
  const t = useT();
  const report = useVerify((s) => (mediaId ? s.byMedia[mediaId] ?? null : null));
  const splice = useVerify((s) => (mediaId ? s.spliceByMedia[mediaId] ?? null : null));
  const last = useVerify((s) => (mediaId ? s.lastOutput[mediaId] ?? null : null));

  return (
    <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3 text-sm">
      <div className="text-xs text-fg/45 uppercase tracking-wide">{t("驗收")}</div>
      {!last && <div className="text-xs text-fg/40 leading-relaxed">{t("輸出之後這裡會出現交付檢查、音訊比對與逐字比對的結果。")}</div>}
      {last && (
        <div className="text-[11px] text-fg/50 mono break-all">{last.path}</div>
      )}
      {splice && (
        <div className="rounded-sm border border-fg/10 p-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-fg/60">{t("音訊比對")}</span>
            <Badge tone={splice.okCount === splice.segments.length ? "success" : "warning"}>
              {splice.okCount} / {splice.segments.length}
            </Badge>
          </div>
          <div className="mt-1 text-[11px] text-fg/50">{splice.summary}</div>
        </div>
      )}
      {report && (
        <div className="rounded-sm border border-fg/10 p-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-fg/60">{t("逐字比對")}</span>
            <Badge tone={report.findings.length ? "warning" : "success"}>{Math.round(report.matchRate * 100)}%</Badge>
          </div>
          <div className="mt-1 text-[11px] text-fg/50">{report.summary}</div>
        </div>
      )}
      <button
        type="button"
        onClick={onVerify}
        disabled={!last}
        className="w-full h-7 text-xs rounded-sm border border-fg/15 hover:bg-fg/5 disabled:opacity-40"
      >
        {report || splice ? t("看完整報告") : t("用 ASR 驗收")}
      </button>
    </div>
  );
}

const EMPTY: never[] = [];
const EMPTY_D: DecisionMap = {};
const EMPTY_MK: Marker[] = [];
