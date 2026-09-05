import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Layers, ListChecks, Play, Undo2, X } from "lucide-react";
import { edlFor } from "../pipeline/rules";
import { isActiveState, KIND_LABEL, type Candidate } from "../analysis/types";
import { useT } from "../i18n";
import { playRange, stopRange } from "../preview/playerRef";
import { useDecisions } from "../store/decisions";
import { useProject } from "../store/project";
import { useTranscript } from "../store/transcript";
import { formatMs } from "../time";
import { Badge, Button, IconButton } from "../ui/index";
import GroupBoard from "./GroupBoard";
import OpinionChips from "./OpinionChips";
import { buildGroups, candidateText, groupKeyOf } from "./group";
import { advanceAfterDecision, queueProgress, reviewQueue, stepQueue } from "./queue";
import { installReviewHotkeys } from "./reviewHotkeys";

/** 預聽時前後各留這麼多秒，才聽得出前後文。 */
const PAD_MS = 1200;

/**
 * 審核模式：一次只看一筆，鍵盤決定並自動前進。
 *
 * 為什麼不是對話框：這是一個「工作模式」，波形與逐字稿還要看得到，而且不能讓
 * body.dataset.modalCount 把全域快捷鍵全部關掉。所以是釘在主區底部的一條工作列。
 */
