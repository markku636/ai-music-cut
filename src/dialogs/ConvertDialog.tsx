import { useEffect, useMemo, useState } from "react";
import { FileMusic, FolderOpen, Plus, X } from "lucide-react";
import { api, type MediaProbe } from "../api";
import { MEDIA_EXTENSIONS, VIDEO_EXTENSIONS } from "../brand";
import { DEFAULT_CONVERT, describeConvert, willCopy, type ConvertOptions } from "../analysis/convertPlan";
import { FORMATS, RENDER_FORMATS, type BitDepth, type RenderFormat } from "../analysis/formats";
import { useT } from "../i18n";
import { planOutPaths, runConvertBatch, type ConvertResult } from "../pipeline/convert";
import { useProject } from "../store/project";
import { useUi } from "../store/ui";
import { Button, Field, Modal, Select, Spinner } from "../ui/index";
import { pickDirectory, pickOpenFiles, toast } from "../ui";

/**
 * 轉檔 / 批次轉檔 / 從影片抽聲軌：都是同一件事 —— 幾個來源、一組選項、逐檔跑。
 * 「從影片抽出聲軌」只是把影片檔加進來（每個 ffmpeg 呼叫本來就 -vn）。
 * 簡易模式只露格式與「正規化」；取樣率 / 聲道 / 位元深度收進進階。
 */
