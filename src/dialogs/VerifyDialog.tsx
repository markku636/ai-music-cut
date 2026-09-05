import { useState } from "react";
import { BadgeCheck, Play, Scissors, SquareDashed } from "lucide-react";
import { errMessage } from "../api";
import type { VerifyFinding } from "../analysis/verify";
import { Badge, Button, EmptyState, Modal, Spinner } from "../ui/index";
import { toast } from "../ui";
import { useT } from "../i18n";
import { runVerify } from "../pipeline/verify";
import { playRange } from "../preview/playerRef";
import { usePlayback } from "../store/playback";
import { useTimeline } from "../store/timeline";
import { useVerify } from "../store/verify";
import { checkCompliance } from "../analysis/loudness/compliance";
import { formatMs } from "../time";
import { AudioLines, Gauge } from "lucide-react";

export interface VerifyDialogProps {
  mediaId: string;
  /** 沒有報告時可直接從這裡再跑一次（通常是剛輸出的檔）。 */
  outPath: string | null;
  outDurationMs?: number | null;
  onClose: () => void;
}

/**
 * ASR 驗收報告：AI 剪完之後，把成品送回 ttls 重新轉寫，逐字比對「EDL 說該留的字」。
 * 人只要聽機器標出來的可疑處：漏字（剪過頭）、該剪沒剪、接縫附近的差異。
 */