export default function ReviewMode({ mediaId, onExit }: { mediaId: string; onExit: () => void }) {
  const t = useT();
  const candidates = useDecisions((s) => s.candidates[mediaId] ?? EMPTY);
  const decisions = useDecisions((s) => s.decisions[mediaId] ?? EMPTY_D);
  const decide = useDecisions((s) => s.decide);
  const bulkIds = useDecisions((s) => s.bulkIds);
  const undo = useDecisions((s) => s.undo);
  const select = useDecisions((s) => s.select);
  const aggressiveness = useProject((s) => s.aggressiveness);
  const words = useTranscript((s) => s.byMedia[mediaId]?.words ?? EMPTY_W);
  const sentences = useTranscript((s) => s.byMedia[mediaId]?.sentences ?? EMPTY_S);

  const [curId, setCurId] = useState<string | null>(null);
  const [showGroups, setShowGroups] = useState(false);
  const startedAt = useRef(Date.now());
  const initialTotal = useRef(0);

  // 被自然度守門降級的候選也要人看一眼（AI 想剪、規則擋下來）
  // edlFor 從 store 直接讀，lint 看不出依賴；這些 dep 就是「該重算」的訊號。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const downgrades = useMemo(() => edlFor(mediaId)?.downgrades ?? null, [mediaId, candidates, decisions, aggressiveness]);

  // 兩個 agent 意見相反的一定要人裁決（resolveOpinions 已經把它留在 pending，這裡確保不會被漏掉）
  const conflictIds = useMemo(() => new Set(candidates.filter((c) => decisions[c.id]?.conflict).map((c) => c.id)), [candidates, decisions]);
  const queue = useMemo(() => reviewQueue(candidates, decisions, { downgrades, conflictIds }), [candidates, decisions, downgrades, conflictIds]);
  const groups = useMemo(() => buildGroups(candidates, words, decisions), [candidates, words, decisions]);

  useEffect(() => {
    initialTotal.current = queue.length;
    startedAt.current = Date.now();
    // 只在進入模式時抓一次基準
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaId]);

  const cur = useMemo(() => queue.find((c) => c.id === curId) ?? queue[0] ?? null, [queue, curId]);
  const curGroup = useMemo(() => (cur ? groups.find((g) => g.key === groupKeyOf(cur, words)) ?? null : null), [cur, groups, words]);

  const goto = useCallback(
    (c: Candidate | null) => {
      setCurId(c?.id ?? null);
      if (c) select([c.id]);
    },
    [select],
  );

  // 進到每一筆自動預聽「剪掉之後」的接法 —— 審核要判斷的是接起來順不順，不是那個字本身
  const playCut = useCallback(() => {
    if (!cur) return;
    playRange(Math.max(0, cur.startMs - PAD_MS), cur.endMs + PAD_MS, { skip: true });
  }, [cur]);
  const playSrc = useCallback(() => {
    if (!cur) return;
    playRange(Math.max(0, cur.startMs - PAD_MS), cur.endMs + PAD_MS, { skip: false });
  }, [cur]);

  useEffect(() => {
    if (cur) playCut();
    return () => stopRange();
  }, [cur?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const decideAndAdvance = useCallback(
    (state: "accepted" | "rejected") => {
      if (!cur) return;
      const before = queue;
      decide(mediaId, [cur.id], state);
      // 決定後佇列會少一筆；用決定前的順序找出「下一個還在的」
      const after = before.filter((c) => c.id !== cur.id);
      goto(advanceAfterDecision(before, after, cur.id));
    },
    [cur, queue, decide, mediaId, goto],
  );

  const decideGroup = useCallback(
    (state: "accepted" | "rejected") => {
      if (!cur || !curGroup) return;
      const ids = curGroup.members.filter((c) => (decisions[c.id]?.state ?? "pending") === "pending").map((c) => c.id);
      if (!ids.length) return;
      const before = queue;
      bulkIds(mediaId, ids, state, t("整組{s}「{label}」×{n}", { s: state === "accepted" ? t("接受") : t("拒絕"), label: curGroup.label, n: ids.length }));
      const gone = new Set(ids);
      goto(advanceAfterDecision(before, before.filter((c) => !gone.has(c.id)), cur.id));
    },
    [cur, curGroup, decisions, queue, bulkIds, mediaId, goto, t],
  );

  useEffect(
    () =>
      installReviewHotkeys({
        accept: () => decideAndAdvance("accepted"),
        reject: () => decideAndAdvance("rejected"),
        acceptGroup: () => decideGroup("accepted"),
        rejectGroup: () => decideGroup("rejected"),
        next: () => goto(stepQueue(queue, cur?.id ?? null, 1)),
        prev: () => goto(stepQueue(queue, cur?.id ?? null, -1)),
        playCut,
        playSrc,
        undo: () => undo(),
        toggleGroups: () => setShowGroups((v) => !v),
        exit: onExit,
      }),
    [decideAndAdvance, decideGroup, goto, queue, cur?.id, playCut, playSrc, undo, onExit],
  );

  const prog = queueProgress(initialTotal.current, queue.length, Date.now() - startedAt.current);
  const text = cur ? candidateText(cur, words) : "";
  const sentence = useMemo(() => {
    if (!cur) return "";
    const s = sentences.find((x) => x.id === cur.sentenceId);
    if (!s) return "";
    const byId = new Map(words.map((w) => [w.id, w]));
    const cut = new Set(cur.wordIds);
    return s.wordIds.map((id) => (cut.has(id) ? `〖${byId.get(id)?.text ?? ""}〗` : byId.get(id)?.text ?? "")).join("");
  }, [cur, sentences, words]);

  return (
    <div className="shrink-0 border-t border-accent/30 bg-elevated/95">
      {showGroups && <GroupBoard mediaId={mediaId} groups={groups} onPick={(c) => { setShowGroups(false); goto(c); }} onClose={() => setShowGroups(false)} />}
      <div className="flex items-center gap-3 px-3 h-9 border-b border-fg/10 text-xs">
        <span className="shrink-0 whitespace-nowrap inline-flex items-center gap-1.5 text-accent">
          <ListChecks size={14} />
          {t("審核模式")}
        </span>
        <span className="shrink-0 whitespace-nowrap mono text-fg/60 tabular-nums">
          {prog.done} / {prog.total}
          {prog.rate != null && ` · ${prog.rate.toFixed(1)} ${t("筆/秒")}`}
        </span>
        <span className="min-w-0 flex-1 truncate text-fg/35">
          {t("A 接受 · R 拒絕 · Shift+A/R 整組 · Space 重播 · J/K 移動 · U 復原 · G 群組 · Esc 離開")}
        </span>
        <IconButton icon={Layers} label={t("群組總覽（G）")} active={showGroups} className="shrink-0" onClick={() => setShowGroups((v) => !v)} />
        <IconButton icon={Undo2} label={t("復原（U）")} className="shrink-0" onClick={() => undo()} />
        <IconButton icon={X} label={t("離開審核模式（Esc）")} className="shrink-0" onClick={onExit} />
      </div>

      {!cur ? (
        <div className="px-4 py-6 text-center text-sm text-fg/50">
          {t("待決的候選都處理完了。")}
          <Button size="sm" variant="ghost" className="ml-2" onClick={onExit}>
            {t("離開")}
          </Button>
        </div>
      ) : (
        <div className="px-4 py-3 flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[11px]">
              <Badge tone="neutral">{t(KIND_LABEL[cur.kind])}</Badge>
              <span className="mono text-fg/45">{formatMs(cur.startMs, { millis: false })}</span>
              <span className="mono text-fg/30">{((cur.endMs - cur.startMs) / 1000).toFixed(2)}s</span>
              <span className="mono text-fg/30">score {cur.score.toFixed(2)}</span>
              {curGroup && curGroup.members.length > 1 && (
                <span className="text-fg/45">
                  {t("同組還有 {n} 筆", { n: curGroup.pending })}
                </span>
              )}
              {downgrades?.some((d) => d.candidateId === cur.id) && <Badge tone="warning">{t("被守門降級")}</Badge>}
              {decisions[cur.id]?.conflict && <Badge tone="warning">{t("兩個 AI 意見相反")}</Badge>}
            </div>
            <div className="mt-1.5 text-lg leading-snug text-fg/90 break-words">
              {sentence || <span className="text-fg/45">{text || cur.reason}</span>}
            </div>
            <div className="mt-1 text-xs text-fg/50">{cur.reason}</div>
            <OpinionChips decision={decisions[cur.id]} />
          </div>
          <div className="shrink-0 flex flex-col gap-1.5 items-stretch w-56">
            <div className="flex gap-1.5">
              <Button size="sm" variant="primary" icon={Check} className="flex-1 whitespace-nowrap" onClick={() => decideAndAdvance("accepted")}>
                {t("剪掉")} <span className="opacity-60 ml-1">A</span>
              </Button>
              <Button size="sm" variant="ghost" icon={X} className="flex-1 whitespace-nowrap" onClick={() => decideAndAdvance("rejected")}>
                {t("留著")} <span className="opacity-60 ml-1">R</span>
              </Button>
            </div>
            {curGroup && curGroup.pending > 1 && (
              <div className="flex gap-1.5">
                <Button size="sm" variant="ghost" className="flex-1 text-[11px] whitespace-nowrap" onClick={() => decideGroup("accepted")}>
                  {t("整組剪（{n}）", { n: curGroup.pending })}
                </Button>
                <Button size="sm" variant="ghost" className="flex-1 text-[11px] whitespace-nowrap" onClick={() => decideGroup("rejected")}>
                  {t("整組留")}
                </Button>
              </div>
            )}
            <Button size="sm" variant="ghost" icon={Play} className="whitespace-nowrap" onClick={playCut}>
              {t("重播剪後")} <span className="opacity-60 ml-1">Space</span>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const EMPTY: Candidate[] = [];
const EMPTY_D = {};
const EMPTY_W: never[] = [];
const EMPTY_S: never[] = [];

/** 目前這筆是否已經是「會剪掉」的狀態（給外部標示用）。 */
export function isCut(state: string | undefined): boolean {
  return isActiveState(state as never);
}
