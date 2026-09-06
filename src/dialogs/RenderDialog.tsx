import { useEffect, useMemo, useState } from "react";
import { BadgeCheck, FileMusic, FolderOpen } from "lucide-react";
import { api, errMessage, type RenderDone, type RenderProgress } from "../api";
import { KIND_LABEL, type CandidateKind } from "../analysis/types";
import { Button, Field, FormGrid, Input, Modal, Select } from "../ui/index";
import { pickSaveFile, toast } from "../ui";
import { useT } from "../i18n";
import { buildRenderPlan, defaultOutPath, runRender, type RenderFormat } from "../pipeline/render";
import { renderStems, STEM_LABEL, type StemProgress } from "../pipeline/stems";
import { useDecisions } from "../store/decisions";
import { useProject } from "../store/project";
import { useVerify } from "../store/verify";
import { useSettings } from "../store/settings";
import { formatMs } from "../time";

export default function RenderDialog({ mediaId, onClose, onVerify }: { mediaId: string; onClose: () => void; onVerify?: (outPath: string, durationMs: number | null) => void }) {
  const t = useT();
  const media = useProject((s) => s.media.find((m) => m.id === mediaId) ?? null);
  const projTarget = useProject((s) => s.targetLufs);
  const settings = useSettings((s) => s.s);
  const [format, setFormat] = useState<RenderFormat>("mp3");
  const [outPath, setOutPath] = useState("");
  const [leveling, setLeveling] = useState(true);
  const [stems, setStems] = useState(false);
  const [stemStep, setStemStep] = useState<StemProgress | null>(null);
  const hasOverlays = useDecisions((s2) => (s2.overlays[mediaId] ?? []).length > 0);
  const [target, setTarget] = useState<number>(projTarget || settings.target_lufs || -16);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<RenderProgress | null>(null);
  const [done, setDone] = useState<RenderDone | null>(null);

  useEffect(() => {
    if (media) setOutPath(defaultOutPath(media, format, settings.output_dir));
  }, [media, format, settings.output_dir]);

  const built = useMemo(() => (media ? buildRenderPlan(mediaId, { format, outPath, leveling, targetLufs: target }) : null), [media, mediaId, format, outPath, leveling, target]);
  const stats = built?.edl.stats;
  const gainRange = useMemo(() => {
    if (!built?.gains.length) return null;
    const gs = built.gains.map((g) => g.gainDb);
    return [Math.min(...gs), Math.max(...gs)] as const;
  }, [built]);

  const start = async () => {
    if (!media || !outPath.trim()) return;
    setBusy(true);
    setDone(null);
    try {
      const base = { format, outPath: outPath.trim(), leveling, targetLufs: target };
      if (stems && hasOverlays) {
        const files = await renderStems(mediaId, base, true, (p) => setStemStep(p));
        setStemStep(null);
        useVerify.getState().clear(mediaId);
        toast.success(t("分軌輸出完成：{files}", { files: files.map((f) => t(STEM_LABEL[f.kind])).join("、") }));
        setDone({ job_id: "", ok: true, out_path: files[0].path, error: null, input_lufs: null, output_lufs: null, output_tp: null, elapsed_ms: 0 });
      } else {
        const r = await runRender(mediaId, base, setProgress);
        setDone(r);
        useVerify.getState().clear(mediaId); // 換了成品，舊的驗收報告就不算數
        if (r.ok) toast.success(t("輸出完成：{lufs} LUFS", { lufs: r.output_lufs?.toFixed(1) ?? "?" }));
        else if (r.error !== "已取消") toast.error(r.error ?? t("輸出失敗"));
      }
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(false);
      setProgress(null);
      setStemStep(null);
    }
  };

  const STAGE: Record<RenderProgress["stage"], string> = { cut: t("剪接"), measure: t("量測響度"), encode: t("響度正規化 + 編碼") };

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={t("輸出")}
      icon={FileMusic}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("關閉")}
          </Button>
          {done?.ok && done.out_path && (
            <>
              <Button icon={FolderOpen} onClick={() => void api.openPath(done.out_path!)}>
                {t("開啟資料夾")}
              </Button>
              {onVerify && (
                <Button
                  icon={BadgeCheck}
                  onClick={() => {
                    onVerify(done.out_path!, built?.edl.stats.keptMs ?? null);
                    onClose();
                  }}
                  title={t("把成品送回 ttls 重新轉寫，檢查有沒有剪掉不該剪的字")}
                >
                  {t("用 ASR 驗收")}
                </Button>
              )}
            </>
          )}
          <Button variant="primary" onClick={() => void start()} loading={busy} disabled={!built || !outPath.trim()}>
            {t("開始輸出")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        {stats && media && (
          <div className="rounded-md border border-fg/10 p-3 text-xs text-fg/70 space-y-1">
            <div>
              {t("來源")} {formatMs(media.probe?.duration_ms ?? 0, { millis: false })} → {t("剪後")} <b className="text-fg/90">{formatMs(stats.keptMs + built!.edl.joins.filter((j) => j.kind === "gap").reduce((s, j) => s + j.ms, 0), { millis: false })}</b>
              {" · "}
              {t("剪掉 {s} 秒、{n} 刀", { s: (stats.removedMs / 1000).toFixed(1), n: stats.cutCount })}
            </div>
            <div className="flex flex-wrap gap-x-3">
              {Object.entries(stats.byKind).map(([k, v]) => (
                <span key={k}>
                  {t(KIND_LABEL[k as CandidateKind] ?? k)} {v.count}（{(v.ms / 1000).toFixed(1)}s）
                </span>
              ))}
            </div>
            {built!.edl.downgrades.length > 0 && <div className="text-warning/90">{t("{n} 個候選因單句剪除比例過高被降為建議", { n: built!.edl.downgrades.length })}</div>}
            {leveling && gainRange && (
              <div>
                {t("響度平衡：{n} 段，增益 {a} ~ {b} dB", { n: built!.units, a: gainRange[0].toFixed(1), b: gainRange[1].toFixed(1) })}
              </div>
            )}
          </div>
        )}
        <FormGrid>
          <Field label={t("格式")}>
            <Select value={format} onChange={(e) => setFormat(e.target.value as RenderFormat)} disabled={busy}>
              <option value="mp3">MP3（VBR q2）</option>
              <option value="m4a">M4A（AAC 192k）</option>
              <option value="wav">WAV（16-bit）</option>
            </Select>
          </Field>
          <Field label={t("目標響度")}>
            <Select value={String(target)} onChange={(e) => setTarget(Number(e.target.value))} disabled={busy}>
              <option value="-14">-14 LUFS（Spotify / YouTube）</option>
              <option value="-16">-16 LUFS（Podcast 立體聲）</option>
              <option value="-19">-19 LUFS（Podcast 單聲道）</option>
              <option value="-23">-23 LUFS（EBU R128）</option>
            </Select>
          </Field>
        </FormGrid>
        <Field label={t("輸出檔案")}>
          <div className="flex gap-2">
            <Input value={outPath} onChange={(e) => setOutPath(e.target.value)} className="flex-1" spellCheck={false} disabled={busy} />
            <Button
              variant="ghost"
              disabled={busy}
              onClick={async () => {
                const p = await pickSaveFile(outPath, [{ name: format.toUpperCase(), extensions: [format] }]);
                if (p) setOutPath(p);
              }}
            >
              …
            </Button>
          </div>
        </Field>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={leveling} onChange={(e) => setLeveling(e.target.checked)} disabled={busy} />
          {t("逐段音量平衡（把忽大忽小的段落拉齊，再整體正規化到目標響度）")}
        </label>
        <label className={`flex items-center gap-2 ${hasOverlays ? "" : "opacity-45"}`} title={hasOverlays ? undefined : t("這一集沒有配樂 / 音效，沒有東西可以分軌")}>
          <input type="checkbox" checked={stems && hasOverlays} onChange={(e) => setStems(e.target.checked)} disabled={busy || !hasOverlays} />
          {t("同時輸出分軌（人聲一個檔、配樂與音效一個檔）")}
        </label>
        {stems && hasOverlays && (
          <p className="text-[11px] text-fg/40 leading-relaxed -mt-1">
            {t("三個檔共用同一組響度量測，所以各軌之間的相對音量跟完整混音一致（每一軌各自正規化的話，配樂會被拉到跟人聲一樣大聲）。真實峰值限制器仍然是逐檔套用，所以把兩軌相加不會逐樣本等於完整混音 —— 影片剪接端本來也會重新做一次混音。")}
          </p>
        )}
        {stemStep && (
          <div className="text-xs text-fg/60">
            {t("分軌輸出 {i}/{n}：{label}", { i: stemStep.index + 1, n: stemStep.total, label: t(STEM_LABEL[stemStep.kind]) })}
          </div>
        )}
        {(busy || progress) && (
          <div className="space-y-1">
            <div className="text-xs text-fg/60">{progress ? `${STAGE[progress.stage]} ${Math.round(progress.pct)}%` : t("準備中…")}</div>
            <div className="h-1.5 rounded-full bg-fg/10 overflow-hidden">
              <div className="h-full bg-accent transition-[width]" style={{ width: `${progress ? progress.pct : 2}%` }} />
            </div>
          </div>
        )}
        {done && (
          <div className={`rounded-md border p-3 text-xs ${done.ok ? "border-success/40 text-fg/80" : "border-danger/40 text-danger"}`}>
            {done.ok
              ? t("完成：{path}；輸入 {i} LUFS → 輸出 {o} LUFS，真峰值 {tp} dBTP，耗時 {s} 秒", {
                  path: done.out_path ?? "",
                  i: done.input_lufs?.toFixed(1) ?? "?",
                  o: done.output_lufs?.toFixed(1) ?? "?",
                  tp: done.output_tp?.toFixed(1) ?? "?",
                  s: (done.elapsed_ms / 1000).toFixed(1),
                })
              : done.error}
          </div>
        )}
      </div>
    </Modal>
  );
}
