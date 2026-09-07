import { useEffect, useMemo, useState } from "react";
import { BadgeCheck, ClipboardCheck, FileMusic, FolderOpen } from "lucide-react";
import { api, errMessage, type RenderDone, type RenderProgress } from "../api";
import { KIND_LABEL, type CandidateKind } from "../analysis/types";
import { Button, Field, FormGrid, Input, Modal, Select } from "../ui/index";
import { pickSaveFile, toast } from "../ui";
import { useT } from "../i18n";
import { clipPath } from "../analysis/clip";
import { normalizeRanges, reelSourceMs, type ReelRange } from "../analysis/reel";
import { buildRenderPlan, defaultOutPath, runRender, type RenderFormat } from "../pipeline/render";
import { renderStems, type StemProgress } from "../pipeline/stems";
import { useDecisions } from "../store/decisions";
import { roleLabel, rolesInUse } from "../analysis/roles";
import {
  allPresets,
  matchPreset,
  parseUserPresets,
  removeUserPreset,
  saveUserPreset,
  type ExportPreset,
} from "../analysis/exportPresets";
import { hasBlocker, preflight, summarize } from "../analysis/preflight";
import { qcFor } from "../pipeline/audioQc";
import type { Overlay } from "../analysis/overlays";
import type { Candidate, DecisionMap, Marker } from "../analysis/types";
import { useTranscript } from "../store/transcript";
import { useProject } from "../store/project";
import { useVerify } from "../store/verify";
import { useSettings } from "../store/settings";
import { checkCompliance, explainMiss } from "../analysis/loudness/compliance";
import { usePlayback } from "../store/playback";
import { formatMs } from "../time";

// 空陣列常數：selector 每次回傳新的 [] 會讓 zustand 每次都判定變了
const EMPTY_OVERLAYS: Overlay[] = [];
const EMPTY_DECISIONS: DecisionMap = {};
const EMPTY_CANDIDATES: Candidate[] = [];
const EMPTY_MARKERS: Marker[] = [];

/** 前端的形狀 → 設定檔的形狀（Rust 端是 snake_case）。 */
function toStored(p: ExportPreset) {
  return { id: p.id, label: p.label, format: p.format, target_lufs: p.targetLufs, leveling: p.leveling, stems: p.stems };
}

