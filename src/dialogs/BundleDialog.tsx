import { useMemo, useState } from "react";
import { Package, FolderOpen, Play } from "lucide-react";
import { planBundle, bundleStem, type BundleItem } from "../analysis/bundle";
import type { CaptionFormat } from "../analysis/captions";
import { errMessage } from "../api";
import { useT } from "../i18n";
import { buildBundle, type BundleResult } from "../pipeline/bundle";
import { useDecisions } from "../store/decisions";
import { useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { useShowNotes } from "../store/showNotes";
import { useTranscript } from "../store/transcript";
import { Button, EmptyState, Input, Modal, Select, Spinner } from "../ui/index";
import { pickDirectory, toast } from "../ui";
import type { RenderFormat } from "../pipeline/render";

/**
 * 發布包：一次把上架要用的東西產齊。
 *
 * 音檔、字幕、逐字稿、節目筆記、章節這五樣這個 App 全都做得出來，但分散在五個對話
 * 框裡 —— 每週都要開五次、存五次、自己想檔名。上架前最常出的錯不是做不出來，是
 * 「少帶了一個」。
 *
 * 所以這裡**把沒帶到的也列出來並寫原因**（沒有逐字稿就沒有字幕、沒有標記就沒有
 * 章節），而不是安靜地少一個檔案。
 */
export default function BundleDialog({ mediaId, onClose }: { mediaId: string | null; onClose: () => void }) {
  const t = useT();
  const media = useProject((s) => s.media.find((m) => m.id === mediaId) ?? null);
  const targetLufs = useProject((s) => s.targetLufs);
  const outputDir = useSettings((s) => s.s.output_dir);
  const hasTranscript = useTranscript((s) => (mediaId ? !!s.byMedia[mediaId] : false));
  const hasNotes = useShowNotes((s) => (mediaId ? !!s.byMedia[mediaId] : false));
  const markers = useDecisions((s) => (mediaId ? s.markers[mediaId] : undefined));

  const [dir, setDir] = useState(outputDir ?? "");
  const [stem, setStem] = useState("");
  const [audioFormat, setAudioFormat] = useState<RenderFormat>("mp3");
  const [captionFormat, setCaptionFormat] = useState<CaptionFormat>("srt");
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState<{ label: string; done: number; total: number; pct: number } | null>(null);
  const [result, setResult] = useState<BundleResult | null>(null);

  const chapterCount = (markers ?? []).filter((m) => m.kind === "chapter").length;
  const planInput = {
    mediaName: media?.name ?? "",
    audioFormat,
    captionFormat,
    hasTranscript,
    hasShowNotes: hasNotes,
    chapterCount,
    stem,
  };
  const items = useMemo<BundleItem[]>(() => (media ? planBundle(planInput) : []), [media, audioFormat, captionFormat, hasTranscript, hasNotes, chapterCount, stem]); // eslint-disable-line react-hooks/exhaustive-deps
  const name = media ? bundleStem(planInput) : "";
  const missing = items.filter((i) => i.skipped).length;

  const run = async () => {
    if (!mediaId || !dir.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await buildBundle(
        mediaId,
        { dir: dir.trim(), stem: stem.trim() || undefined, audioFormat, captionFormat, targetLufs },
        (label, done, total) => setAt((p) => ({ label, done, total, pct: p?.label === label ? p.pct : 0 })),
        (pr) => setAt((p) => (p ? { ...p, pct: Math.round((pr.pct ?? 0) * 100) } : p)),
      );
      setResult(r);
      if (r.failed.length) toast.error(t("{n} 個檔案產生失敗，詳情看清單", { n: r.failed.length }));
      else toast.success(t("發布包完成：{n} 個檔案", { n: r.written.length }));
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setAt(null);
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={t("發布包")}
      icon={Package}
      size="md"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t("關閉")}
          </Button>
          <Button variant="primary" icon={Play} onClick={() => void run()} loading={busy} disabled={!media || !dir.trim()}>
            {t("產生")}
          </Button>
        </>
      }
    >
      {!media ? (
        <EmptyState icon={Package} title={t("還沒有開啟音檔")} hint={t("先開啟一個音檔。")} />
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-[11px] leading-relaxed text-fg/50">
            {t("一次把上架要用的東西產齊，用同一個名字放進同一個資料夾：音檔、字幕、逐字稿、節目筆記、章節清單，外加一份說明這一包有什麼、少了什麼、能不能上架的清單。")}
          </p>

          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1">
              <span className="mb-1 block text-[11px] text-fg/50">{t("輸出資料夾")}</span>
              <div className="flex gap-1.5">
                <Input value={dir} onChange={(e) => setDir(e.target.value)} className="min-w-0 flex-1" spellCheck={false} disabled={busy} />
                <Button icon={FolderOpen} disabled={busy} onClick={() => void pickDirectory().then((d) => d && setDir(d))}>
                  {t("選擇")}
                </Button>
              </div>
            </label>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1">
              <span className="mb-1 block text-[11px] text-fg/50">{t("檔名前綴")}</span>
              <Input value={stem} placeholder={name} onChange={(e) => setStem(e.target.value)} disabled={busy} spellCheck={false} />
            </label>
            <label>
              <span className="mb-1 block text-[11px] text-fg/50">{t("音檔")}</span>
              <Select value={audioFormat} onChange={(e) => setAudioFormat(e.target.value as RenderFormat)} disabled={busy}>
                <option value="mp3">mp3</option>
                <option value="m4a">m4a</option>
                <option value="wav">wav</option>
              </Select>
            </label>
            <label>
              <span className="mb-1 block text-[11px] text-fg/50">{t("字幕")}</span>
              <Select value={captionFormat} onChange={(e) => setCaptionFormat(e.target.value as CaptionFormat)} disabled={busy}>
                <option value="srt">SRT</option>
                <option value="vtt">WebVTT</option>
              </Select>
            </label>
          </div>

          <div className="rounded-md border border-fg/10">
            {items.map((i) => {
              const done = result?.written.some((w) => w.fileName === i.fileName);
              const failed = result?.failed.find((f) => f.fileName === i.fileName);
              const running = busy && at?.label === i.fileName;
              return (
                <div key={i.fileName} className="flex items-center gap-2 border-b border-fg/8 px-3 py-1.5 last:border-b-0">
                  <span className={`mono min-w-0 flex-1 truncate text-[11px] ${i.skipped ? "text-fg/25 line-through" : "text-fg/70"}`}>{i.fileName}</span>
                  {i.skipped ? (
                    <span className="shrink-0 text-[11px] text-warning/80">{i.skipped}</span>
                  ) : running ? (
                    <span className="flex shrink-0 items-center gap-1 text-[11px] text-accent">
                      <Spinner /> {at.pct > 0 ? `${at.pct}%` : ""}
                    </span>
                  ) : failed ? (
                    <span className="shrink-0 text-[11px] text-danger" title={failed.error}>
                      {t("失敗")}
                    </span>
                  ) : done ? (
                    <span className="shrink-0 text-[11px] text-success">{t("完成")}</span>
                  ) : (
                    <span className="shrink-0 text-[11px] text-fg/25">—</span>
                  )}
                </div>
              );
            })}
          </div>

          {missing > 0 && !result && (
            <p className="text-[11px] leading-relaxed text-warning/80">
              {t("有 {n} 項這一集還沒有，會照樣產出其他的，並且寫進清單裡（不會安靜地少檔案）。", { n: missing })}
            </p>
          )}
          {result && (
            <div className="mono text-[11px] tabular-nums text-fg/45">
              {t("寫出 {w} 個檔案", { w: result.written.length })}
              {result.skipped.length > 0 && ` · ${t("略過 {s} 個", { s: result.skipped.length })}`}
              {result.measuredLufs != null && ` · ${t("輸出後量到 {l} LUFS", { l: result.measuredLufs.toFixed(1) })}`}
              {result.blocked && ` · ${t("交付前檢查有擋下項目，看清單")}`}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
