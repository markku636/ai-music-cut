import { useEffect, useMemo, useRef, useState } from "react";
import { AlignHorizontalDistributeCenter } from "lucide-react";
import { errMessage } from "../api";
import { warpAt } from "../analysis/align/warp";
import { useT } from "../i18n";
import { analyzeAlignment, LOW_CONFIDENCE, MODE_PRESETS, renderAlignment, retighten, type AlignAnalysis, type AlignMode } from "../pipeline/align";
import { useProject } from "../store/project";
import { useTimeline } from "../store/timeline";
import { Button, Field, Modal, Segmented, Select, Spinner } from "../ui/index";
import { toast } from "../ui";

function cssRgb(varName: string, alpha = 1): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || "248 248 242";
  return `rgb(${v} / ${alpha})`;
}

/**
 * Guide / Dub 時間對齊（VocALign 的 Guide / Dub / Tightness）：
 * 選 guide（基準）與 dub（要扭的那軌）→ 用途 → 分析 → 三車道看結果 → 輸出 `_aligned.wav`。
 * 只做時間、不做音高。
 */
export default function AlignDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const media = useProject((s) => s.media.filter((m) => m.probe));
  const activeId = useProject((s) => s.activeMediaId);
  const selection = useTimeline((s) => s.selection);
  const [guideId, setGuideId] = useState<string>(activeId ?? media[0]?.id ?? "");
  const [dubId, setDubId] = useState<string>(media.find((m) => m.id !== (activeId ?? media[0]?.id))?.id ?? "");
  const [mode, setMode] = useState<AlignMode>("adr");
  const [tightness, setTightness] = useState<number>(MODE_PRESETS.adr.tightness);
  const [useSelection, setUseSelection] = useState<boolean>(!!selection);
  const [busy, setBusy] = useState<null | "analyze" | "render">(null);
  const [result, setResult] = useState<AlignAnalysis | null>(null);
  const [verdict, setVerdict] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    setTightness(MODE_PRESETS[mode].tightness);
    setResult(null);
  }, [mode]);

  const run = async () => {
    if (!guideId || !dubId) return;
    setBusy("analyze");
    setVerdict(null);
    try {
      const r = await analyzeAlignment(guideId, dubId, { mode, tightness, guideRange: useSelection && selection && guideId === activeId ? selection : null });
      setResult(r);
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  // tightness 一動：純 TS 重算（< 0.5 s），不用重跑 DTW
  const onTightness = (v: number) => {
    setTightness(v);
    if (result) setResult(retighten(result, v));
  };

  const render = async () => {
    if (!result) return;
    setBusy("render");
    try {
      const r = await renderAlignment(result);
      setVerdict(r.verdict?.summary ?? null);
      if (r.verdict && !r.verdict.ok) toast.info(r.verdict.summary);
      else toast.success(t("已輸出對齊檔：{name}", { name: r.outPath.split(/[\\/]/).pop() ?? r.outPath }));
    } catch (e) {
      toast.error(errMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const summaryText = useMemo(() => {
    if (!result) return null;
    const s = result.summary;
    const driftPerHour = (s.slope - 1) * 3600;
    const parts = [
      t("位移 {ms} ms", { ms: Math.round(s.offsetMs) }),
      t("最大偏差 {ms} ms", { ms: Math.round(s.maxDeviationMs) }),
      Math.abs(driftPerHour) > 0.05 ? t("漂移 {s} 秒 / 小時", { s: driftPerHour.toFixed(2) }) : null,
      result.resampleRatio ? t("只需重取樣") : t("{n} 段速率", { n: result.segments.length }),
      t("信心 {pct}%", { pct: Math.round(result.confidence * 100) }),
    ].filter(Boolean);
    return parts.join(" · ");
  }, [result, t]);

  // 三車道：guide / dub / 對齊後（dub 依 warp 重取樣預覽）
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !result) return;
    const w = cv.clientWidth;
    const h = 120;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const { guide, dub, hopMs, guideStartMs, dubStartMs } = result.lanes;
    const laneH = h / 3;
    const totalMs = Math.max(guide.length, dub.length) * hopMs;
    const x = (ms: number) => (ms / totalMs) * w;
    const drawLane = (env: Float32Array, startMs: number, top: number, color: string, mapMs?: (ms: number) => number) => {
      ctx.fillStyle = color;
      for (let i = 0; i < env.length; i++) {
        const ms0 = startMs + i * hopMs;
        const ms = mapMs ? mapMs(ms0) : ms0;
        const px = x(ms - Math.min(guideStartMs, dubStartMs));
        if (px < 0 || px > w) continue;
        const v = env[i];
        const bh = Math.max(1, v * (laneH - 4));
        ctx.fillRect(px, top + laneH - 2 - bh, Math.max(1, w / (totalMs / hopMs)), bh);
      }
    };
    drawLane(guide, guideStartMs, 0, cssRgb("--c-fg", 0.55));
    drawLane(dub, dubStartMs, laneH, cssRgb("--c-accent", 0.55));
    drawLane(dub, dubStartMs, laneH * 2, cssRgb("--c-accent", 0.9), (ms) => warpAt(result.points, ms));
    ctx.fillStyle = cssRgb("--c-fg", 0.5);
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText("Guide", 4, 11);
    ctx.fillText("Dub", 4, laneH + 11);
    ctx.fillText(t("對齊後"), 4, laneH * 2 + 11);
  }, [result, t]);

  const low = result && result.confidence < LOW_CONFIDENCE;

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={t("對齊（Guide / Dub）")}
      icon={AlignHorizontalDistributeCenter}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy !== null}>
            {t("關閉")}
          </Button>
          <Button variant="secondary" onClick={() => void run()} disabled={busy !== null || !guideId || !dubId || guideId === dubId} data-testid="align-analyze">
            {busy === "analyze" ? <Spinner size={13} /> : null}
            {t("分析")}
          </Button>
          <Button variant="primary" onClick={() => void render()} disabled={busy !== null || !result} data-testid="align-render">
            {busy === "render" ? <Spinner size={13} /> : null}
            {t("輸出對齊檔")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="text-fg/70">{t("把 Dub 在時間上扭到跟 Guide 對齊（補錄對回原位、多麥時鐘漂移、人聲疊錄）。只做時間，不做音高。原檔不動，輸出 _aligned.wav 加進媒體清單。")}</div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("Guide（基準）")}>
            <Select value={guideId} onChange={(e) => { setGuideId(e.target.value); setResult(null); }} disabled={busy !== null}>
              {media.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t("Dub（要扭的那軌）")}>
            <Select value={dubId} onChange={(e) => { setDubId(e.target.value); setResult(null); }} disabled={busy !== null}>
              {media.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label={t("用途")}>
          <Segmented<AlignMode>
            value={mode}
            onChange={setMode}
            options={[
              { value: "adr", label: t("補錄一句") },
              { value: "drift", label: t("多麥漂移") },
              { value: "music", label: t("疊錄 / 和聲") },
            ]}
          />
        </Field>
        {selection && guideId === activeId && (
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={useSelection} onChange={(e) => setUseSelection(e.target.checked)} />
            <span>
              {t("Guide 只看目前選取的那一段")}
              <span className="block text-[11px] text-fg/45">{t("補錄一句時選原句所在的位置，對得又快又準")}</span>
            </span>
          </label>
        )}
        <Field label={`${t("Tightness")}　${tightness}`} hint={t("0 = 只做整體位移（等於「同步麥克風」）；100 = 貼到每個字。太緊會有 warble。")}>
          <input type="range" min={0} max={100} step={5} value={tightness} onChange={(e) => onTightness(Number(e.target.value))} className="w-full" disabled={busy !== null} />
        </Field>
        {result && (
          <div className="space-y-2">
            <div className={`rounded-md border px-3 py-2 text-xs ${low ? "border-amber-500/40 text-amber-300" : "border-fg/10 text-fg/70"}`} data-testid="align-summary">
              {low ? `${t("可能沒對上")}：` : ""}
              {summaryText}
              {mode === "music" && <span className="block text-fg/45">{t("這一版疊錄對齊用能量包絡，長音裡的路徑可能較鬆；tightness 拉低一點會比較自然")}</span>}
            </div>
            <canvas ref={canvasRef} className="w-full rounded-md bg-well" style={{ height: 120 }} data-testid="align-lanes" />
          </div>
        )}
        {verdict && <div className="text-xs text-fg/60">{verdict}</div>}
      </div>
    </Modal>
  );
}
