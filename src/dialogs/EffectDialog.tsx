import { useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, Sparkles } from "lucide-react";
import { renderAbPair, abWindow } from "../effects/preview";
import { applyEffect, effectContext, effectSpec, rangeFor } from "../effects/registry";
import { advancedParams, mainParams, matchingPreset, resolveValues, type ParamSpec, type ParamValue, type ParamValues, type Suggestion } from "../effects/spec";
import { useT } from "../i18n";
import { useAbPreview } from "../preview/useAbPreview";
import { useUi } from "../store/ui";
import { formatMs } from "../time";
import { Button, Field, Modal, Select, Spinner } from "../ui/index";
import { toast } from "../ui";

/**
 * 通用效果對話框：blurb → 主參數（≤3）→ 預設 chips → A/B 試聽 → 進階（可收合）→ 取消 / 套用。
 * 簡易模式只畫 primary 那一根滑桿，進階整段藏起來。長什麼樣由 EffectSpec 決定，這裡只是畫。
 */
export default function EffectDialog({
  mediaId: mediaIdProp,
  specId,
  initial,
  range: rangeProp,
  onClose,
}: {
  mediaId: string;
  specId: string;
  initial?: Partial<ParamValues>;
  range?: { startMs: number; endMs: number } | null;
  onClose: () => void;
}) {
  const t = useT();
  const simple = useUi((s) => s.mode === "simple");
  const spec = effectSpec(specId);
  // 開對話框當下的媒體與範圍就定下來 —— 使用者中途切檔 / 改選取不該讓「套用」跑到別的地方
  const [mediaId] = useState(mediaIdProp);
  const [ctx] = useState(() => effectContext(mediaId));
  const [range] = useState(() => rangeProp ?? (spec ? rangeFor(spec, ctx) : null));
  const syncSuggestion = useMemo(() => (spec && range ? (spec.suggest?.(ctx, range) ?? null) : null), [spec, ctx, range]);
  // 要真的量過才知道的建議（嗡聲偵測…）：開了對話框才跑，回來後蓋過同步的那份
  const [asyncSuggestion, setAsyncSuggestion] = useState<Suggestion | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const suggestion = asyncSuggestion ?? syncSuggestion;
  const [values, setValues] = useState<ParamValues>(() => (spec ? resolveValues(spec, null, initial ?? syncSuggestion?.values ?? null) : {}));
  const [showAdvanced, setShowAdvanced] = useState(false);
  // 使用者動過參數之後，量測結果就只顯示不覆蓋
  const touched = useRef(false);

  const ab = useAbPreview(() => {
    if (!spec || !range) throw new Error(t("沒有可以試聽的內容"));
    // 範圍濾波（降噪…）有自己的試聽路徑：對來源檔直接切一段，不用等 Cutter 從 0 剪到這裡
    if (spec.preview) return spec.preview(values, range, ctx);
    return renderAbPair(mediaId, range, spec.build(values, range, ctx));
  });

  useEffect(() => {
    if (!spec?.analyze || !range || initial) return;
    let alive = true;
    setAnalyzing(true);
    spec
      .analyze(ctx, range)
      .then((s) => {
        if (!alive || !s) return;
        setAsyncSuggestion(s);
        if (!touched.current) {
          setValues(resolveValues(spec, null, s.values));
          ab.invalidate();
        }
      })
      .catch(() => {})
      .finally(() => alive && setAnalyzing(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, range]);

  if (!spec) return null;
  if (!range) {
    return (
      <Modal open onClose={onClose} title={t(spec.title)} icon={spec.icon} size="sm" footer={<Button onClick={onClose}>{t("關閉")}</Button>}>
        <div className="text-sm text-fg/70">{t("先在波形上拖一段")}</div>
      </Modal>
    );
  }

  const set = (id: string, v: ParamValue) => {
    touched.current = true;
    setValues((cur) => resolveValues(spec, null, { ...cur, [id]: v }));
    ab.invalidate();
  };
  const applyPreset = (p: (typeof spec.presets)[number]) => {
    touched.current = true;
    setValues(resolveValues(spec, p, null));
    ab.invalidate();
  };
  const active = matchingPreset(spec, values);
  const main = mainParams(spec, simple);
  const adv = simple ? [] : advancedParams(spec);
  const win = abWindow(range);

  const apply = async () => {
    const err = spec.validate?.(values, ctx);
    if (err) {
      toast.info(t(err));
      return;
    }
    await applyEffect(spec.build(values, range, ctx), mediaId);
    onClose();
  };

  const renderParam = (p: ParamSpec) => {
    const v = values[p.id];
    const note = p.describe?.(v, values);
    if (p.kind === "slider") {
      return (
        <Field key={p.id} label={`${t(p.label)}　${typeof v === "number" ? `${v > 0 && p.unit === "dB" ? "+" : ""}${v}${p.unit ? ` ${p.unit}` : ""}` : String(v)}`} hint={note ? t(note) : p.hint ? t(p.hint) : undefined}>
          <input type="range" min={p.min} max={p.max} step={p.step ?? 1} value={Number(v)} onChange={(e) => set(p.id, Number(e.target.value))} className="w-full" />
        </Field>
      );
    }
    if (p.kind === "select") {
      return (
        <Field key={p.id} label={t(p.label)} hint={note ? t(note) : p.hint ? t(p.hint) : undefined}>
          <Select value={String(v)} onChange={(e) => set(p.id, e.target.value)}>
            {(p.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {t(o.label)}
              </option>
            ))}
          </Select>
        </Field>
      );
    }
    return (
      <label key={p.id} className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={!!v} onChange={(e) => set(p.id, e.target.checked)} />
        <span>
          {t(p.label)}
          {(note || p.hint) && <span className="block text-[11px] text-fg/45">{t(note ?? p.hint!)}</span>}
        </span>
      </label>
    );
  };

  return (
    <Modal
      open
      onClose={ab.busy ? () => {} : onClose}
      title={t(spec.title)}
      icon={spec.icon}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={ab.busy}>
            {t("取消")}
          </Button>
          <Button variant="primary" onClick={() => void apply()} disabled={ab.busy} data-testid="effect-apply">
            {t("套用")}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <div className="text-fg/70">{t(spec.blurb)}</div>
        <div className="mono text-[11px] text-fg/45 tabular-nums">
          {formatMs(range.startMs, { millis: false })} – {formatMs(range.endMs, { millis: false })} · {((range.endMs - range.startMs) / 1000).toFixed(1)}s
        </div>
        {analyzing && !asyncSuggestion && (
          <div className="flex items-center gap-2 text-xs text-fg/55">
            <Spinner size={12} />
            {t("量測中…")}
          </div>
        )}
        {suggestion && (
          <div className="rounded-md border border-fg/10 px-3 py-2 text-xs text-fg/70" data-testid="effect-suggestion">
            {suggestion.summary}
          </div>
        )}

        {main.map(renderParam)}

        {(spec.presets.length > 0 || suggestion) && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-fg/40 mr-1">{t("預設")}</span>
            {spec.presets.map((p) => (
              <Button key={p.id} size="sm" variant={active?.id === p.id ? "primary" : "ghost"} onClick={() => applyPreset(p)}>
                {t(p.label, p.labelParams)}
              </Button>
            ))}
            {suggestion && (
              <Button size="sm" variant="ghost" icon={Sparkles} onClick={() => { setValues(resolveValues(spec, null, suggestion.values)); ab.invalidate(); }}>
                {t("用建議值")}
              </Button>
            )}
          </div>
        )}

        <div className="rounded-md border border-fg/10 px-3 py-2 space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-fg/55">{t("A / B 試聽")}</span>
            <span className="mono text-fg/70 tabular-nums">
              {formatMs(win.startMs, { millis: false })} +{((win.endMs - win.startMs) / 1000).toFixed(0)}s
            </span>
            <Button size="sm" variant="secondary" className="ml-auto" onClick={() => void ab.run()} disabled={ab.busy}>
              {ab.busy ? <Spinner size={13} /> : null}
              {ab.pair ? t("重新產生") : t("產生兩份試聽")}
            </Button>
          </div>
          {ab.pair ? (
            <div className="flex gap-2">
              <Button size="sm" variant={ab.playing === "dry" ? "primary" : "secondary"} icon={ab.playing === "dry" ? Pause : Play} onClick={() => ab.play("dry")}>
                {t("原始")}
              </Button>
              <Button size="sm" variant={ab.playing === "wet" ? "primary" : "secondary"} icon={ab.playing === "wet" ? Pause : Play} onClick={() => ab.play("wet")}>
                {t("處理後")}
              </Button>
            </div>
          ) : (
            <div className="text-[11px] text-fg/40">{t("按上面的按鈕算出同一段的兩個版本，來回聽比較準")}</div>
          )}
        </div>

        {adv.length > 0 && (
          <div>
            <button type="button" onClick={() => setShowAdvanced((v) => !v)} className="text-xs text-fg/55 hover:text-fg/85">
              {showAdvanced ? "▾" : "▸"} {t("進階")}
            </button>
            {showAdvanced && <div className="mt-2 space-y-3">{adv.map(renderParam)}</div>}
          </div>
        )}
        <audio ref={ab.audioRef} onEnded={ab.onEnded} className="hidden" />
      </div>
    </Modal>
  );
}
