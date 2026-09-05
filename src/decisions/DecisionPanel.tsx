import { useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight, ListChecks, Play, X } from "lucide-react";
import { candidateText } from "./group";
import { useTranscript } from "../store/transcript";
import { KIND_LABEL, isActiveState, type Candidate, type CandidateKind, type DecisionState } from "../analysis/types";
import { useT } from "../i18n";
import { playRange } from "../preview/playerRef";
import { decisionCounts, useDecisions } from "../store/decisions";
import { usePlayback } from "../store/playback";
import { useProject } from "../store/project";
import { formatMs } from "../time";
import { Badge, EmptyState, IconButton, Segmented, Spinner } from "../ui/index";
import type { AnalysisState } from "../store/project";

const PANEL_KEY = "aicut:decisionsOpen";
const WIDTH_KEY = "aicut:decisionsWidth";
const WIDTH_MIN = 240;
const WIDTH_MAX = 560;
const WIDTH_DEFAULT = 300;

const KIND_ORDER: CandidateKind[] = ["filler", "stutter", "restart", "long_pause", "noise", "unclear", "rambling", "off_topic", "redo", "manual"];
const KIND_CLASS: Record<CandidateKind, string> = {
  filler: "bg-kind-filler/20 text-kind-filler",
  stutter: "bg-kind-stutter/20 text-kind-stutter",
  restart: "bg-kind-stutter/20 text-kind-stutter",
  long_pause: "bg-kind-pause/20 text-kind-pause",
  noise: "bg-kind-noise/20 text-kind-noise",
  unclear: "bg-kind-unclear/20 text-kind-unclear",
  rambling: "bg-kind-unclear/20 text-kind-unclear",
  off_topic: "bg-kind-unclear/20 text-kind-unclear",
  redo: "bg-kind-unclear/20 text-kind-unclear",
  manual: "bg-kind-manual/20 text-kind-manual",
};

type StateFilter = "all" | "active" | "pending" | "rejected";

