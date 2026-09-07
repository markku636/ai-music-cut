import { useMemo, useState } from "react";
import { Scissors, FolderOpen, Play } from "lucide-react";
import { splitByChapters, totalOutMs, type SplitPart } from "../analysis/splitExport";
import { errMessage } from "../api";
import { useT } from "../i18n";
import { edlFor } from "../pipeline/rules";
import { runRender, type RenderFormat } from "../pipeline/render";
import { useDecisions } from "../store/decisions";
import { useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { Button, EmptyState, Input, Modal, Select, Spinner } from "../ui/index";
import { pickDirectory, toast } from "../ui";
import { formatMs } from "../time";

/**
 * 依章節分割輸出。
 *
 * 一次錄三集、把一場長訪談切成上下集、把贊助口播單獨輸出 —— 章節標記本來就標好了，
 * 那就是分割點。
 *
 * **每一段各走一次完整的輸出管線**，不是把成品切開：切成品的話每一段的響度都是照
 * 整集算的（單獨聽會偏掉），切點也會落在樣本中間。
 *
 * **一次跑一段**。響度正規化是兩趟 CPU 重活，平行只會讓它們互相搶 —— 這跟批次處理
 * 是同一個理由。某一段失敗不影響其他段，錯誤留在那一列上。
 */
type RowState = "idle" | "running" | "done" | "error";

export default function SplitExportDialog({ mediaId, onClose }: { mediaId: string | null; onClose: () => void }) {
  const t = useT();
  const media = useProject((s) => s.media.find((m) => m.id === mediaId) ?? null);
  const markers = useDecisions((s) => (mediaId ? s.markers[mediaId] : undefined));
  const targetLufs = useProject((s) => s.targetLufs);
  const outputDir = useSettings((s) => s.s.output_dir);
  const [format, setFormat] = useState<RenderFormat>("mp3");
  const [dir, setDir] = useState(outputDir ?? "");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<Record<number, { s: RowState; msg?: string }>>({});
  const [at, setAt] = useState<{ index: number; pct: number } | null>(null);

  const parts = useMemo<SplitPart[]>(() => {
    if (!mediaId || !media) return [];
    return splitByChapters(markers ?? [], edlFor(mediaId), {
      baseName: (media.name ?? "output").replace(/\.[^.]+$/, ""),
      ext: format,
      durationMs: media.probe?.duration_ms ?? 0,
      leadTitle: t("開場"),
    });
  }, [mediaId, media, markers, format, t]);

  const run = async () => {
    if (!mediaId || !dir.trim() || !parts.length) return;
    setBusy(true);
    setState({});
    const sep = dir.includes("\\") ? "\\" : "/";
    const base = dir.trim().replace(/[\\/]+$/, "");
    let ok = 0;
    for (const p of parts) {
      setState((s) => ({ ...s, [p.index]: { s: "running" } }));
      setAt({ index: p.index, pct: 0 });
      try {
        await runRender(
          mediaId,
          {
            format,
            outPath: `${base}${sep}${p.fileName}`,
            leveling: true,
            targetLufs,
            rangeMs: { startMs: p.startMs, endMs: p.endMs },
          },
          (pr) => setAt({ index: p.index, pct: Math.round((pr.pct ?? 0) * 100) }),
        );
        ok++;
        setState((s) => ({ ...s, [p.index]: { s: "done" } }));
      } catch (e) {
        // 某一段失敗不影響其他段 —— 跑到第 4 段掛掉、前 3 段也跟著不見是最糟的
        setState((s) => ({ ...s, [p.index]: { s: "error", msg: errMessage(e) } }));
      }
    }
    setAt(null);
    setBusy(false);
    if (ok === parts.length) toast.success(t("{n} 段全部輸出完成", { n: ok }));
    else toast.error(t("{ok} / {n} 段輸出完成，其餘失敗", { ok, n: parts.length }));
  };

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={t("依章節分割輸出")}
      icon={Scissors}
      size="lg"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t("關閉")}
          </Button>
          <Button variant="primary" icon={Play} onClick={() => void run()} loading={busy} disabled={!parts.length || !dir.trim()}>
            {t("輸出 {n} 段", { n: parts.length })}
          </Button>
        </>
      }
    >
      {!parts.length ? (
        <EmptyState
          icon={Scissors}
          title={t("這一集沒有章節標記")}
          hint={t("在波形上按 Ctrl+M 下章節標記，或用「節目筆記」讓 AI 提章節再一鍵寫成標記。章節之間就是分割點。")}
        />
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-[11px] leading-relaxed text-fg/50">
            {t("每一段都各走一次完整的輸出管線（逐段平衡、修聲、配樂、響度正規化），不是把成品切開 —— 切成品的話每一段的響度都是照整集算的，單獨聽會偏掉。一次跑一段。")}
          </p>

          <div className="flex flex-wrap items-end gap-2">
            <label className="min-w-0 flex-1">
              <span className="mb-1 block text-[11px] text-fg/50">{t("輸出資料夾")}</span>
              <div className="flex gap-1.5">
                <Input value={dir} onChange={(e) => setDir(e.target.value)} className="min-w-0 flex-1" spellCheck={false} disabled={busy} />
                <Button
                  icon={FolderOpen}
                  disabled={busy}
                  onClick={() => {
                    void pickDirectory().then((d) => d && setDir(d));
                  }}
                >
                  {t("選擇")}
                </Button>
              </div>
            </label>
            <label>
              <span className="mb-1 block text-[11px] text-fg/50">{t("格式")}</span>
              <Select value={format} onChange={(e) => setFormat(e.target.value as RenderFormat)} disabled={busy}>
                <option value="mp3">mp3</option>
                <option value="m4a">m4a</option>
                <option value="wav">wav</option>
              </Select>
            </label>
          </div>

          <div className="max-h-[42vh] overflow-y-auto rounded-md border border-fg/10">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-panel text-[10px] uppercase tracking-wide text-fg/35">
                <tr>
                  <th className="py-1 pl-2 text-left font-normal">{t("段")}</th>
                  <th className="py-1 text-left font-normal">{t("章節")}</th>
                  <th className="py-1 text-right font-normal">{t("成品長度")}</th>
                  <th className="py-1 pl-3 text-left font-normal">{t("檔名")}</th>
                  <th className="py-1 pr-2 text-left font-normal">{t("狀態")}</th>
                </tr>
              </thead>
              <tbody>
                {parts.map((p) => {
                  const st = state[p.index];
                  return (
                    <tr key={p.index} className="border-t border-fg/8">
                      <td className="mono py-1 pl-2 tabular-nums text-fg/45">{p.index}</td>
                      <td className="py-1 pr-2">{p.title}</td>
                      <td className="mono py-1 text-right tabular-nums text-fg/60">{formatMs(p.outMs, { millis: false })}</td>
                      <td className="mono py-1 pl-3 text-[11px] text-fg/45">{p.fileName}</td>
                      <td className="py-1 pr-2 text-[11px]">
                        {st?.s === "running" ? (
                          <span className="flex items-center gap-1 text-accent">
                            <Spinner /> {at?.index === p.index ? `${at.pct}%` : ""}
                          </span>
                        ) : st?.s === "done" ? (
                          <span className="text-success">{t("完成")}</span>
                        ) : st?.s === "error" ? (
                          <span className="text-danger" title={st.msg}>
                            {t("失敗")}
                          </span>
                        ) : (
                          <span className="text-fg/25">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mono text-[11px] tabular-nums text-fg/40">
            {t("共 {n} 段 · 成品合計 {ms}", { n: parts.length, ms: formatMs(totalOutMs(parts), { millis: false }) })}
          </div>
        </div>
      )}
    </Modal>
  );
}
