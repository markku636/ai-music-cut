import { useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { Pause, Play, Sparkles, Wand2 } from "lucide-react";
import { api, errMessage } from "../api";
import { CLEANUP_OFF, describeCleanup, estimateCleanup, isCleanupActive, type CleanupSpec } from "../analysis/cleanup";
import { Button, Field, Modal, Spinner } from "../ui/index";
import { toast } from "../ui";
import { useT } from "../i18n";
import { runRender } from "../pipeline/render";
import { useCleanup } from "../store/cleanup";
import { usePlayback } from "../store/playback";
import { useProject } from "../store/project";
import { useTimeline } from "../store/timeline";
import { useTranscript } from "../store/transcript";
import { formatMs } from "../time";

/** A/B 試聽的長度：夠聽出底噪有沒有被壓下去，又不用等太久。 */
const AB_MS = 8000;

/**
 * 修聲：去隆隆聲 / 降噪 / 齒音。
 *
 * 這三件事都是「聽了才知道有沒有比較好」，所以整個對話框繞著 A/B 試聽設計 ——
 * 左邊原始、右邊修過，同一段、同一個位置，來回按。
 * 數字（底噪多少 dB）只是解釋「為什麼建議這樣」，不是要使用者盯著數字調。
 */
export default function CleanupDialog({ mediaId, onClose }: { mediaId: string; onClose: () => void }) {
  const t = useT();
  const local = useTranscript((s) => s.local[mediaId] ?? null);
  const stored = useCleanup((s) => s.byMedia[mediaId] ?? null);
  const setStored = useCleanup((s) => s.set);
  const selection = useTimeline((s) => s.selection);
  const currentMs = usePlayback((s) => s.currentMs);

  const est = useMemo(() => estimateCleanup(local), [local]);
  const [spec, setSpec] = useState<CleanupSpec>(stored ?? est.suggested);
  const [busy, setBusy] = useState(false);
  const [ab, setAb] = useState<{ dry: string; wet: string } | null>(null);
  const [playing, setPlaying] = useState<"dry" | "wet" | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  // 試聽哪一段：有選取就用選取的開頭，否則從播放線開始
  const abStart = Math.max(0, selection ? selection.startMs : currentMs);
  const abRange = { startMs: abStart, endMs: abStart + AB_MS };
  const patch = (p: Partial<CleanupSpec>) => {
    setSpec((s) => ({ ...s, ...p }));
    setAb(null); // 設定一改，手上那兩份試聽檔就過期了
  };

  const stop = () => {
    audio.current?.pause();
    setPlaying(null);
  };

  const play = (which: "dry" | "wet") => {
    if (!ab) return;
    if (playing === which) return stop();
    stop();
    const el = audio.current;
    if (!el) return;
    el.src = convertFileSrc(which === "dry" ? ab.dry : ab.wet);
    el.currentTime = 0;
    setPlaying(which);
    void el.play().catch(() => setPlaying(null));
  };

  const buildAb = async () => {
    setBusy(true);
    stop();
    try {
      const paths = await api.appPaths();
      const sep = paths.cache_dir.includes("\\") ? "\\" : "/";
      const dir = `${paths.cache_dir}${sep}cleanup`;
      const dry = `${dir}${sep}ab-dry.mp3`;
      const wet = `${dir}${sep}ab-wet.mp3`;
      // 兩趟都走正式的 runRender（同一個剪接器、同一條濾鏡路徑），差別只有 cleanup。
      // cleanup: null 明確表示「這一趟不修聲」，不要退回去讀已存的設定。
      const base = { format: "mp3" as const, leveling: false, targetLufs: -16, preview: true, rangeMs: abRange };
      const a = await runRender(mediaId, { ...base, outPath: dry, cleanup: null });
      if (!a.ok) throw new Error(a.error ?? t("原始試聽渲染失敗"));
      const b = await runRender(mediaId, { ...base, outPath: wet, cleanup: spec });
      if (!b.ok) throw new Error(b.error ?? t("修聲試聽渲染失敗"));
      setAb({ dry, wet });
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const apply = () => {
    setStored(mediaId, isCleanupActive(spec) ? spec : null);
    useProject.getState().markDirty();
    toast.success(t("修聲已套用：{d}").replace("{d}", describeCleanup(isCleanupActive(spec) ? spec : null)));
    onClose();
  };

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={t("修聲")}
      icon={Wand2}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("取消")}
          </Button>
          <Button variant="primary" onClick={apply} disabled={busy}>
            {isCleanupActive(spec) ? t("套用") : t("關閉修聲")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="rounded-md border border-fg/10 px-3 py-2 text-xs text-fg/70">
          {local ? est.summary : t("還沒分析，沒有底噪可以量；可以先手動調，或先跑一次分析")}
        </div>

        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-1" checked={spec.rumbleHz > 0} onChange={(e) => patch({ rumbleHz: e.target.checked ? 80 : 0 })} />
          <span>
            {t("去隆隆聲（80 Hz 高通）")}
            <span className="block text-[11px] text-fg/45">{t("桌子撞擊、冷氣、腳步都在這之下；人聲基頻在這之上，幾乎沒有代價")}</span>
          </span>
        </label>

        <Field
          label={t("降噪 {n} dB").replace("{n}", String(spec.denoiseDb))}
          hint={spec.denoiseDb === 0 ? t("關閉") : spec.denoiseDb > 18 ? t("減太多，安靜的地方會出現水聲") : t("壓低麥克風本底與環境嘶聲")}
        >
          <input type="range" min={0} max={24} value={spec.denoiseDb} onChange={(e) => patch({ denoiseDb: Number(e.target.value) })} className="w-full" />
        </Field>

        <Field
          label={t("齒音抑制 {n}%").replace("{n}", String(Math.round(spec.deessAmount * 100)))}
          hint={spec.deessAmount === 0 ? t("關閉（沒有量測依據，建議聽過再開）") : t("壓下 ㄙ / ㄕ / s 的高頻突刺；過量人聲會變鈍")}
        >
          <input
            type="range"
            min={0}
            max={100}
            value={Math.round(spec.deessAmount * 100)}
            onChange={(e) => patch({ deessAmount: Number(e.target.value) / 100 })}
            className="w-full"
          />
        </Field>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" icon={Sparkles} onClick={() => patch(est.suggested)} disabled={!local}>
            {t("用建議值")}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => patch(CLEANUP_OFF)}>
            {t("全部關掉")}
          </Button>
        </div>

        <div className="rounded-md border border-fg/10 px-3 py-2 space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-fg/55">{t("A / B 試聽")}</span>
            <span className="mono text-fg/70 tabular-nums">
              {formatMs(abRange.startMs, { millis: false })} +{AB_MS / 1000}s
            </span>
            <Button size="sm" variant="secondary" className="ml-auto" onClick={() => void buildAb()} disabled={busy || !isCleanupActive(spec)}>
              {busy ? <Spinner size={13} /> : null}
              {ab ? t("重新產生") : t("產生兩份試聽")}
            </Button>
          </div>
          {ab ? (
            <div className="flex gap-2">
              <Button size="sm" variant={playing === "dry" ? "primary" : "secondary"} icon={playing === "dry" ? Pause : Play} onClick={() => play("dry")}>
                {t("原始")}
              </Button>
              <Button size="sm" variant={playing === "wet" ? "primary" : "secondary"} icon={playing === "wet" ? Pause : Play} onClick={() => play("wet")}>
                {t("修聲後")}
              </Button>
            </div>
          ) : (
            <div className="text-[11px] text-fg/40">
              {isCleanupActive(spec) ? t("按上面的按鈕算出同一段的兩個版本，來回聽比較準") : t("三項都關著，沒有東西可以比較")}
            </div>
          )}
        </div>

        <div className="text-[11px] text-fg/45">{t("修聲在響度正規化之前套用，輸出與預覽都會生效。")}</div>
        <audio ref={audio} onEnded={() => setPlaying(null)} className="hidden" />
      </div>
    </Modal>
  );
}
