import { useState } from "react";
import { Check, Play, X } from "lucide-react";
import { KIND_LABEL, type Candidate } from "../analysis/types";
import { useT } from "../i18n";
import { playRange } from "../preview/playerRef";
import { useDecisions } from "../store/decisions";
import { formatMs } from "../time";
import { Badge, Button, IconButton } from "../ui/index";
import type { CandidateGroup } from "./group";
import { sampleForAudition } from "./group";

const PAD_MS = 1200;
/** 整組決定前至少要抽聽幾筆。 */
export const AUDITION_REQUIRED = 3;

/**
 * 群組總覽：把重複的候選收成一列，一次決定一整組。
 *
 * 「就是 ×47」按一下就結束，但這也是最危險的操作 —— 47 筆裡只要有一筆是句子的主詞，
 * 剪掉就毀了。所以整組接受前強制抽聽 3 筆（首 / 中 / 尾，穩定不隨機）。
 */
export default function GroupBoard({
  mediaId,
  groups,
  onPick,
  onClose,
}: {
  mediaId: string;
  groups: CandidateGroup[];
  onPick: (c: Candidate) => void;
  onClose: () => void;
}) {
  const t = useT();
  const decisions = useDecisions((s) => s.decisions[mediaId] ?? {});
  const bulkIds = useDecisions((s) => s.bulkIds);
  const [auditioned, setAuditioned] = useState<Record<string, number>>({});

  const audition = (g: CandidateGroup) => {
    const picks = sampleForAudition(g, decisions, AUDITION_REQUIRED);
    const heard = auditioned[g.key] ?? 0;
    const c = picks[Math.min(heard, picks.length - 1)];
    if (!c) return;
    onPick(c);
    playRange(Math.max(0, c.startMs - PAD_MS), c.endMs + PAD_MS, { skip: true });
    setAuditioned((s) => ({ ...s, [g.key]: Math.min((s[g.key] ?? 0) + 1, picks.length) }));
  };

  const decideGroup = (g: CandidateGroup, state: "accepted" | "rejected") => {
    const ids = g.members.filter((c) => (decisions[c.id]?.state ?? "pending") === "pending").map((c) => c.id);
    if (!ids.length) return;
    bulkIds(mediaId, ids, state, t("整組{s}「{label}」×{n}", { s: state === "accepted" ? t("接受") : t("拒絕"), label: g.label, n: ids.length }));
  };

  return (
    <div className="max-h-72 overflow-auto border-b border-fg/10">
      <div className="sticky top-0 z-10 flex items-center gap-2 px-3 h-8 bg-elevated border-b border-fg/10 text-xs">
        <span className="text-fg/60">{t("群組總覽")}</span>
        <span className="text-fg/35">{t("整組接受前請先抽聽 {n} 筆", { n: AUDITION_REQUIRED })}</span>
        <IconButton icon={X} label={t("關閉（G）")} className="ml-auto" onClick={onClose} />
      </div>
      {groups.map((g) => {
        const picks = sampleForAudition(g, decisions, AUDITION_REQUIRED);
        const need = Math.min(AUDITION_REQUIRED, picks.length);
        const heard = Math.min(auditioned[g.key] ?? 0, need);
        const ready = heard >= need;
        return (
          <div key={g.key} className="flex items-center gap-2 px-3 py-1.5 border-b border-fg/5 text-xs hover:bg-fg/5">
            <Badge tone="neutral">{t(KIND_LABEL[g.kind])}</Badge>
            <span className="font-medium text-fg/90 truncate max-w-[14rem]" title={g.label}>
              {g.label}
            </span>
            <span className="mono text-fg/45 tabular-nums">×{g.members.length}</span>
            <span className="mono text-fg/30 tabular-nums">{(g.totalMs / 1000).toFixed(1)}s</span>
            {g.pending > 0 ? (
              <Badge tone="warning">{t("待決 {n}", { n: g.pending })}</Badge>
            ) : (
              <Badge tone="success">{t("已決定")}</Badge>
            )}
            <span className="mono text-[10px] text-fg/25 hidden md:inline">{g.members.slice(0, 3).map((c) => formatMs(c.startMs, { millis: false })).join(" ")}</span>
            <span className="ml-auto flex items-center gap-1">
              <Button size="sm" variant="ghost" icon={Play} onClick={() => audition(g)}>
                {t("抽聽")} {heard}/{need}
              </Button>
              <IconButton
                icon={Check}
                label={ready ? t("整組剪掉（{n}）", { n: g.pending }) : t("先抽聽 {n} 筆才能整組剪掉", { n: need })}
                disabled={!g.pending || !ready}
                onClick={() => decideGroup(g, "accepted")}
              />
              <IconButton icon={X} label={t("整組留著（{n}）", { n: g.pending })} disabled={!g.pending} onClick={() => decideGroup(g, "rejected")} />
            </span>
          </div>
        );
      })}
    </div>
  );
}
