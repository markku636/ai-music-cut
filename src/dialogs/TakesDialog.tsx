import { useMemo, useState } from "react";
import { Check, Layers, Play } from "lucide-react";
import { savedMsOf } from "../analysis/takes";
import { useT } from "../i18n";
import { keepTake, takesFor } from "../pipeline/takes";
import { playRange, stopRange } from "../preview/playerRef";
import { useDecisions } from "../store/decisions";
import { usePlayback } from "../store/playback";
import { Button, EmptyState, Modal } from "../ui/index";
import { toast } from "../ui";
import { formatMs } from "../time";

/**
 * 替代 take（Final Cut 的 Audition）。
 *
 * 一個人錄音講壞了，最常見的反應不是說「等一下重講」（那個規則層已經在抓了），
 * 而是停半秒**直接再講一次**。錄完一集下來同一句有兩三個版本散在裡面，
 * 要一句一句聽過再決定留哪個 —— 這正是 Final Cut 的 Audition 在做的事。
 *
 * 這個對話框只做三件事：把幾次嘗試並排、讓你各聽一次、挑一個留下。
 *
 * **預設留最後一次**，因為會再講一遍就是因為前面那次不滿意。但那只是預設值 ——
 * 有時候第一次講得最自然，後面越講越僵。所以每一次都能單獨試聽，按鈕上寫的是
 * 「留這次」而不是「接受建議」。
 *
 * **剪掉的是一整句真正的內容**，不是贅字。所以：一次 undo 就全還原、
 * 索引超出範圍時什麼都不做、按下去之後會說清楚剪了幾段省了多久。
 */
export default function TakesDialog({ mediaId, onClose }: { mediaId: string | null; onClose: () => void }) {
  const t = useT();
  const seek = usePlayback((s) => s.seek);
  // 決策一變就重算「已經剪掉的不再顯示」
  const decisions = useDecisions((s) => (mediaId ? s.decisions[mediaId] : undefined));
  const candidates = useDecisions((s) => (mediaId ? s.candidates[mediaId] : undefined));
  const [done, setDone] = useState<Set<string>>(new Set());
  const [playing, setPlaying] = useState<string | null>(null);

  const groups = useMemo(() => (mediaId ? takesFor(mediaId) : []), [mediaId]);
  // 這一組已經處理過（這一輪按過、或本來就被剪掉了）就不再擋路
  const open = useMemo(
    () =>
      groups.filter((g) => {
        if (done.has(g.id)) return false;
        const cutIds = new Set(
          (candidates ?? [])
            .filter((c) => (decisions?.[c.id]?.state ?? "pending") !== "pending" && decisions?.[c.id]?.state !== "rejected")
            .map((c) => `${c.startMs}-${c.endMs}`),
        );
        return !g.attempts.every((a) => cutIds.has(`${a.startMs}-${a.endMs}`));
      }),
    [groups, done, candidates, decisions],
  );

  const audition = (key: string, startMs: number, endMs: number) => {
    if (playing === key) {
      stopRange();
      setPlaying(null);
      return;
    }
    setPlaying(key);
    seek(startMs);
    // 聽原始的那一段，不要沿用跳播 —— 要判斷的正是這一次講得好不好
    playRange(startMs, endMs, { skip: false, onEnd: () => setPlaying(null) });
  };

  const keep = (groupId: string, index: number) => {
    if (!mediaId) return;
    const r = keepTake(mediaId, groupId, index);
    if (!r.cut) {
      toast.error(t("沒有動任何東西"));
      return;
    }
    setDone(new Set([...done, groupId]));
    toast.success(t("留下第 {n} 次，剪掉 {c} 段（省 {s} 秒）", { n: index + 1, c: r.cut, s: (r.savedMs / 1000).toFixed(1) }));
  };

  return (
    <Modal open onClose={onClose} title={t("替代 take（同一句講了好幾次）")} icon={Layers} size="lg" footer={<Button variant="ghost" onClick={onClose}>{t("關閉")}</Button>}>
      {!groups.length ? (
        <EmptyState
          compact
          icon={Layers}
          title={t("沒有找到重錄的段落")}
          hint={t("這裡找的是「同一句話連著講了好幾次」。要先完成分析才有逐字稿可以比對。")}
        />
      ) : !open.length ? (
        <EmptyState compact icon={Check} title={t("都處理完了")} hint={t("這一集的 {n} 組重錄都已經挑過了。", { n: groups.length })} />
      ) : (
        <div className="space-y-3 text-sm">
          <div className="text-[11px] text-fg/50 leading-snug">
            {t("每一組都是同一句話的幾次嘗試。**先聽再決定** —— 剪掉的是一整句真正的內容，不是贅字。預設建議留最後一次（會再講一遍就是因為前面不滿意），但有時候第一次最自然。")}
          </div>
          {open.map((g) => (
            <div key={g.id} className="rounded-md border border-fg/10 px-3 py-2 space-y-1.5">
              <div className="flex items-center gap-2 text-[11px] text-fg/45">
                <span>{t("{n} 次嘗試", { n: g.attempts.length })}</span>
                <span className="mono">{formatMs(g.attempts[0].startMs, { millis: false })}</span>
                <span className="ml-auto">{t("留一個可省 {s} 秒", { s: (savedMsOf(g, g.defaultKeep) / 1000).toFixed(1) })}</span>
              </div>
              {g.attempts.map((a) => {
                const key = `${g.id}:${a.index}`;
                const suggested = a.index === g.defaultKeep;
                return (
                  <div key={key} className={`flex items-start gap-2 rounded-sm px-2 py-1 ${suggested ? "bg-accent/8" : ""}`}>
                    <button
                      type="button"
                      onClick={() => audition(key, a.startMs, a.endMs)}
                      title={t("試聽這一次")}
                      className="mt-0.5 shrink-0 rounded-sm p-1 text-fg/50 hover:text-accent hover:bg-fg/5"
                    >
                      <Play size={13} className={playing === key ? "text-accent" : ""} />
                    </button>
                    <span className="mono shrink-0 pt-1 text-[11px] text-fg/40 tabular-nums">{formatMs(a.startMs, { millis: false })}</span>
                    <span className="min-w-0 flex-1 pt-0.5 leading-snug break-words">{a.text}</span>
                    {suggested && <span className="shrink-0 self-start rounded-xs bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">{t("建議")}</span>}
                    <Button size="sm" variant={suggested ? "primary" : "ghost"} icon={Check} className="shrink-0" onClick={() => keep(g.id, a.index)}>
                      {t("留這次")}
                    </Button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
