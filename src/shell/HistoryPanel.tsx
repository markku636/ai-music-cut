import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, History, RotateCcw, Undo2 } from "lucide-react";
import { currentIndex, historyRows, relativeTime } from "../analysis/history";
import { audibleChanges, canPartiallyRevert, diffDecisions } from "../analysis/stepDiff";
import { KIND_LABEL } from "../analysis/types";

const EMPTY_CANDS: Candidate[] = [];
import { useProject } from "../store/project";
import { formatMs } from "../time";
import { Button, EmptyState } from "../ui/index";
import { useT } from "../i18n";
import { useDecisions, type Patch } from "../store/decisions";
import type { Candidate } from "../analysis/types";

/**
 * 歷史記錄（Audition / Premiere / Photoshop 都有的那個面板）。
 *
 * 每一次改動本來就存成帶標籤的快照，但只能一步一步倒退。「一鍵粗剪」一次做六件事、
 * 批次一次跑好幾集之後，想退回其中第三步得按六次 Ctrl+Z，而且按的過程中
 * 根本看不出退到哪了 —— 攤成可以點的清單就解決了。
 *
 * 已經被復原的那幾列**留著**（畫成灰的），因為那正是「重做」要點的東西；
 * 一有新的改動它們才會被丟掉，這跟 Ctrl+Z 之後再動一下就回不去是同一件事。
 *
 * 每一列可以展開看「這一步改了哪幾筆」，並且**只還原其中幾筆**：
 * 「一鍵粗剪」一次剪掉六類、「全部剪掉『呃』」一次處理 23 筆 —— 整步還原會把
 * 對的那 20 筆也一起丟掉，只好整步退回去再手動重做一遍。
 */
