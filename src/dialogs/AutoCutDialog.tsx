import { useRef, useState } from "react";
import { Check, Sparkles, Wand2, Zap } from "lucide-react";
import { errMessage } from "../api";
import { DEFAULT_STEPS, savedOf, type AutoCutReport, type AutoCutSteps } from "../analysis/autocut";
import { Button, Modal } from "../ui/index";
import { toast } from "../ui";
import { useT } from "../i18n";
import { AutoCutCancelled, runAutoCut, type AutoCutProgress } from "../pipeline/autocut";
import { useTranscript } from "../store/transcript";

/**
 * 一鍵智慧剪輯。
 *
 * 刻意**不做成黑盒子**：跑之前列出會做哪幾件事（可以逐項關掉），
 * 跑完列出每一步各省了多少，而且每一步都是獨立的 undo 單位。
 * 「AI 幫你剪好了」而不告訴你剪了什麼，剪輯的人是不敢用的。
 */
export default function AutoCutDialog({ mediaId, onClose }: { mediaId: string; onClose: () => void }) {
  const t = useT();
  const hasTranscript = useTranscript((s) => !!s.byMedia[mediaId]);
  const [steps, setSteps] = useState<AutoCutSteps>(DEFAULT_STEPS);
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState<AutoCutProgress | null>(null);
  const [report, setReport] = useState<AutoCutReport | null>(null);
  const cancelled = useRef(false);

  const toggle = (k: keyof AutoCutSteps) => setSteps((s) => ({ ...s, [k]: !s[k] }));

  const run = async () => {
    cancelled.current = false;
    setBusy(true);
    setReport(null);
    try {
      const r = await runAutoCut(mediaId, { steps, onProgress: setProg, isCancelled: () => cancelled.current });
      setReport(r);
    } catch (e) {
      if (e instanceof AutoCutCancelled) toast.info(t("已取消（做到一半的部分保留著，可以用 Ctrl+Z 回退）"));
      else toast.error(errMessage(e));
    } finally {
      setBusy(false);
      setProg(null);
    }
  };

  const ROWS: { key: keyof AutoCutSteps; label: string; hint: string }[] = [
    { key: "reliable", label: t("接受有把握的剪點"), hint: t("贅字 / 口吃 / 長停頓 / 重講。含糊與離題一律留著問你") },
    { key: "fillers", label: t("清掉重複的口頭禪"), hint: t("出現 8 次以上、又沒佔掉太多篇幅的詞才剪") },
    { key: "cleanup", label: t("依量測結果修聲"), hint: t("底噪夠低就不做；齒音一律不自動開") },
    { key: "judge", label: t("AI 逐段判讀"), hint: t("慢（一集要幾分鐘），但會處理含糊與離題") },
    { key: "notes", label: t("寫節目筆記與章節"), hint: t("需要逐字稿；用成品時間標時間戳") },
  ];

  const saved = report ? savedOf(report) : null;

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={t("一鍵智慧剪輯")}
      icon={Zap}
      size="md"
      footer={
        busy ? (
          <Button variant="danger" onClick={() => (cancelled.current = true)}>
            {t("取消")}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t("關閉")}
            </Button>
            <Button variant="primary" icon={Sparkles} onClick={() => void run()}>
              {report ? t("再跑一次") : t("開始")}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3 text-sm">
        {!report && !busy && (
          <p className="text-xs text-fg/60">
            {t("把每次開檔之後都要做一遍的事情串起來。只做規則層有把握的部分 —— 含糊、離題、重講一律留著問你。每一步都是獨立的復原單位。")}
          </p>
        )}

        {!busy && (
          <div className="space-y-1">
            {ROWS.map((r) => (
              <label key={r.key} className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-fg/[0.04]">
                <input type="checkbox" className="mt-1" checked={steps[r.key]} onChange={() => toggle(r.key)} disabled={busy} />
                <span className="min-w-0">
                  {r.label}
                  <span className="block text-[11px] text-fg/45">{r.hint}</span>
                </span>
              </label>
            ))}
            {!hasTranscript && <div className="text-[11px] text-warning">{t("這個檔案還沒有逐字稿，會先跑一次語音辨識（最久的一步）。")}</div>}
          </div>
        )}

        {busy && prog && (
          <div className="space-y-2 py-4">
            <div className="text-fg/80">{prog.label}</div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-fg/10">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300"
                style={{ width: `${Math.round((prog.ratio ?? 0.5) * 100)}%` }}
              />
            </div>
          </div>
        )}

        {report && !busy && (
          <div className="space-y-2">
            <div className="rounded-md border border-accent/30 bg-accent/8 px-3 py-2">
              <div className="text-lg font-medium text-accent tabular-nums">
                {t("省下 {min} 分鐘").replace("{min}", (saved!.ms / 60000).toFixed(1))}
                <span className="text-sm text-fg/60 ml-2">{saved!.percent.toFixed(1)}%</span>
              </div>
              <div className="text-[11px] text-fg/55">
                {t("{a} → {b} 分鐘").replace("{a}", (report.srcMs / 60000).toFixed(1)).replace("{b}", (report.outMs / 60000).toFixed(1))}
              </div>
            </div>
            <div className="space-y-0.5">
              {report.lines.map((l, i) => (
                <div key={i} className="flex items-start gap-1.5 text-xs text-fg/75">
                  <Check size={13} className="mt-0.5 shrink-0 text-accent" />
                  <span>{l}</span>
                </div>
              ))}
            </div>
            {report.savedByStep.filter((s) => s.savedMs > 0).length > 0 && (
              <div className="text-[11px] text-fg/50">
                {report.savedByStep
                  .filter((s) => s.savedMs > 0)
                  .map((s) => `${s.label} −${(s.savedMs / 60000).toFixed(1)}min`)
                  .join(" · ")}
              </div>
            )}
            {report.pendingCount > 0 && (
              <div className="rounded-md border border-fg/10 px-3 py-2 text-xs text-fg/70">
                <Wand2 size={13} className="inline mr-1 text-fg/40" />
                {t("還有 {n} 筆需要你決定（含糊 / 離題 / 重講）—— 到「檢視決策」用審核模式一次過。")
                  .replace("{n}", String(report.pendingCount))}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
