import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Layers, Plus, X } from "lucide-react";
import { api, errMessage } from "../api";
import { AUDIO_EXTENSIONS } from "../brand";
import { effectiveJoinMs, mergeChannels, mergeOutPath, mergeTotalMs, moveItem, normalizeGains, type MergeChannelChoice, type MergeItem, type MergeJoin } from "../analysis/mergePlan";
import { loudnessProfile } from "../analysis/profile";
import { useT } from "../i18n";
import { newJobId, useJobs } from "../store/jobs";
import { useProject } from "../store/project";
import { useTranscript } from "../store/transcript";
import { formatMs } from "../time";
import { Button, Field, Modal, Segmented } from "../ui/index";
import { pickOpenFiles, pickSaveFile, toast } from "../ui";

/**
 * 合併檔案：幾個音檔接成一個（留白或交越），輸出 wav 放在第一個檔旁邊並加進媒體清單。
 * 不動任何來源檔。
 */
export default function MergeDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const media = useProject((s) => s.media);
  const [items, setItems] = useState<MergeItem[]>([]);
  const [join, setJoin] = useState<MergeJoin>("gap");
  const [joinMs, setJoinMs] = useState(500);
  const [level, setLevel] = useState(false);
  const [chan, setChan] = useState<MergeChannelChoice>("auto");
  const [outPath, setOutPath] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (items.length && !outPath) setOutPath(mergeOutPath(items[0].path));
  }, [items, outPath]);

  const addFiles = async () => {
    const list = await pickOpenFiles([{ name: t("音訊"), extensions: AUDIO_EXTENSIONS }]);
    if (!list?.length) return;
    const added: MergeItem[] = [];
    for (const p of list) {
      if (items.some((i) => i.path === p)) continue;
      const known = media.find((m) => m.path === p);
      let durationMs = known?.probe?.duration_ms ?? 0;
      let channels = known?.probe?.audio?.channels;
      if (!durationMs) {
        const pr = await api.mediaProbe(p).catch(() => null);
        durationMs = pr?.duration_ms ?? 0;
        channels = pr?.audio?.channels ?? channels;
      }
      const local = known ? useTranscript.getState().local[known.id] : null;
      const lufs = local ? (loudnessProfile(local)?.episodeLufs ?? null) : null;
      added.push({ id: `${p}#${Date.now()}`, path: p, name: p.split(/[\\/]/).pop() ?? p, durationMs, lufs, gainDb: 0, channels });
    }
    setItems((cur) => [...cur, ...added]);
  };
  const addFromProject = async () => {
    const added: MergeItem[] = [];
    for (const m of media) {
      if (items.some((i) => i.path === m.path)) continue;
      const local = useTranscript.getState().local[m.id];
      added.push({ id: m.id, path: m.path, name: m.name, durationMs: m.probe?.duration_ms ?? 0, lufs: local ? (loudnessProfile(local)?.episodeLufs ?? null) : null, gainDb: 0, channels: m.probe?.audio?.channels });
    }
    setItems((cur) => [...cur, ...added]);
  };

  const gains = level ? normalizeGains(items) : items.map((i) => i.gainDb);
  // 交越夾到最短檔的一半（跟送去 Rust 的值同一個），聲道 auto = 有立體聲就立體聲
  const effJoinMs = effectiveJoinMs(items, join, joinMs);
  const channels = mergeChannels(items, chan);
  const totalMs = mergeTotalMs(items, join, effJoinMs);

  const run = async () => {
    if (items.length < 2 || !outPath) return;
    setBusy(true);
    const jobs = useJobs.getState();
    const jobId = newJobId();
    jobs.upsert({ id: jobId, kind: "merge", step: t("合併"), pct: null, status: "running", message: outPath });
    try {
      const r = await api.mergeFiles({ inputs: items.map((i, k) => ({ path: i.path, gain_db: gains[k] })), join, join_ms: effJoinMs, channels, out_path: outPath });
      jobs.upsert({ id: jobId, status: "done", step: t("完成"), pct: 100, endedAt: Date.now() });
      // 產物加進媒體清單（不動來源）
      await useProject.getState().openMedia(r.out_path);
      toast.success(t("合併完成：{name}", { name: r.out_path.split(/[\\/]/).pop() ?? r.out_path }));
      onClose();
    } catch (e) {
      jobs.upsert({ id: jobId, status: "error", step: t("失敗"), error: errMessage(e), endedAt: Date.now() });
      toast.error(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={t("合併檔案")}
      icon={Layers}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("取消")}
          </Button>
          <Button variant="primary" onClick={() => void run()} disabled={busy || items.length < 2 || !outPath} data-testid="merge-go">
            {t("合併")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="text-fg/70">{t("把幾個音檔照順序接成一個。原檔不會動，合併好的新檔會加進媒體清單。")}</div>
        <div className="rounded-md border border-fg/10 divide-y divide-fg/10 max-h-56 overflow-auto" data-testid="merge-list">
          {items.length === 0 && <div className="px-3 py-4 text-xs text-fg/45 text-center">{t("還沒有檔案：按下面「加檔案」")}</div>}
          {items.map((it, i) => (
            <div key={it.id} className="flex items-center gap-2 px-3 py-1.5 text-xs">
              <span className="mono text-fg/40 w-5 text-right">{i + 1}</span>
              <span className="truncate flex-1" title={it.path}>
                {it.name}
              </span>
              <span className="mono text-fg/45 tabular-nums">{formatMs(it.durationMs, { millis: false })}</span>
              <span className="mono text-fg/45 tabular-nums w-14 text-right">{gains[i] ? `${gains[i] > 0 ? "+" : ""}${gains[i]} dB` : ""}</span>
              <button type="button" disabled={i === 0 || busy} onClick={() => setItems((cur) => moveItem(cur, i, i - 1))} className="text-fg/40 hover:text-fg/80 disabled:opacity-30" aria-label={t("上移")}>
                <ArrowUp size={12} />
              </button>
              <button type="button" disabled={i === items.length - 1 || busy} onClick={() => setItems((cur) => moveItem(cur, i, i + 1))} className="text-fg/40 hover:text-fg/80 disabled:opacity-30" aria-label={t("下移")}>
                <ArrowDown size={12} />
              </button>
              <button type="button" disabled={busy} onClick={() => setItems((cur) => cur.filter((x) => x.id !== it.id))} className="text-fg/40 hover:text-fg/80" aria-label={t("移除")}>
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" icon={Plus} onClick={() => void addFiles()} disabled={busy}>
            {t("加檔案…")}
          </Button>
          {media.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => void addFromProject()} disabled={busy}>
              {t("加媒體清單裡的")}
            </Button>
          )}
        </div>
        <Field label={t("接法")}>
          <Segmented<MergeJoin>
            value={join}
            onChange={setJoin}
            options={[
              { value: "gap", label: t("留白") },
              { value: "crossfade", label: t("交越") },
            ]}
          />
        </Field>
        <Field label={`${join === "gap" ? t("留白") : t("交越")}　${joinMs} ms`}>
          <input type="range" min={0} max={join === "gap" ? 5000 : 3000} step={50} value={joinMs} onChange={(e) => setJoinMs(Number(e.target.value))} className="w-full" />
          {join === "crossfade" && effJoinMs < joinMs && (
            <div className="text-[11px] text-amber-500/90 mt-1" data-testid="merge-xf-clamped">
              {t("最短的檔只有 {len}，交越縮成 {ms} ms（不能超過它的一半）", { len: formatMs(Math.min(...items.map((i) => i.durationMs)), { millis: false }), ms: effJoinMs })}
            </div>
          )}
        </Field>
        <Field label={t("聲道")}>
          <Segmented<MergeChannelChoice>
            value={chan}
            onChange={setChan}
            options={[
              { value: "auto", label: t("自動（{n}）", { n: channels === 2 ? t("立體聲") : t("單聲道") }) },
              { value: "1", label: t("單聲道") },
              { value: "2", label: t("立體聲") },
            ]}
          />
        </Field>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-1" checked={level} onChange={(e) => setLevel(e.target.checked)} />
          <span>
            {t("拉到同一響度")}
            <span className="block text-[11px] text-fg/45">{t("有分析過的檔才量得到；量不到的不動")}</span>
          </span>
        </label>
        <Field label={t("輸出到")}>
          <div className="flex gap-2 items-center">
            <span className="flex-1 truncate text-xs text-fg/60" title={outPath}>
              {outPath || "—"}
            </span>
            <Button size="sm" variant="secondary" onClick={() => void pickSaveFile(outPath, [{ name: "WAV", extensions: ["wav"] }]).then((p) => p && setOutPath(p))} disabled={busy}>
              {t("變更…")}
            </Button>
          </div>
        </Field>
        <div className="text-[11px] text-fg/45">{t("合計 {len}", { len: formatMs(totalMs, { millis: false }) })}</div>
      </div>
    </Modal>
  );
}
