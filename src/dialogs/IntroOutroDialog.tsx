import { useMemo, useState } from "react";
import { Music } from "lucide-react";
import { AUDIO_EXTENSIONS } from "../brand";
import { placeBed } from "../analysis/bedPlacement";
import { errMessage } from "../api";
import { DEFAULT_DUCK, overlayId, planDuck, voiceRegionsInOutput, type Overlay } from "../analysis/overlays";
import { withUndoToast } from "../commands/undoToast";
import { useT } from "../i18n";
import { edlFor } from "../pipeline/rules";
import { useDecisions } from "../store/decisions";
import { useProject } from "../store/project";
import { useTranscript } from "../store/transcript";
import { Button, Field, Modal, Segmented } from "../ui/index";
import { pickOpenFile, toast } from "../ui";
import { formatMs } from "../time";

type Where = "intro" | "outro";

/**
 * 加片頭 / 片尾音樂（簡易模式那一顆）。選一個音樂檔 → 放到開頭或結尾 → 自動在講話時變小聲。
 * 專業模式的等價操作是波形右鍵「在這裡放配樂」+ 配樂右鍵「自動閃避」。
 */
export default function IntroOutroDialog({ mediaId, onClose }: { mediaId: string; onClose: () => void }) {
  const t = useT();
  const media = useProject((s) => s.media);
  const main = media.find((m) => m.id === mediaId) ?? null;
  const beds = media.filter((m) => m.id !== mediaId && m.probe);
  const [bedId, setBedId] = useState<string>(beds[0]?.id ?? "");
  const [where, setWhere] = useState<Where>("intro");
  const [gainDb, setGainDb] = useState(-12);
  const [duck, setDuck] = useState(true);
  const [busy, setBusy] = useState(false);
  const bed = media.find((m) => m.id === bedId) ?? null;

  const pickBed = async () => {
    const p = await pickOpenFile([{ name: t("音訊"), extensions: AUDIO_EXTENSIONS }]);
    if (!p) return;
    setBusy(true);
    const prev = useProject.getState().activeMediaId;
    try {
      await useProject.getState().openMedia(p);
      // openMedia 會把新檔切成 active —— 這裡只是拿它當配樂，主角還是原本那一集
      if (prev) useProject.getState().setActive(prev);
      const added = useProject.getState().media.find((m) => m.path === p);
      if (added) setBedId(added.id);
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(false);
    }
  };

  // 成品長度與落點只算一份：畫面上先講的跟按下去真的做的必須是同一個答案，
  // 各算一次的話兩邊會慢慢漂開，而且不會有人發現。
  const outLen = useMemo(() => {
    const edl = edlFor(mediaId);
    return edl && edl.keeps.length ? Math.max(...edl.keeps.map((k) => k.outEndMs)) : (main?.probe?.duration_ms ?? 0);
    // 對話框開著的期間 EDL 不會變（沒有東西可以在這裡改剪輯），所以不必訂閱 decisions。
    // 但拉音量滑桿會重繪，`edlFor` 每次都算一遍太貴 —— 所以還是要 memo。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaId, main]);
  const place = bed?.probe ? placeBed(where, bed.probe.duration_ms, outLen) : null;

  const apply = async () => {
    if (!bed?.probe || !main || !place) return;
    const edl = edlFor(mediaId);
    const bedDur = bed.probe.duration_ms;
    const outStartMs = place.outStartMs;
    const o: Overlay = {
      id: overlayId("music", outStartMs),
      lane: "music",
      mediaId: bed.id,
      srcInMs: 0,
      srcOutMs: bedDur,
      outStartMs,
      gainDb,
      fadeInMs: 2000,
      fadeOutMs: 2000,
      role: where === "intro" ? "intro" : "outro",
    };
    if (duck && edl) {
      const tr = useTranscript.getState().byMedia[mediaId];
      const vad = tr?.vad ?? [];
      // 沒有逐字稿時退回「保留段就是人聲」：粗，但總比什麼都不閃避好
      const regions = vad.length ? vad : edl.keeps.map((k) => ({ startMs: k.srcStartMs, endMs: k.srcEndMs }));
      const pts = planDuck(voiceRegionsInOutput(regions, edl.keeps), o, DEFAULT_DUCK);
      if (pts.length) o.points = pts;
    }
    await withUndoToast(where === "intro" ? t("已加上片頭音樂") : t("已加上片尾音樂"), () =>
      useDecisions.getState().addOverlays(mediaId, [o], where === "intro" ? "加入片頭音樂" : "加入片尾音樂"),
    );
    onClose();
  };

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={t("加片頭 / 片尾音樂")}
      icon={Music}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("取消")}
          </Button>
          <Button variant="primary" onClick={() => void apply()} disabled={busy || !bed?.probe} data-testid="introoutro-apply">
            {t("放上去")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="text-fg/70">{t("選一個音樂檔，放到開頭或結尾。講話的時候音樂會自動變小聲。")}</div>
        {place && (
          // 按下去**之前**就講清楚會放在哪 —— 尤其是「音樂比節目長」那一種：
          // 片尾的起點會被夾到 0，使用者要的是片尾，拿到的是一整集的墊樂。
          <div className={`rounded-sm px-2 py-1.5 text-xs ${place.longerThanEpisode ? "bg-warning/15 text-warning" : "bg-inset/60 text-fg/60"}`}>
            <div className="tabular-nums">
              {t("會放在成品的 {from} – {to}（節目長 {len}）", {
                from: formatMs(place.outStartMs, { millis: false }),
                to: formatMs(place.outEndMs, { millis: false }),
                len: formatMs(outLen, { millis: false }),
              })}
            </div>
            {place.longerThanEpisode && <div className="mt-0.5">{t("這個音樂比節目還長，會從頭蓋到尾。想要真的當片尾的話，換一段短一點的。")}</div>}
            {!place.longerThanEpisode && place.extendsOutputMs > 0 && (
              <div className="mt-0.5">{t("成品會因此變長 {ms}", { ms: formatMs(place.extendsOutputMs, { millis: false }) })}</div>
            )}
          </div>
        )}
        <Field label={t("音樂檔")}>
          <div className="flex gap-2 items-center">
            <select value={bedId} onChange={(e) => setBedId(e.target.value)} className="flex-1 h-8 rounded-sm bg-inset border border-fg/10 text-sm px-2" disabled={busy}>
              {!beds.length && <option value="">{t("還沒有音樂檔")}</option>}
              {beds.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
            <Button variant="secondary" onClick={() => void pickBed()} disabled={busy}>
              {t("選音樂檔…")}
            </Button>
          </div>
        </Field>
        <Field label={t("放在哪裡")}>
          <Segmented<Where>
            value={where}
            onChange={setWhere}
            options={[
              { value: "intro", label: t("片頭") },
              { value: "outro", label: t("片尾") },
            ]}
          />
        </Field>
        <Field label={`${t("音量")}　${gainDb} dB`} hint={t("−12 dB 是聽得到但不搶戲的位置")}>
          <input type="range" min={-30} max={0} step={1} value={gainDb} onChange={(e) => setGainDb(Number(e.target.value))} className="w-full" />
        </Field>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-1" checked={duck} onChange={(e) => setDuck(e.target.checked)} />
          <span>
            {t("自動在講話時變小聲")}
            <span className="block text-[11px] text-fg/45">{t("人聲開口前先壓下去、講完再回來；控制點畫在音樂條上，每一個都能拖")}</span>
          </span>
        </label>
      </div>
    </Modal>
  );
}