export default function DecisionPanel({ mediaId, analysisState, onRerunRules }: { mediaId: string | null; analysisState: AnalysisState | null; onRerunRules: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(PANEL_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const toggle = () =>
    setOpen((v) => {
      try {
        localStorage.setItem(PANEL_KEY, v ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !v;
    });
  const [width, setWidth] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(WIDTH_KEY));
      return v >= WIDTH_MIN && v <= WIDTH_MAX ? v : WIDTH_DEFAULT;
    } catch {
      return WIDTH_DEFAULT;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      /* ignore */
    }
  }, [width]);
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: PointerEvent) => setWidth(Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, startW + (startX - ev.clientX))));
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

  const candidates = useDecisions((s) => (mediaId ? s.candidates[mediaId] ?? EMPTY_C : EMPTY_C));
  const decisions = useDecisions((s) => (mediaId ? s.decisions[mediaId] ?? EMPTY_D : EMPTY_D));
  const selectedIds = useDecisions((s) => s.selectedIds);
  const select = useDecisions((s) => s.select);
  const decide = useDecisions((s) => s.decide);
  const bulkIds = useDecisions((s) => s.bulkIds);
  const setReviewing = useDecisions((s) => s.setReviewing);
  const words = useTranscript((s) => (mediaId ? s.byMedia[mediaId]?.words ?? EMPTY_W : EMPTY_W));
  const aggressiveness = useProject((s) => s.aggressiveness);
  const setAggressiveness = useProject((s) => s.setAggressiveness);
  const seek = usePlayback((s) => s.seek);
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [kindFilter, setKindFilter] = useState<Set<CandidateKind>>(new Set());
  const [aggrDraft, setAggrDraft] = useState(aggressiveness);
  useEffect(() => setAggrDraft(aggressiveness), [aggressiveness]);

  const counts = useMemo(() => decisionCounts(candidates, decisions), [candidates, decisions]);
  const removedMs = useMemo(
    () => candidates.reduce((s, c) => (isActiveState(decisions[c.id]?.state) ? s + (c.endMs - c.startMs) : s), 0),
    [candidates, decisions],
  );
  const visible = useMemo(
    () =>
      candidates.filter((c) => {
        const st = decisions[c.id]?.state ?? "pending";
        if (stateFilter === "active" && !isActiveState(st)) return false;
        if (stateFilter === "pending" && st !== "pending") return false;
        if (stateFilter === "rejected" && st !== "rejected") return false;
        if (kindFilter.size && !kindFilter.has(c.kind)) return false;
        return true;
      }),
    [candidates, decisions, stateFilter, kindFilter],
  );

  if (!open) {
    return (
      <div className="w-7 shrink-0 bg-panel border-l border-fg/10 flex flex-col items-center pt-2">
        <IconButton icon={ChevronLeft} label={t("顯示決策面板")} iconSize={16} box="w-6 h-6" onClick={toggle} />
        <div className="mt-3 text-[10px] text-fg/30 tracking-wide [writing-mode:vertical-rl]">{t("決策")}</div>
      </div>
    );
  }

  const onRow = (c: Candidate) => {
    select([c.id]);
    seek(Math.max(0, c.startMs - 300));
  };
  const preview = (c: Candidate) => {
    const active = isActiveState(decisions[c.id]?.state);
    select([c.id]);
    playRange(c.startMs - 1000, c.endMs + 1000, { skip: active });
  };

  return (
    <div className="shrink-0 bg-panel border-l border-fg/10 flex flex-col text-sm relative min-h-0" style={{ width }}>
      <div onPointerDown={startResize} title={t("拖曳調整寬度")} className="absolute left-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent/40 z-10" />
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-fg/10">
        <span className="text-xs text-fg/45 uppercase tracking-wide">{t("決策")}</span>
        <span className="text-[11px] text-fg/40 mono">
          {counts.total} · −{(removedMs / 1000).toFixed(1)}s
        </span>
        <IconButton icon={ChevronRight} label={t("收合面板")} iconSize={16} box="w-6 h-6" onClick={toggle} className="ml-auto" />
      </div>

      <div className="px-3 py-2 border-b border-fg/10 space-y-2">
        <div className="flex items-center justify-between text-[11px] text-fg/50">
          <span>{t("激進度")}</span>
          <span className="mono">{aggrDraft}</span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={aggrDraft}
          disabled={!mediaId || analysisState !== "ready"}
          title={analysisState !== "ready" ? t("分析後可調") : undefined}
          onChange={(e) => setAggrDraft(Number(e.target.value))}
          onPointerUp={() => {
            if (aggrDraft !== aggressiveness) {
              setAggressiveness(aggrDraft);
              onRerunRules();
            }
          }}
          onKeyUp={() => {
            if (aggrDraft !== aggressiveness) {
              setAggressiveness(aggrDraft);
              onRerunRules();
            }
          }}
          className="w-full accent-[rgb(var(--c-accent))]"
          aria-label={t("激進度")}
        />
        <Segmented<StateFilter>
          size="sm"
          full
          value={stateFilter}
          onChange={setStateFilter}
          options={[
            { value: "all", label: t("全部") },
            { value: "active", label: `${t("剪")} ${counts.byState.auto + counts.byState.accepted}` },
            { value: "pending", label: `${t("待決")} ${counts.byState.pending}` },
            { value: "rejected", label: `${t("拒")} ${counts.byState.rejected}` },
          ]}
        />
        <div className="flex flex-wrap gap-1">
          {KIND_ORDER.filter((k) => counts.byKind[k]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() =>
                setKindFilter((s) => {
                  const n = new Set(s);
                  if (n.has(k)) n.delete(k);
                  else n.add(k);
                  return n;
                })
              }
              className={`text-[11px] px-1.5 py-0.5 rounded-xs border ${kindFilter.has(k) ? "border-accent " + KIND_CLASS[k] : "border-fg/10 text-fg/50 hover:bg-fg/5"}`}
            >
              {t(KIND_LABEL[k])} {counts.byKind[k]}
            </button>
          ))}
        </div>
        <button
          type="button"
          disabled={!mediaId || !counts.byState.pending}
          onClick={() => setReviewing(true)}
          title={t("一次一筆、鍵盤決定並自動前進（Esc 離開）")}
          className="w-full h-7 text-xs rounded-sm bg-accent/15 border border-accent/40 text-accent hover:bg-accent/25 disabled:opacity-40 disabled:border-fg/10 disabled:text-fg/40 disabled:bg-transparent"
        >
          {t("開始審核（{n} 筆待決）", { n: counts.byState.pending })}
        </button>
        <div className="flex gap-1">
          <button
            type="button"
            disabled={!mediaId || !visible.length}
            onClick={() => mediaId && bulkIds(mediaId, visible.map((c) => c.id), "accepted", t("批次接受"))}
            className="flex-1 h-7 text-xs rounded-sm border border-fg/10 hover:bg-success/10 text-fg/70 disabled:opacity-40"
          >
            {t("全部接受（{n}）", { n: visible.length })}
          </button>
          <button
            type="button"
            disabled={!mediaId || !visible.length}
            onClick={() => mediaId && bulkIds(mediaId, visible.map((c) => c.id), "rejected", t("批次拒絕"))}
            className="flex-1 h-7 text-xs rounded-sm border border-fg/10 hover:bg-danger/10 text-fg/70 disabled:opacity-40"
          >
            {t("全部拒絕（{n}）", { n: visible.length })}
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {!mediaId || !candidates.length ? (
          analysisState === "analyzing" ? (
            <EmptyState compact icon={ListChecks} title={<span className="inline-flex items-center gap-2"><Spinner size={12} />{t("分析中…")}</span>} hint={t("逐字稿與候選會在轉寫完成後出現")} />
          ) : analysisState === "ready" ? (
            <EmptyState compact icon={ListChecks} title={t("沒有找到可剪的段落")} hint={t("調高激進度會放寬門檻；也可以在波形上用「選取」工具拖選一段手動剪。")} />
          ) : (
            <EmptyState
              compact
              icon={ListChecks}
              title={t("分析後這裡列出候選")}
              hint={
                <span className="inline-flex flex-wrap justify-center gap-1">
                  {(["filler", "stutter", "long_pause", "unclear", "noise", "manual"] as CandidateKind[]).map((k) => (
                    <span key={k} className={`text-[10px] px-1.5 py-0.5 rounded-xs ${KIND_CLASS[k]}`}>
                      {t(KIND_LABEL[k])}
                    </span>
                  ))}
                  <span className="basis-full text-fg/35 mt-1">{t("逐一接受或拒絕；波形上拖選一段也能手動剪。")}</span>
                </span>
              }
            />
          )
        ) : (
          visible.map((c) => {
            const d = decisions[c.id];
            const st: DecisionState = d?.state ?? "pending";
            const selected = selectedIds.includes(c.id);
            return (
              <div
                key={c.id}
                data-cid={c.id}
                onClick={() => onRow(c)}
                className={`px-3 py-2 border-b border-fg/5 cursor-pointer ${selected ? "bg-accent/12" : "hover:bg-fg/5"} ${st === "rejected" ? "opacity-50" : ""}`}
              >
                <div className="flex items-center gap-1.5">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-xs ${KIND_CLASS[c.kind]}`}>{t(KIND_LABEL[c.kind])}</span>
                  <span className="mono text-[11px] text-fg/45">{formatMs(c.startMs, { millis: false })}</span>
                  <span className="mono text-[10px] text-fg/30">{((c.endMs - c.startMs) / 1000).toFixed(2)}s</span>
                  <span className="mono text-[10px] text-fg/25" title={t("規則分數（越高越該剪）")}>
                    {c.score.toFixed(2)}
                  </span>
                  <Badge tone={st === "auto" ? "accent" : st === "accepted" ? "success" : st === "rejected" ? "neutral" : "warning"} className="ml-auto">
                    {t(st === "auto" ? "自動" : st === "accepted" ? "接受" : st === "rejected" ? "拒絕" : "待決")}
                  </Badge>
                </div>
                {(() => {
                  const text = candidateText(c, words);
                  return text ? <div className="mt-1 text-sm text-fg/90 leading-snug break-words line-clamp-1">「{text}」</div> : null;
                })()}
                <div className="mt-0.5 text-xs text-fg/60 leading-snug line-clamp-2">{c.reason}</div>
                {d?.reason && d.origin === "llm" && <div className="mt-0.5 text-[11px] text-info/80">AI：{d.reason}</div>}
                <div className="mt-1.5 flex items-center gap-1">
                  <IconButton icon={Play} label={t("預聽")} iconSize={13} box="w-6 h-6" onClick={(e) => { e.stopPropagation(); preview(c); }} />
                  <IconButton
                    icon={Check}
                    label={t("接受（A）")}
                    iconSize={13}
                    box="w-6 h-6"
                    active={isActiveState(st)}
                    className="ml-auto"
                    onClick={(e) => {
                      e.stopPropagation();
                      decide(mediaId, [c.id], "accepted");
                    }}
                  />
                  <IconButton
                    icon={X}
                    label={t("拒絕（R）")}
                    iconSize={13}
                    box="w-6 h-6"
                    active={st === "rejected"}
                    onClick={(e) => {
                      e.stopPropagation();
                      decide(mediaId, [c.id], "rejected");
                    }}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

const EMPTY_C: Candidate[] = [];
const EMPTY_W: never[] = [];
const EMPTY_D: Record<string, never> = {};