export default function VerifyDialog({ mediaId, outPath, outDurationMs, onClose }: VerifyDialogProps) {
  const t = useT();
  const report = useVerify((s) => s.byMedia[mediaId] ?? null);
  const splice = useVerify((s) => s.spliceByMedia[mediaId] ?? null);
  const lastOut = useVerify((s) => s.lastOutput[mediaId] ?? null);
  const compliance = lastOut && lastOut.outputLufs != null ? checkCompliance({ outputLufs: lastOut.outputLufs, outputTp: lastOut.outputTp ?? null, targetLufs: lastOut.targetLufs ?? -16 }) : null;
  const running = useVerify((s) => !!s.running[mediaId]);
  const seek = usePlayback((s) => s.seek);
  const setSelection = useTimeline((s) => s.setSelection);
  const [busy, setBusy] = useState(false);

  const rerun = async () => {
    const p = outPath ?? report?.outPath ?? null;
    if (!p) return;
    setBusy(true);
    try {
      await runVerify(mediaId, { outPath: p, outDurationMs });
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  /** 聽原始音檔那個位置（前後各 1 秒），確認是不是真的被剪壞。 */
  const listen = (f: VerifyFinding) => {
    seek(Math.max(0, f.srcMs - 1000));
    playRange(Math.max(0, f.srcMs - 1000), f.srcMs + 1200, { skip: false });
  };

  /** 在編輯器裡選起來，方便馬上調整（關掉對話框）。 */
  const selectInEditor = (f: VerifyFinding) => {
    setSelection({ startMs: Math.max(0, f.srcMs - 400), endMs: f.srcMs + 800 });
    seek(Math.max(0, f.srcMs - 400));
    onClose();
  };

  const hard = (report?.findings ?? []).filter((f) => (f.kind === "missing" || f.kind === "extra") && !f.lowConfidence);
  const badSeams = (report?.seams ?? []).filter((s) => !s.ok);
  const grade = !report ? null : hard.length === 0 && badSeams.length === 0 ? "good" : hard.length <= 2 && badSeams.length <= 1 ? "warn" : "bad";

  return (
    <Modal
      open
      onClose={onClose}
      title={t("輸出驗收")}
      icon={BadgeCheck}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("關閉")}
          </Button>
          <Button variant="primary" onClick={() => void rerun()} loading={busy || running} disabled={!outPath && !report?.outPath}>
            {report ? t("重新驗證") : t("開始驗證")}
          </Button>
        </>
      }
    >
      {running || busy ? (
        <div className="flex items-center gap-2 text-sm text-fg/70 p-4">
          <Spinner size={16} className="text-accent" />
          {t("比對成品與來源…（有逐字稿時還會送回 ttls 重新轉寫，需要一點時間）")}
        </div>
      ) : !report && !splice ? (
        <EmptyState
          compact
          icon={BadgeCheck}
          title={t("還沒驗證過這個成品")}
          hint={t("驗收會先用波形逐段比對成品跟來源（音樂也適用），有逐字稿時再重新轉寫一次逐字比對，並標出可疑的接縫。")}
        />
      ) : (
        <div className="space-y-4 text-sm">
          {compliance && (
            <div className={`rounded-md border px-3 py-2 text-xs ${compliance.level === "ok" ? "border-success/30 bg-success/10 text-success" : compliance.level === "warn" ? "border-warning/30 bg-warning/10 text-warning" : "border-danger/30 bg-danger/10 text-danger"}`}>
              <div className="flex items-center gap-2">
                <Gauge size={14} />
                <span className="font-medium">{t("交付檢查")}</span>
                <span className="flex-1 min-w-0 truncate">{compliance.summary}</span>
              </div>
              <ul className="mt-1 space-y-0.5 text-[11px] opacity-90">
                {compliance.checks.map((c, i) => (
                  <li key={i}>
                    {c.level === "ok" ? "✓" : c.level === "warn" ? "!" : "✕"} {t(c.label)}：{c.detail}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {splice && (
            <div className={`rounded-md border px-3 py-2 text-xs ${splice.okCount === splice.segments.length ? "border-success/30 bg-success/10 text-success" : "border-warning/30 bg-warning/10 text-warning"}`}>
              <div className="flex items-center gap-2">
                <AudioLines size={14} />
                <span className="font-medium">{t("音訊比對")}</span>
                <span className="flex-1 min-w-0 truncate">{splice.summary}</span>
              </div>
              {splice.segments.some((s) => !s.ok) && (
                <ul className="mt-1 space-y-0.5 text-[11px]">
                  {splice.segments
                    .filter((s) => !s.ok)
                    .slice(0, 6)
                    .map((s) => (
                      <li key={s.index} className="mono">
                        {t("第 {n} 段", { n: s.index + 1 })} {formatMs(s.srcStartMs, { millis: false })} → {formatMs(s.outStartMs, { millis: false })}：{s.note}
                      </li>
                    ))}
                </ul>
              )}
            </div>
          )}
          {report && (
          <div className="flex items-center gap-3">
            <span
              className={`text-2xl font-semibold tabular-nums ${grade === "good" ? "text-success" : grade === "warn" ? "text-warning" : "text-danger"}`}
            >
              {(report.matchRate * 100).toFixed(1)}%
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-fg/85">{report.summary}</div>
              <div className="text-[11px] text-fg/40 mono truncate" title={report.outPath}>
                {report.outPath}
                {report.durationDeltaMs != null && ` · ${t("時長差 {s} 秒", { s: (report.durationDeltaMs / 1000).toFixed(2) })}`}
              </div>
            </div>
          </div>

          )}
          {!report ? (
            <div className="text-xs text-fg/45">{t("這個媒體沒有逐字稿，只做了音訊比對；要逐字驗收請先「分析」取得逐字稿。")}</div>
          ) : hard.length === 0 && badSeams.length === 0 ? (
            <div className="rounded-md border border-success/30 bg-success/10 text-success px-3 py-2 text-xs">
              {t("成品逐字等於預期，{n} 個接縫都沒有吃到字。", { n: report.seams.length })}
            </div>
          ) : (
            <div className="space-y-1">
              <div className="text-[11px] text-fg/45 uppercase tracking-wide">{t("需要人耳確認（{n}）", { n: hard.length })}</div>
              <div className="max-h-[240px] overflow-auto rounded-md border border-fg/10 divide-y divide-fg/5">
                {hard.slice(0, 60).map((f, i) => (
                  <div key={i} className="flex items-center gap-2 px-2.5 py-1.5">
                    <Badge tone={f.kind === "missing" ? "danger" : "warning"}>{f.kind === "missing" ? t("漏字") : t("該剪沒剪")}</Badge>
                    <span className="mono text-[11px] text-fg/45 tabular-nums">{formatMs(f.srcMs, { millis: false })}</span>
                    <span className="flex-1 min-w-0 truncate">
                      「{f.expected ?? f.actual}」{f.nearSeam && <span className="text-warning ml-1 text-[11px]">{t("接縫附近")}</span>}
                    </span>
                    <Button size="sm" variant="ghost" icon={Play} onClick={() => listen(f)}>
                      {t("聽")}
                    </Button>
                    <Button size="sm" variant="ghost" icon={SquareDashed} onClick={() => selectInEditor(f)}>
                      {t("去修")}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {report && (
          <div className="space-y-1">
            <div className="text-[11px] text-fg/45 uppercase tracking-wide">
              {t("接縫（{ok} / {n} 乾淨）", { ok: report.seams.length - badSeams.length, n: report.seams.length })}
            </div>
            <div className="max-h-[160px] overflow-auto rounded-md border border-fg/10 divide-y divide-fg/5">
              {report.seams.length === 0 ? (
                <div className="px-2.5 py-2 text-xs text-fg/40">{t("這次輸出沒有剪點")}</div>
              ) : (
                report.seams.map((s, i) => (
                  <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
                    <Scissors size={12} className={s.ok ? "text-fg/30" : "text-danger"} />
                    <span className="mono text-[11px] text-fg/45 tabular-nums">
                      {formatMs(s.srcBeforeMs, { millis: false })} → {formatMs(s.srcAfterMs, { millis: false })}
                    </span>
                    <span className={`flex-1 min-w-0 truncate ${s.ok ? "text-fg/50" : "text-danger"}`}>{s.note}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={Play}
                      onClick={() => {
                        seek(Math.max(0, s.srcBeforeMs - 1200));
                        playRange(Math.max(0, s.srcBeforeMs - 1200), s.srcAfterMs + 1200, { skip: true });
                      }}
                    >
                      {t("聽接法")}
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>
          )}
          {report && (
          <p className="text-[11px] text-fg/35 leading-relaxed">
            {t("提醒：驗證用的是重新辨識的結果，ASR 本身也會聽錯；「接縫附近」的漏字最值得先聽。")}
          </p>
          )}
        </div>
      )}
    </Modal>
  );
}