export default function ConvertDialog({ paths: initialPaths, onClose }: { paths?: string[]; onClose: () => void }) {
  const t = useT();
  const simple = useUi((s) => s.mode === "simple");
  const media = useProject((s) => s.media);
  const [paths, setPaths] = useState<string[]>(() => initialPaths ?? []);
  const [probes, setProbes] = useState<Record<string, MediaProbe | null>>({});
  const [opts, setOpts] = useState<ConvertOptions>(DEFAULT_CONVERT);
  const [normalize, setNormalize] = useState(false);
  const [outDir, setOutDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ConvertResult[] | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    for (const p of paths) {
      if (p in probes) continue;
      setProbes((cur) => ({ ...cur, [p]: null }));
      api
        .mediaProbe(p)
        .then((pr) => setProbes((cur) => ({ ...cur, [p]: pr })))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paths]);

  const effective: ConvertOptions = { ...opts, targetLufs: normalize ? -16 : null };
  const outs = useMemo(() => planOutPaths(paths, { ...effective, outDir }), [paths, effective.format, outDir]); // eslint-disable-line react-hooks/exhaustive-deps
  const caps = FORMATS[effective.format];

  const addFiles = async () => {
    const list = await pickOpenFiles([
      { name: t("音訊 / 影片"), extensions: MEDIA_EXTENSIONS },
      { name: t("影片"), extensions: VIDEO_EXTENSIONS },
    ]);
    if (!list?.length) return;
    setPaths((cur) => [...cur, ...list.filter((p) => !cur.includes(p))]);
    setResults(null);
  };
  const addFromProject = () => {
    setPaths((cur) => [...cur, ...media.map((m) => m.path).filter((p) => !cur.includes(p))]);
    setResults(null);
  };
  const remove = (p: string) => setPaths((cur) => cur.filter((x) => x !== p));

  const run = async () => {
    if (!paths.length) return;
    setBusy(true);
    setResults([]);
    try {
      const rs = await runConvertBatch(paths, { ...effective, outDir }, (_i, r) => setResults((cur) => [...(cur ?? []), r]));
      const ok = rs.filter((r) => r.ok).length;
      if (ok === rs.length) toast.success(t("轉好了：{n} 個檔案", { n: ok }));
      else toast.info(t("轉好 {ok} 個，{bad} 個失敗", { ok, bad: rs.length - ok }));
    } finally {
      setBusy(false);
    }
  };

  const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={t("轉檔・抽聲軌")}
      icon={FileMusic}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {results ? t("關閉") : t("取消")}
          </Button>
          <Button variant="primary" onClick={() => void run()} disabled={busy || !paths.length} data-testid="convert-go">
            {busy ? <Spinner size={13} /> : null}
            {t("開始轉檔")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="text-fg/70">{t("把音檔（或影片）換成別的格式。影片只會拿走聲音。幾個檔一起選就是批次。")}</div>

        <div className="rounded-md border border-fg/10 divide-y divide-fg/10 max-h-48 overflow-auto" data-testid="convert-list">
          {paths.length === 0 && <div className="px-3 py-4 text-xs text-fg/45 text-center">{t("還沒有檔案：按下面「加檔案」，或把檔案拖進來")}</div>}
          {paths.map((p, i) => {
            const pr = probes[p];
            const r = results?.find((x) => x.src === p);
            const copy = willCopy(effective, pr?.audio);
            return (
              <div key={p} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                <span className="truncate flex-1" title={p}>
                  {fileName(p)}
                  {pr?.video && <span className="ml-1 text-fg/40">{t("（影片）")}</span>}
                </span>
                <span className="mono text-fg/45 tabular-nums">{pr ? `${(pr.duration_ms / 1000).toFixed(0)}s · ${pr.audio?.codec ?? "?"}` : pr === null ? "…" : ""}</span>
                {r ? (
                  <span className={r.ok ? "text-emerald-400" : "text-rose-400"} title={r.error ?? r.outPath}>
                    {r.ok ? (r.done?.copied ? t("已複製") : t("已轉檔")) : t("失敗")}
                    {r.done?.dropped.length ? ` · ${t("沒帶到：{items}", { items: r.done.dropped.join("、") })}` : ""}
                  </span>
                ) : (
                  <span className="text-fg/40" title={outs[i]}>
                    → {fileName(outs[i])}
                    {copy ? ` · ${t("直接複製")}` : ""}
                  </span>
                )}
                {!busy && !results && (
                  <button type="button" onClick={() => remove(p)} className="text-fg/40 hover:text-fg/80" aria-label={t("移除")}>
                    <X size={12} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" icon={Plus} onClick={() => void addFiles()} disabled={busy}>
            {t("加檔案…")}
          </Button>
          {media.length > 0 && (
            <Button size="sm" variant="ghost" onClick={addFromProject} disabled={busy}>
              {t("加媒體清單裡的")}
            </Button>
          )}
        </div>

        <Field label={t("格式")} hint={t(caps.note)}>
          <Select
            value={effective.format}
            onChange={(e) => setOpts((o) => ({ ...o, format: e.target.value as RenderFormat }))}
            data-testid="convert-format"
          >
            {RENDER_FORMATS.map((f) => (
              <option key={f} value={f}>
                {FORMATS[f].label}
              </option>
            ))}
          </Select>
        </Field>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-1" checked={normalize} onChange={(e) => setNormalize(e.target.checked)} />
          <span>
            {t("正規化到 −16 LUFS")}
            <span className="block text-[11px] text-fg/45">{t("Podcast 平台的標準響度；勾了就一定重新編碼")}</span>
          </span>
        </label>
        {!simple && (
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={opts.copyIfPossible} onChange={(e) => setOpts((o) => ({ ...o, copyIfPossible: e.target.checked }))} />
            <span>
              {t("能直接複製就不重新編碼")}
              <span className="block text-[11px] text-fg/45">{t("mp4 裡的 aac → m4a 這種：零損失、幾百毫秒")}</span>
            </span>
          </label>
        )}
        {!simple && (
          <div>
            <button type="button" onClick={() => setShowAdvanced((v) => !v)} className="text-xs text-fg/55 hover:text-fg/85">
              {showAdvanced ? "▾" : "▸"} {t("進階")}
            </button>
            {showAdvanced && (
              <div className="mt-2 grid grid-cols-3 gap-3">
                <Field label={t("取樣率")}>
                  <Select value={String(opts.sampleRate)} onChange={(e) => setOpts((o) => ({ ...o, sampleRate: Number(e.target.value) as ConvertOptions["sampleRate"] }))}>
                    <option value="0">{t("沿用來源")}</option>
                    <option value="44100">44.1 kHz</option>
                    <option value="48000">48 kHz</option>
                  </Select>
                </Field>
                <Field label={t("聲道")}>
                  <Select value={String(opts.channels)} onChange={(e) => setOpts((o) => ({ ...o, channels: Number(e.target.value) as ConvertOptions["channels"] }))}>
                    <option value="0">{t("沿用來源")}</option>
                    <option value="1">{t("單聲道")}</option>
                    <option value="2">{t("立體聲")}</option>
                  </Select>
                </Field>
                <Field label={t("位元深度")}>
                  <Select value={String(opts.bitDepth)} onChange={(e) => setOpts((o) => ({ ...o, bitDepth: Number(e.target.value) as BitDepth }))} disabled={!caps.bitDepths.length}>
                    {(caps.bitDepths.length ? caps.bitDepths : [16]).map((b) => (
                      <option key={b} value={b}>
                        {b}-bit
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            )}
          </div>
        )}
        <Field label={t("輸出到")}>
          <div className="flex gap-2 items-center">
            <span className="flex-1 truncate text-xs text-fg/60" title={outDir ?? ""}>
              {outDir ?? t("各自放在來源旁邊")}
            </span>
            <Button size="sm" variant="secondary" icon={FolderOpen} onClick={() => void pickDirectory().then((d) => d && setOutDir(d))} disabled={busy}>
              {t("選資料夾…")}
            </Button>
            {outDir && (
              <Button size="sm" variant="ghost" onClick={() => setOutDir(null)} disabled={busy}>
                {t("清除")}
              </Button>
            )}
          </div>
        </Field>
        <div className="text-[11px] text-fg/45">{describeConvert(effective)}</div>
      </div>
    </Modal>
  );
}
