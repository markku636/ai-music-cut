import { useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { BookMarked, Copy, FileText, RefreshCw, Save, Sparkles } from "lucide-react";
import { api, errMessage } from "../api";
import { stamp, toMarkdown } from "../analysis/shownotes";
import { Button, EmptyState, Modal, Spinner } from "../ui/index";
import { copyToClipboard, toast } from "../ui";
import { useT } from "../i18n";
import { generateShowNotes } from "../pipeline/shownotes";
import { edlFor } from "../pipeline/rules";
import { mapOutToSrc } from "../analysis/edl/map";
import { useDecisions } from "../store/decisions";
import { usePlayback } from "../store/playback";
import { useProject } from "../store/project";
import { useShowNotes } from "../store/showNotes";

/**
 * 節目筆記：剪完之後要貼到部落格 / RSS 的那一份，交給地端 claude 寫。
 *
 * 時間戳全部是**成品時間**（聽眾按下播放之後的位置），不是逐字稿的來源時間 ——
 * 剪掉 20 個贅字之後兩者差很多，而且差多少看剪了多少。
 * 要把章節下成標記時再換算回來源時間（標記是釘在來源上的）。
 */
export default function ShowNotesDialog({ mediaId, onClose }: { mediaId: string; onClose: () => void }) {
  const t = useT();
  const media = useProject((s) => s.media.find((m) => m.id === mediaId) ?? null);
  const setChapters = useDecisions((s) => s.setChapters);
  const seek = usePlayback((s) => s.seek);
  // 已經產過就直接顯示 —— 重跑一次要 claude 讀完整集，不該因為關掉視窗就重來
  const notes = useShowNotes((s) => s.byMedia[mediaId] ?? null);
  const setNotes = useShowNotes((s) => s.set);
  const [busy, setBusy] = useState(false);

  const md = useMemo(() => (notes ? toMarkdown(notes, { title: media?.name }) : ""), [notes, media]);

  const run = async () => {
    setBusy(true);
    try {
      setNotes(mediaId, await generateShowNotes(mediaId));
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const saveMd = async () => {
    if (!md) return;
    const base = (media?.name ?? "show-notes").replace(/\.[^.]+$/, "");
    const path = await save({ defaultPath: `${base}-shownotes.md`, filters: [{ name: "Markdown", extensions: ["md"] }] }).catch(() => null);
    if (!path) return;
    try {
      await api.writeTextFile(path, md);
      toast.success(t("已存成 {p}").replace("{p}", path));
    } catch (e) {
      toast.error(errMessage(e));
    }
  };

  /** 章節寫回標記：標記釘在來源時間，所以要把成品時間換算回去。 */
  const applyChapters = () => {
    if (!notes?.chapters.length) return;
    const edl = edlFor(mediaId);
    if (!edl) return;
    const n = setChapters(
      mediaId,
      notes.chapters.map((c) => ({ ms: mapOutToSrc(edl.keeps, c.outMs), title: c.title })),
    );
    toast.success(t("已套用 {n} 個章節（會寫進成品檔案）").replace("{n}", String(n)));
  };

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={t("節目筆記")}
      icon={FileText}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("關閉")}
          </Button>
          {notes && (
            <>
              <Button icon={BookMarked} onClick={applyChapters} disabled={busy || !notes.chapters.length}>
                {t("章節寫成標記")}
              </Button>
              <Button icon={Save} onClick={() => void saveMd()} disabled={busy}>
                {t("存成 .md")}
              </Button>
              <Button
                variant="primary"
                icon={Copy}
                onClick={() => void copyToClipboard(md, t("已複製 Markdown"))}
                disabled={busy}
              >
                {t("複製 Markdown")}
              </Button>
            </>
          )}
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {!notes && !busy && (
          <EmptyState
            icon={Sparkles}
            title={t("讓地端 claude 讀這一集，寫出節目筆記")}
            hint={t("摘要、章節、值得引用的句子、關鍵字。時間戳是**成品**時間，剪掉的段落不會被算進去。")}
            action={
              <Button variant="primary" icon={Sparkles} onClick={() => void run()}>
                {t("產生")}
              </Button>
            }
          />
        )}
        {busy && (
          <div className="flex items-center gap-2 text-fg/70 py-8 justify-center">
            <Spinner size={16} />
            {t("claude 正在讀這一集…（40 分鐘的節目大約要一兩分鐘）")}
          </div>
        )}
        {notes && !busy && (
          <>
            <div className="flex justify-end">
              <Button size="sm" variant="ghost" icon={RefreshCw} onClick={() => void run()}>
                {t("重新產生")}
              </Button>
            </div>
            {notes.summary && <p className="leading-7 text-fg/85 whitespace-pre-wrap">{notes.summary}</p>}
            {notes.chapters.length > 0 && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-fg/35 mb-1">{t("章節")}</div>
                <div className="space-y-0.5">
                  {notes.chapters.map((c) => (
                    <button
                      key={`${c.outMs}-${c.title}`}
                      type="button"
                      onClick={() => {
                        const edl = edlFor(mediaId);
                        if (edl) seek(mapOutToSrc(edl.keeps, c.outMs));
                      }}
                      className="flex w-full items-baseline gap-2 rounded px-1 py-0.5 text-left hover:bg-fg/5"
                      title={t("跳到這裡（成品時間換算回來源）")}
                    >
                      <span className="mono text-[11px] text-accent tabular-nums shrink-0">{stamp(c.outMs)}</span>
                      <span className="text-fg/85">{c.title}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {notes.quotes.length > 0 && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-fg/35 mb-1">{t("節錄")}</div>
                {notes.quotes.map((q) => (
                  <blockquote key={`${q.outMs}-${q.text}`} className="border-l-2 border-accent/40 pl-2 my-1 text-fg/75">
                    {q.text}
                    <span className="mono text-[11px] text-fg/40 ml-2">{stamp(q.outMs)}</span>
                  </blockquote>
                ))}
              </div>
            )}
            {notes.keywords.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {notes.keywords.map((k) => (
                  <span key={k} className="rounded-full bg-fg/6 px-2 py-0.5 text-[11px] text-fg/60">
                    {k}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
