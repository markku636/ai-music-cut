import { useEffect, useState } from "react";
import { History, RotateCcw } from "lucide-react";
import { currentIndex, historyRows, relativeTime } from "../analysis/history";
import { Button, EmptyState } from "../ui/index";
import { useT } from "../i18n";
import { useDecisions } from "../store/decisions";

/**
 * 歷史記錄（Audition / Premiere / Photoshop 都有的那個面板）。
 *
 * 每一次改動本來就存成帶標籤的快照，但只能一步一步倒退。「一鍵粗剪」一次做六件事、
 * 批次一次跑好幾集之後，想退回其中第三步得按六次 Ctrl+Z，而且按的過程中
 * 根本看不出退到哪了 —— 攤成可以點的清單就解決了。
 *
 * 已經被復原的那幾列**留著**（畫成灰的），因為那正是「重做」要點的東西；
 * 一有新的改動它們才會被丟掉，這跟 Ctrl+Z 之後再動一下就回不去是同一件事。
 */
export default function HistoryPanel() {
  const past = useDecisions((s) => s.past);
  const future = useDecisions((s) => s.future);
  const jumpTo = useDecisions((s) => s.jumpTo);
  const t = useT();
  const [now, setNow] = useState(() => Date.now());

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
          <button
            key={r.index}
            type="button"
            onClick={() => jumpTo(r.index)}
            aria-current={r.current || undefined}
            className={`flex w-full items-baseline gap-2 px-2 py-1 text-left text-[12px] ${
              r.current ? "bg-accent/15 text-accent" : r.undone ? "text-fg/30 hover:bg-fg/5" : "text-fg/75 hover:bg-fg/5"
            }`}
          >
            <span className="w-6 shrink-0 text-right tabular-nums text-[10px] text-fg/30">{r.index || "–"}</span>
            <span className="min-w-0 flex-1 truncate">{r.index === 0 ? t("開啟時的狀態") : r.label}</span>
            {r.at != null && <span className="shrink-0 text-[10px] tabular-nums text-fg/30">{relativeTime(r.at, now)}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