export default function HistoryPanel() {
  const past = useDecisions((s) => s.past);
  const future = useDecisions((s) => s.future);
  const jumpTo = useDecisions((s) => s.jumpTo);
  const revertPart = useDecisions((s) => s.revertPart);
  const mediaId = useProject((s) => s.activeMediaId);
  const candidates = useDecisions((s) => (mediaId ? s.candidates[mediaId] : undefined));
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  const [openStep, setOpenStep] = useState<number | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());

  // 歷史一變就把展開的收起來：openStep 是「第幾列」，undo / redo 之後列會位移，
  // 留著舊的值會指到另一個步驟 —— 使用者看到的是「展開的明細突然變成別人的」
  useEffect(() => {
    setOpenStep(null);
    setPicked(new Set());
  }, [past.length, future.length]);

  // 相對時間要會走，否則「剛剛」會一直停在那裡
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);

  const rows = historyRows(past, future);
  const cur = currentIndex(past);

  if (rows.length <= 1) {
    return (
      <EmptyState
        icon={History}
        title={t("還沒有任何改動")}
        hint={t("剪掉一段、接受一筆候選或跑一次粗剪之後，這裡會列出每一步，點一下就跳回去。")}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-fg/8 px-2 py-1.5 text-[11px] text-fg/45">
        <span>{t("{n} 步", { n: rows.length - 1 })}</span>
        {future.length > 0 && <span className="text-fg/35">{t("（{n} 步可重做）", { n: future.length })}</span>}
        <Button
          size="sm"
          variant="ghost"
          icon={RotateCcw}
          className="ml-auto"
          disabled={cur === 0}
          onClick={() => jumpTo(0)}
          title={t("回到最初（可以再點回來）")}
        >
          {t("回到最初")}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* 最新的排在最上面：想退回的通常是剛剛做的那幾步 */}
        {[...rows].reverse().map((r) => (
          <div key={r.index}>
            <div
              className={`flex w-full items-baseline gap-1 px-2 py-1 text-left text-[12px] ${
                r.current ? "bg-accent/15 text-accent" : r.undone ? "text-fg/30 hover:bg-fg/5" : "text-fg/75 hover:bg-fg/5"
              }`}
            >
              {r.index > 0 ? (
                <button
                  type="button"
                  aria-label={t("看這一步改了什麼")}
                  title={t("看這一步改了什麼")}
                  onClick={() => {
                    setOpenStep(openStep === r.index ? null : r.index);
                    setPicked(new Set());
                  }}
                  className="w-4 shrink-0 text-fg/30 hover:text-fg/70"
                >
                  {openStep === r.index ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                </button>
              ) : (
                <span className="w-4 shrink-0" />
              )}
              <button type="button" onClick={() => jumpTo(r.index)} aria-current={r.current || undefined} className="flex min-w-0 flex-1 items-baseline gap-2 text-left">
                <span className="w-5 shrink-0 text-right tabular-nums text-[10px] text-fg/30">{r.index || "–"}</span>
                <span className="min-w-0 flex-1 truncate">{r.index === 0 ? t("開啟時的狀態") : r.label}</span>
                {r.at != null && <span className="shrink-0 text-[10px] tabular-nums text-fg/30">{relativeTime(r.at, now)}</span>}
              </button>
            </div>
            {openStep === r.index && (
              <StepDetail
                index={r.index}
                past={past}
                future={future}
                candidates={candidates ?? EMPTY_CANDS}
                picked={picked}
                setPicked={setPicked}
                revertPart={revertPart}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 一步的明細。**必須放在模組層**：定義在 HistoryPanel 裡的話，每次重繪都是一個新的
 * 元件型別，React 會把整棵子樹卸載重掛 —— 展開會閃、勾選狀態也留不住。
 */
function StepDetail({
  index,
  past,
  future,
  candidates,
  picked,
  setPicked,
  revertPart,
}: {
  index: number;
  past: Patch[];
  future: Patch[];
  candidates: Candidate[];
  picked: Set<string>;
  setPicked: React.Dispatch<React.SetStateAction<Set<string>>>;
  revertPart: (stepIndex: number, ids: string[]) => void;
}) {
  const t = useT();
  const all = [...past, ...[...future].reverse()];
  const patch = all[index - 1];
  if (!patch) return null;
  const changes = audibleChanges(diffDecisions(patch.before.decisions, patch.after.decisions, candidates));
  if (changes.length === 0) {
    return <div className="px-8 py-1 text-[11px] text-fg/35">{t("這一步沒有改到「剪不剪」（可能只動了效果或標記）。")}</div>;
  }
  const byId = new Map(candidates.map((c) => [c.id, c]));
  return (
    <div className="border-l-2 border-fg/10 ml-4 pl-2 py-1 space-y-0.5">
      {changes.slice(0, 40).map((c) => {
        const cand = byId.get(c.id);
        return (
          <label key={c.id} className="flex items-center gap-1.5 px-1 py-0.5 text-[11px] hover:bg-fg/5 cursor-pointer">
            <input
              type="checkbox"
              checked={picked.has(c.id)}
              onChange={() =>
                setPicked((s2) => {
                  const n = new Set(s2);
                  if (n.has(c.id)) n.delete(c.id);
                  else n.add(c.id);
                  return n;
                })
              }
            />
            <span className={c.isCut ? "text-danger/80" : "text-success/80"}>{c.isCut ? t("剪") : t("留")}</span>
            <span className="min-w-0 flex-1 truncate text-fg/60">
              {cand ? `${t(KIND_LABEL[cand.kind])} · ${formatMs(cand.startMs, { millis: false })}` : c.id}
            </span>
          </label>
        );
      })}
      {changes.length > 40 && <div className="px-1 text-[10px] text-fg/30">{t("還有 {n} 筆…", { n: changes.length - 40 })}</div>}
      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          className="text-[11px] text-fg/40 hover:text-fg/70"
          onClick={() => setPicked(new Set(picked.size === changes.length ? [] : changes.map((c) => c.id)))}
        >
          {picked.size === changes.length ? t("全部取消") : t("全選")}
        </button>
        <Button
          size="sm"
          variant="ghost"
          icon={Undo2}
          className="ml-auto"
          disabled={picked.size === 0 || !canPartiallyRevert(changes)}
          title={canPartiallyRevert(changes) ? undefined : t("這一步只改了一筆，直接點那一列還原就好")}
          onClick={() => {
            revertPart(index, [...picked]);
            setPicked(new Set());
          }}
        >
          {t("還原選取的（{n}）", { n: picked.size })}
        </Button>
      </div>
    </div>
  );
  }
