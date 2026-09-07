import { useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FolderOpen, Layers, XCircle } from "lucide-react";
import {
  DEFAULT_BATCH_STEPS,
  runBatch,
  summarizeBatch,
  type BatchItemResult,
  type BatchProgress,
  type BatchStepKey,
  type BatchSteps,
} from "../pipeline/batch";
import type { RenderFormat } from "../pipeline/render";
import { api } from "../api";
import { Button, Modal, Select } from "../ui/index";
import { toast } from "../ui";
import { useT } from "../i18n";
import { useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { useTranscript } from "../store/transcript";

/**
 * 批次處理。
 *
 * 一個週更的節目手上常常同時有好幾集（補錄的、上週沒剪完的、分段錄的），
 * 而這個 App 的每一步本來就吃 mediaId —— 缺的只是外面那一圈編排。
 *
 * 對話框刻意做成「跑之前看得到會做什麼、跑完看得到每一集發生什麼」：
 * 批次最讓人不敢按的就是它是個黑盒子，跑完只給一句「完成」。
 */

const STEP_ROWS: { key: BatchStepKey; label: string; hint: string }[] = [
  { key: "analyze", label: "分析（轉寫 + 規則）", hint: "已經有逐字稿的會自動跳過 —— 這是整條路上最慢也最花錢的一步" },
  { key: "autoCut", label: "一鍵智慧剪輯", hint: "只做規則層有把握的部分；含糊、離題、重講一律留著問人" },
  { key: "judge", label: "AI 判讀（剪輯＋審核）", hint: "慢，而且每一集都要花模型的錢。預設關。" },
  { key: "render", label: "輸出成品", hint: "檔名是「原檔名_cut」，放在設定的輸出資料夾或來源旁邊" },
];

function fmt(ms: number): string {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`;
}

export default function BatchDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const media = useProject((s) => s.media);
  const transcripts = useTranscript((s) => s.byMedia);
  const settings = useSettings((s) => s.s);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(media.map((m) => m.id)));
  const [steps, setSteps] = useState<BatchSteps>(DEFAULT_BATCH_STEPS);
  const [format, setFormat] = useState<RenderFormat>("mp3");
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState<BatchProgress | null>(null);
  const [results, setResults] = useState<BatchItemResult[] | null>(null);
  const cancelled = useRef(false);

  const ids = media.filter((m) => picked.has(m.id)).map((m) => m.id);
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const run = async () => {
    cancelled.current = false;
    setBusy(true);
    setResults(null);
    try {
      const r = await runBatch(ids, {
        steps,
        format,
        onProgress: setProg,
        isCancelled: () => cancelled.current,
      });
      setResults(r);
      const s = summarizeBatch(r);
      if (s.failed) toast.error(t("批次完成：{d} 集成功、{f} 集失敗", { d: s.done, f: s.failed }));
      else if (s.canceled) toast.info(t("已取消（做完的那幾集保留著）"));
      else toast.success(t("批次完成：{d} 集，共省 {s}", { d: s.done, s: fmt(s.savedMs) }));
    } finally {
      setBusy(false);
      setProg(null);
    }
  };

  const summary = results ? summarizeBatch(results) : null;

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={t("批次處理")}
      icon={Layers}
      size="lg"
      footer={
        busy ? (
          <Button variant="ghost" onClick={() => (cancelled.current = true)}>
            {t("取消（做完的那幾集會保留）")}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t("關閉")}
            </Button>
            <Button variant="primary" icon={Layers} disabled={!ids.length} onClick={() => void run()}>
              {t("開始（{n} 集）", { n: ids.length })}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3 text-sm">
        {busy && prog && (
          <div className="rounded-md border border-accent/25 bg-accent/6 px-3 py-2 space-y-1">
            <div className="flex items-baseline gap-2 text-[12px]">
              <span className="tabular-nums text-fg/50">
                {prog.index}/{prog.total}
              </span>
              <span className="font-medium truncate">{prog.name}</span>
              <span className="ml-auto text-fg/60">{prog.label}</span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-fg/10">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300"
                style={{ width: `${Math.round((prog.ratio ?? 0.5) * 100)}%` }}
              />
            </div>
          </div>
        )}

        {!busy && (
          <>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="text-[11px] uppercase tracking-wide text-fg/35">{t("要處理哪幾集")}</span>
                <button
                  type="button"
                  className="text-[11px] text-fg/40 hover:text-fg/70"
                  onClick={() => setPicked(new Set(picked.size === media.length ? [] : media.map((m) => m.id)))}
                >
                  {picked.size === media.length ? t("全部取消") : t("全選")}
                </button>
              </div>
              {media.length === 0 ? (
                <div className="text-[12px] text-fg/45">{t("媒體清單是空的 —— 先開幾個音檔進來。")}</div>
              ) : (
                <div className="max-h-[24vh] overflow-y-auto space-y-0.5">
                  {media.map((m) => (
                    <label key={m.id} className="flex items-center gap-2 px-1.5 py-1 rounded-sm hover:bg-fg/5 cursor-pointer">
                      <input type="checkbox" checked={picked.has(m.id)} onChange={() => toggle(m.id)} />
                      <span className="flex-1 min-w-0 truncate">{m.name}</span>
                      {transcripts[m.id] && <span className="text-[10px] text-success/80 shrink-0">{t("已有逐字稿")}</span>}
                      <span className="text-[11px] text-fg/35 tabular-nums shrink-0">
                        {m.probe ? fmt(m.probe.duration_ms) : "—"}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="text-[11px] uppercase tracking-wide text-fg/35 mb-1">{t("每一集要做什麼")}</div>
              <div className="space-y-0.5">
                {STEP_ROWS.map((r) => (
                  <label key={r.key} className="flex items-start gap-2 px-1.5 py-1 rounded-sm hover:bg-fg/5 cursor-pointer">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={steps[r.key]}
                      onChange={(e) => setSteps((s) => ({ ...s, [r.key]: e.target.checked }))}
                    />
                    <span className="min-w-0">
                      <span className="text-fg/85">{t(r.label)}</span>
                      <span className="block text-[10px] text-fg/40 leading-snug">{t(r.hint)}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[11px] text-fg/50">{t("輸出格式")}</span>
              <span className="w-24">
                <Select value={format} disabled={!steps.render} onChange={(e) => setFormat(e.target.value as RenderFormat)}>
                  <option value="mp3">mp3</option>
                  <option value="m4a">m4a</option>
                  <option value="wav">wav</option>
                </Select>
              </span>
              <span className="text-[11px] text-fg/35 truncate">
                {settings.output_dir ? settings.output_dir : t("放在來源檔旁邊（可到設定改輸出資料夾）")}
              </span>
            </div>

            <p className="text-[11px] text-fg/45 leading-relaxed">
              {t("一次只跑一集：轉寫伺服器有排隊上限、GPU 只有一張、響度正規化是兩趟 CPU 重活 —— 平行不會比較快，只會讓三個瓶頸互相踩。某一集失敗不會影響其他集。")}
            </p>
          </>
        )}

        {summary && results && (
          <div className="space-y-2">
            <div className="rounded-md border border-fg/10 px-3 py-2 text-[12px]">
              {t("{d} 集完成、{f} 集失敗；共省 {s}（{p}%）", {
                d: summary.done,
                f: summary.failed,
                s: fmt(summary.savedMs),
                p: (summary.ratio * 100).toFixed(1),
              })}
            </div>
            <div className="max-h-[32vh] overflow-y-auto space-y-1">
              {results.map((r) => (
                <div key={r.mediaId} className="rounded-sm border border-fg/8 px-2 py-1.5 text-[12px]">
                  <div className="flex items-center gap-1.5">
                    {r.status === "done" ? (
                      <CheckCircle2 size={13} className="text-success shrink-0" />
                    ) : r.status === "failed" ? (
                      <XCircle size={13} className="text-danger shrink-0" />
                    ) : (
                      <AlertTriangle size={13} className="text-warning shrink-0" />
                    )}
                    <span className="flex-1 min-w-0 truncate">{r.name}</span>
                    {r.status === "done" && <span className="text-fg/50 tabular-nums shrink-0">{t("省 {s}", { s: fmt(r.savedMs) })}</span>}
                  </div>
                  {r.error && <div className="pl-5 text-[11px] text-danger/85 break-all">{r.error}</div>}
                  {!!r.steps.length && (
                    <div className="pl-5 text-[11px] text-fg/40">
                      {r.steps
                        .map((s) => `${t(STEP_ROWS.find((x) => x.key === s.key)?.label ?? s.key)}${s.skipped ? `（${t("跳過")}${s.note ? "：" + s.note : ""}）` : s.note ? `：${s.note}` : ""}`)
                        .join(" · ")}
                    </div>
                  )}
                  {r.outPath && (
                    <button
                      type="button"
                      onClick={() => void api.openPath(r.outPath!).catch(() => {})}
                      className="pl-5 text-[11px] text-accent/85 hover:underline inline-flex items-center gap-1 break-all text-left"
                    >
                      <FolderOpen size={11} />
                      {r.outPath}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