export default function RenderDialog({
  mediaId,
  onClose,
  onVerify,
  range,
  reel,
  reelBed,
}: {
  mediaId: string;
  onClose: () => void;
  onVerify?: (outPath: string, durationMs: number | null) => void;
  /** 只輸出這一段（來源時間）。有值時預設檔名帶 _clip，而且不寫章節、不做分軌。 */
  range?: { startMs: number; endMs: number } | null;
  /** 精華合輯：把好幾段不相鄰的範圍串成一支預告（與 range 互斥）。 */
  reel?: ReelRange[] | null;
  /** 合輯的墊樂（媒體 id）。 */
  reelBed?: string | null;
}) {
  const t = useT();
  const media = useProject((s) => s.media.find((m) => m.id === mediaId) ?? null);
  const projTarget = useProject((s) => s.targetLufs);
  const settings = useSettings((s) => s.s);
  const [format, setFormat] = useState<RenderFormat>("mp3");
  const [outPath, setOutPath] = useState("");
  // 預設關：多數 podcast 要的是「打到目標」，被壓一點無所謂。
  // 訪談 / 有音樂的節目才會寧可小聲也要保住動態。
  const [preserveDynamics, setPreserveDynamics] = useState(false);
  const [leveling, setLeveling] = useState(true);
  const [stems, setStems] = useState(false);
  const [stemStep, setStemStep] = useState<StemProgress | null>(null);
  const overlays = useDecisions((s2) => s2.overlays[mediaId] ?? EMPTY_OVERLAYS);
  const hasOverlays = overlays.length > 0;
  // 分軌是依角色分的（Final Cut 的 Audio Roles）：用到哪些角色是從 overlays 推導的，
  // 沒有另一份清單要同步
  const roles = useMemo(() => rolesInUse(overlays), [overlays]);
  const [target, setTarget] = useState<number>(projTarget || settings.target_lufs || -16);

  // 輸出預設集（Premiere / Audition 的 Export Presets）：每一集都要重複做的
  // 四個決定（格式 / 響度 / 逐段平衡 / 分軌）其實只有幾種固定組合
  const userPresets = useMemo(() => parseUserPresets(settings.export_presets), [settings.export_presets]);
  const presets = useMemo(() => allPresets(userPresets), [userPresets]);
  const shape = { format, targetLufs: target, leveling, stems };
  const active = matchPreset(shape, userPresets);

  const applyPreset = (id: string) => {
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    setFormat(p.format);
    setTarget(p.targetLufs);
    setLeveling(p.leveling);
    // 沒有 overlay 時分軌本來就不生效，勾了只會讓人以為壞了
    setStems(p.stems && hasOverlays);
  };
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<RenderProgress | null>(null);
  const [done, setDone] = useState<RenderDone | null>(null);

  useEffect(() => {
    if (!media) return;
    const base = defaultOutPath(media, format, settings.output_dir);
    setOutPath(reel?.length ? clipPath(base, "_reel") : range ? clipPath(base) : base);
  }, [media, format, settings.output_dir, range, reel]);

  const built = useMemo(
    () => (media ? buildRenderPlan(mediaId, { format, outPath, leveling, targetLufs: target, rangeMs: reel?.length ? null : (range ?? null), reelRanges: reel ?? null, reelBedMediaId: reelBed ?? null }) : null),
    [media, mediaId, format, outPath, leveling, target, range, reel, reelBed],
  );

  const seek = usePlayback((st) => st.seek);
  // 輸出前檢查：驗收都在輸出之後，但有些問題按下輸出前就看得出來
  // 聲音體檢（削波 / 音量突變 / 直流偏移 / 長空白）也在這裡一起報 —— 那些逐字稿看不出來
  const qc = useMemo(() => qcFor(mediaId), [mediaId, built]); // eslint-disable-line react-hooks/exhaustive-deps
  const decisions = useDecisions((s2) => s2.decisions[mediaId] ?? EMPTY_DECISIONS);
  const candidates = useDecisions((s2) => s2.candidates[mediaId] ?? EMPTY_CANDIDATES);
  const markers = useDecisions((s2) => s2.markers[mediaId] ?? EMPTY_MARKERS);
  const hasTranscript = useTranscript((s2) => !!s2.byMedia[mediaId]);
  const findings = useMemo(
    () =>
      preflight({
        pending: candidates.reduce((n, c) => n + ((decisions[c.id]?.state ?? "pending") === "pending" ? 1 : 0), 0),
        conflicts: candidates.reduce((n, c) => n + (decisions[c.id]?.conflict ? 1 : 0), 0),
        openTodos: markers.reduce((n, mk) => n + (mk.kind === "todo" && !mk.done ? 1 : 0), 0),
        chapters: markers.reduce((n, mk) => n + (mk.kind === "chapter" ? 1 : 0), 0),
        srcMs: built ? built.edl.stats.keptMs + built.edl.stats.removedMs : 0,
        outMs: built?.expectedOutMs ?? 0,
        overlays: overlays.length,
        musicWithoutDuck: overlays.filter((o) => o.lane === "music" && !(o.points?.length ?? 0)).length,
        stems: stems && hasOverlays,
        hasTranscript,
        qc: qc?.summary,
        qcAt: qc?.at,
      }),
    [candidates, decisions, markers, built, overlays, stems, hasOverlays, hasTranscript, qc],
  );
  const blocked = hasBlocker(findings);
  const counts = summarize(findings);

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
      const base = { format, outPath: outPath.trim(), leveling, targetLufs: target, rangeMs: reel?.length ? null : (range ?? null), reelRanges: reel ?? null, reelBedMediaId: reelBed ?? null, preserveDynamics };
      if (stems && hasOverlays && !range && !reel?.length) {
        const files = await renderStems(mediaId, base, roles, (p) => setStemStep(p));
        setStemStep(null);
        useVerify.getState().clear(mediaId);
        toast.success(t("分軌輸出完成：{files}", { files: files.map((f) => t(f.label)).join("、") }));
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

  const compliance = useMemo(
    () =>
      done?.ok
        ? checkCompliance({
            outputLufs: done.output_lufs,
            outputTp: done.output_tp,
            targetLufs: target,
            // 我們送的是 linear=true，但那只是請求 —— ffmpeg 拉不動時會自己退回 dynamic
            // （動態壓縮）。它只在 JSON 裡講一次，不帶進來就永遠不知道成品被壓過。
            normalizationType: done.measured?.normalization_type ?? null,
          })
        : null,
    [done, target],
  );
  const miss = useMemo(
    () => (done?.ok ? explainMiss({ outputLufs: done.output_lufs, outputTp: done.output_tp, targetLufs: target }) : null),
    [done, target],
  );

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
        {findings.length > 0 && (
          <div className="rounded-md border border-fg/10 px-3 py-2 space-y-1.5">
            <div className="flex items-center gap-1.5 text-[11px]">
              <ClipboardCheck size={12} className={blocked ? "text-danger" : counts.warnings ? "text-warning" : "text-fg/45"} />
              <span className="text-fg/70">{t("輸出前檢查")}</span>
              <span className="text-fg/40">
                {t("{w} 個警告 · {n} 個提醒", { w: counts.blockers + counts.warnings, n: counts.notes })}
              </span>
            </div>
            {findings.map((f) => (
              <div key={f.id} className="flex items-start gap-1.5 text-[11px] leading-snug">
                <span
                  aria-hidden
                  className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${
                    f.severity === "blocker" ? "bg-danger" : f.severity === "warning" ? "bg-warning" : "bg-fg/25"
                  }`}
                />
                <span className="min-w-0">
                  <span className={f.severity === "note" ? "text-fg/60" : "text-fg/85"}>{t(f.title)}</span>
                  {/*
                    聲音的問題光看文字沒有用 —— 「3 處波形打到滿刻度」要能直接跳過去聽，
                    不然使用者只能關掉對話框、自己在波形上找。
                  */}
                  {f.action === "listen" && f.atMs != null && (
                    <button
                      type="button"
                      className="ml-1.5 mono text-[10px] text-accent hover:underline tabular-nums"
                      onClick={() => {
                        seek(Math.max(0, f.atMs! - 500));
                        onClose();
                      }}
                    >
                      {t("去聽 {at}", { at: formatMs(f.atMs, { millis: false }) })}
                    </button>
                  )}
                  {f.detail && <span className="block text-fg/40">{t(f.detail)}</span>}
                </span>
              </div>
            ))}
          </div>
        )}
        <Field
          label={t("輸出預設")}
          hint={active?.note ? t(active.note) : t("平台規範是別人訂的，不是每一集要重新想的東西。")}
        >
          <div className="flex gap-2">
            <Select
              value={active?.id ?? ""}
              disabled={busy}
              onChange={(e) => e.target.value && applyPreset(e.target.value)}
              className="flex-1"
            >
              {!active && <option value="">{t("自訂")}</option>}
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {t(p.label)}
                </option>
              ))}
            </Select>
            <Button
              variant="ghost"
              disabled={busy}
              title={t("把目前的格式 / 響度 / 逐段平衡 / 分軌存成一個預設")}
              onClick={() => {
                const name = window.prompt(t("預設名稱"), active ? "" : t("我的預設"));
                if (name == null) return;
                const next = saveUserPreset(userPresets, name, shape);
                if (next === userPresets) {
                  toast.error(t("名稱空白或跟內建的重複"));
                  return;
                }
                void useSettings.getState().save({ export_presets: next.map(toStored) });
                toast.success(t("已存成預設「{name}」", { name: name.trim() }));
              }}
            >
              {t("另存")}
            </Button>
            {active && !active.builtin && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  void useSettings.getState().save({ export_presets: removeUserPreset(userPresets, active.id).map(toStored) });
                  toast.info(t("已刪除預設「{name}」", { name: active.label }));
                }}
              >
                {t("刪除")}
              </Button>
            )}
          </div>
        </Field>
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
        {!!reel?.length && (
          <div className="rounded-md border border-fg/10 px-3 py-2 text-xs text-fg/70">
            {t("精華合輯：{n} 段、素材共 {len} 秒，段落之間自動交越，頭尾自動淡進淡出。不寫章節。")
              .replace("{n}", String(normalizeRanges(reel).length))
              .replace("{len}", (reelSourceMs(reel) / 1000).toFixed(1))}
          </div>
        )}
        {range && !reel?.length && (
          <div className="rounded border border-accent/30 bg-accent/5 px-2 py-1.5 text-[11px] leading-relaxed text-fg/70">
            {t("只輸出 {a}–{b}（{len} 秒）。剪輯、配樂與閃避都照舊，專案不會被改到；章節與分軌只寫進完整成品。", {
              a: formatMs(range.startMs, { millis: false }),
              b: formatMs(range.endMs, { millis: false }),
              len: ((range.endMs - range.startMs) / 1000).toFixed(1),
            })}
          </div>
        )}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={leveling} onChange={(e) => setLeveling(e.target.checked)} disabled={busy} />
          {t("逐段音量平衡（把忽大忽小的段落拉齊，再整體正規化到目標響度）")}
        </label>
        <label className="flex items-center gap-2" title={t("目標拉不到時，ffmpeg 預設會改用動態壓縮把音量起伏壓平。勾這個就改成寧可小聲一點，但完全不壓。")}>
          <input type="checkbox" checked={preserveDynamics} onChange={(e) => setPreserveDynamics(e.target.checked)} disabled={busy} />
          {t("保留動態（寧可小聲也不壓）")}
        </label>
        <label className={`flex items-center gap-2 ${hasOverlays && !range && !reel?.length ? "" : "opacity-45"}`} title={hasOverlays ? undefined : t("這一集沒有配樂 / 音效，沒有東西可以分軌")}>
          <input type="checkbox" checked={stems && hasOverlays} onChange={(e) => setStems(e.target.checked)} disabled={busy || !hasOverlays || !!range || !!reel?.length} />
          {roles.length > 1
            ? t("同時輸出分軌（人聲一個檔，每個角色各一個檔：{list}）", { list: roles.map((r) => t(roleLabel(r))).join("、") })
            : t("同時輸出分軌（人聲一個檔、配樂與音效一個檔）")}
        </label>
        {stems && hasOverlays && !range && !reel?.length && (
          <p className="text-[11px] text-fg/40 leading-relaxed -mt-1">
            {t("所有檔共用同一組響度量測，所以各軌之間的相對音量跟完整混音一致（每一軌各自正規化的話，配樂會被拉到跟人聲一樣大聲）。真實峰值限制器仍然是逐檔套用，所以把各軌相加不會逐樣本等於完整混音 —— 影片剪接端本來也會重新做一次混音。")}
          </p>
        )}
        {stemStep && (
          <div className="text-xs text-fg/60">
            {t("分軌輸出 {i}/{n}：{label}", { i: stemStep.index + 1, n: stemStep.total, label: t(stemStep.label) })}
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
        {/*
          輸出完成之後**要講清楚有沒有打到目標**。原本只印一個數字，差了 1.3 LU 也
          長得跟達標一模一樣 —— 而最常見的沒打到又不是 bug，是來源太小聲、峰值太尖，
          被真實峰值上限擋住。不解釋的話使用者只會去改一個改不動的設定。
        */}
        {done?.ok && compliance && (
          <div
            className={`rounded-md border p-3 text-[11px] leading-relaxed ${
              compliance.level === "ok" ? "border-success/30 text-success/90" : compliance.level === "warn" ? "border-warning/30 text-warning/90" : "border-danger/40 text-danger"
            }`}
          >
            <div className="font-medium">{t(compliance.summary)}</div>
            <ul className="mt-1 space-y-0.5 text-fg/55">
              {compliance.checks.map((c) => (
                <li key={c.label}>
                  {c.level === "ok" ? "・" : c.level === "warn" ? "！" : "×"} {t(c.label)}：{c.detail}
                </li>
              ))}
            </ul>
            {miss && (
              <div className="mt-1.5 text-fg/70">
                <b>{t(miss.title)}</b>　{t(miss.detail)}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
