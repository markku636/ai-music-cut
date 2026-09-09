import { useEffect, useRef, useState } from "react";
import { Circle, Mic, Square } from "lucide-react";
import { api, errMessage } from "../api";
import { micErrorKind } from "../recording/micError";
import { estimateGate, worthGating } from "../analysis/gate";
import { rmsDbRange } from "../analysis/peaks";
import { withUndoToast } from "../commands/undoToast";
import { t, useT } from "../i18n";
import { analyzeAlignment, renderAlignment } from "../pipeline/align";
import { edlFor } from "../pipeline/rules";
import { ensureLocalAnalysis } from "../pipeline/waveform";
import { playRange, stopRange } from "../preview/playerRef";
import { listInputs, startCapture, takeDevStubSource, type CaptureHandle, type InputDevice, type RecordDone } from "../recording/capture";
import { initialLevel, meterFraction, pushLevel, type LevelState } from "../recording/levels";
import { freshRecordingPath, nextTakeIndexOnDisk, takePath } from "../recording/naming";
import { autoStopMs, fitDecision, planRedub, pushSortedSample, speechGateDb, trimTake } from "../recording/punchIn";
import { useDecisions } from "../store/decisions";
import { useProject } from "../store/project";
import { useTranscript } from "../store/transcript";
import { useUi } from "../store/ui";
import { formatMs } from "../time";
import { Button, Field, Modal, Select, Spinner } from "../ui/index";
import { pickDirectory, toast } from "../ui";

type Phase = "idle" | "listen" | "count" | "rec" | "proc" | "tooLong";

/**
 * 錄音（一般）與「重錄這句」（punch-in）。
 * 簡易 punch-in 零旋鈕：顯示範圍 → 「聽一次，然後錄」→ 播原句 → 3-2-1 → 錄 →
 * 講完安靜 1.5 秒自動停 → 修頭尾 → 對齊回原位 → mute 原句 + 疊上 take（一筆 undo）。
 */
/**
 * 麥克風打不開時說人話。
 *
 * `getUserMedia` 丟的是 `DOMException`，直接印出來的話第一次用「重錄這句」的人
 * 看到的是 `NotAllowedError: Permission denied` —— 那句話沒告訴他要做什麼。
 * 認不出來的錯誤原樣保留，不要吞成一句籠統的話。
 */
function micMessage(e: unknown): string {
  switch (micErrorKind(e)) {
    case "denied":
      return t("沒有麥克風權限。到系統設定 → 隱私權 → 麥克風把這個 App 打開，再按一次。");
    case "notFound":
      return t("找不到麥克風。插上一支，或在上面換一個輸入裝置，再試一次。");
    case "busy":
      return t("麥克風正被別的程式用著（會議軟體、瀏覽器分頁那些）。關掉它再按一次。");
    case "unsupported":
      return t("這個環境不支援錄音。");
    default:
      return errMessage(e);
  }
}

export default function RecordDialog({ mode, range, onClose }: { mode: "new" | "retake"; range?: { startMs: number; endMs: number } | null; onClose: () => void }) {
  const t = useT();
  const simple = useUi((s) => s.mode === "simple");
  const activeId = useProject((s) => s.activeMediaId);
  const media = useProject((s) => s.media);
  const active = media.find((m) => m.id === activeId) ?? null;
  const [devices, setDevices] = useState<InputDevice[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [count, setCount] = useState(0);
  const [level, setLevel] = useState<LevelState>(initialLevel());
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState<string>("");
  const [lastTake, setLastTake] = useState<{ done: RecordDone; takeId: string; trim: { startMs: number; endMs: number } } | null>(null);
  const handleRef = useRef<CaptureHandle | null>(null);
  const spokeRef = useRef(false);
  const lastLoudRef = useRef(0);
  /** 這次錄音每包的峰值（dBFS，遞增排好）：講話門檻從它的第 20 百分位（這支麥的底噪）量出來。 */
  const peaksRef = useRef<number[]>([]);
  const stoppingRef = useRef(false);
  const slot = mode === "retake" ? (range ?? null) : null;
  const slotMs = slot ? slot.endMs - slot.startMs : 0;

  useEffect(() => {
    void listInputs()
      .then((d) => {
        setDevices(d);
        if (d.length && !deviceId) setDeviceId(d[0].deviceId);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      void handleRef.current?.cancel();
      stopRange();
    };
  }, []);

  const outPathFor = async (): Promise<string | null> => {
    // 編號看媒體清單也看磁碟：上一個 session 錄的 take 不在清單裡，不看磁碟會被 .part → rename 蓋掉
    if (active) return takePath(active.path, await nextTakeIndexOnDisk(active.path, media.map((m) => m.path), (ps) => api.pathsExist(ps)));
    const dir = await pickDirectory();
    return dir ? freshRecordingPath(dir) : null;
  };

  const stopRecording = async () => {
    const h = handleRef.current;
    if (!h || stoppingRef.current) return;
    stoppingRef.current = true;
    setPhase("proc");
    try {
      const done = await h.stop();
      handleRef.current = null;
      if (done.frames === 0) {
        toast.info(t("沒有錄到東西"));
        setPhase("idle");
        return;
      }
      if (mode === "new") {
        const id = await useProject.getState().openMedia(done.path);
        useProject.getState().setActive(id);
        toast.success(t("錄好了：{name}（{len}）", { name: done.path.split(/[\\/]/).pop() ?? done.path, len: formatMs(done.duration_ms, { millis: false }) }));
        onClose();
        return;
      }
      await processRetake(done);
    } catch (e) {
      toast.error(micMessage(e));
      setPhase("idle");
    } finally {
      stoppingRef.current = false;
    }
  };

  const startRecording = async () => {
    const outPath = await outPathFor();
    if (!outPath) return;
    spokeRef.current = false;
    lastLoudRef.current = 0;
    peaksRef.current = [];
    setLevel(initialLevel());
    setElapsed(0);
    const stops = slot ? autoStopMs(slotMs) : null;
    try {
      const h = await startCapture({
        outPath,
        deviceId: deviceId || null,
        source: takeDevStubSource(),
        onLevel: (db, ms) => {
          setLevel((s) => pushLevel(s, db, ms));
          setElapsed(ms);
          if (!stops) return;
          // 講過話之後安靜 ≥ 1.5 s 自動停；硬停 = 2 × 槽 + 3 s
          // 「講話」的門檻不寫死：底噪（峰值第 20 百分位）+ 12 dB；樣本不到 1 s 之前先用 −40
          pushSortedSample(peaksRef.current, db);
          if (db > speechGateDb(peaksRef.current).speechDb) {
            spokeRef.current = true;
            lastLoudRef.current = ms;
          }
          if ((spokeRef.current && ms - lastLoudRef.current >= stops.silenceMs) || ms >= stops.hardStopMs) void stopRecording();
        },
        onBackpressure: () => setStatus(t("寫入跟不上，還在緩衝（不會掉）")),
        onEnded: () => void stopRecording(),
        onError: (e) => toast.error(micMessage(e)),
      });
      handleRef.current = h;
      setPhase("rec");
    } catch (e) {
      toast.error(micMessage(e));
      setPhase("idle");
    }
  };

  /** 聽一次 → 3-2-1 → 錄。 */
  const listenThenRecord = async () => {
    if (!slot) return;
    setPhase("listen");
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      playRange(slot.startMs, slot.endMs, { skip: false, onEnd: finish });
      setTimeout(finish, slotMs + 400);
    });
    setPhase("count");
    for (const n of [3, 2, 1]) {
      setCount(n);
      await new Promise((r) => setTimeout(r, 1000));
    }
    setCount(0);
    await startRecording();
  };

  const processRetake = async (done: RecordDone) => {
    if (!slot || !active) return;
    setStatus(t("分析新錄的…"));
    // take 只加進清單、不切 active：切過去再切回來會讓主角重載、播放頭歸零、預覽清掉
    const takeId = await useProject.getState().openMedia(done.path, { activate: false });
    const takeLocal = await ensureLocalAnalysis(takeId);
    // 修頭尾的門檻照這支 take 自己的底噪 / 人聲分布來（gate.ts）；差距太小（幾乎整段都在講）才退回固定 −45
    const gate = estimateGate(takeLocal);
    const trim = trimTake(takeLocal, worthGating(gate) ? gate.thresholdDb : undefined);
    const fit = fitDecision(trim.endMs - trim.startMs, slotMs);
    setLastTake({ done, takeId, trim });
    if (fit === "too_long") {
      setPhase("tooLong");
      setStatus("");
      return;
    }
    await place(takeId, trim, fit === "align");
  };

  /** 把 take 放回去：align = 先 DTW 對齊到原句；否則原速放上去。 */
  const place = async (takeId: string, trim: { startMs: number; endMs: number }, align: boolean) => {
    if (!slot || !active) return;
    const mainId = active.id;
    setPhase("proc");
    try {
      let takeMediaId = takeId;
      let takeRange = trim;
      if (align) {
        setStatus(t("對齊回原位…"));
        const a = await analyzeAlignment(mainId, takeId, { mode: "adr", guideRange: slot, dubRange: trim, tightness: 60 });
        const r = await renderAlignment(a, { verify: false, activate: false });
        takeMediaId = r.mediaId;
        takeRange = { startMs: slot.startMs, endMs: slot.endMs };
      }
      const mainLocal = useTranscript.getState().local[mainId];
      const takeLocal = useTranscript.getState().local[takeId];
      const gainDb = mainLocal && takeLocal ? rmsDbRange(mainLocal, slot.startMs, slot.endMs) - rmsDbRange(takeLocal, trim.startMs, trim.endMs) : 0;
      const edl = edlFor(mainId);
      const plan = planRedub({ slot, takeMediaId, takeRange, keeps: edl?.keeps ?? [], gainDb });
      await withUndoToast(t("已換成新錄的（Ctrl+Z 可還原）"), () => useDecisions.getState().applyRedub(mainId, plan, "重錄這句"));
      onClose();
    } catch (e) {
      toast.error(micMessage(e));
      setPhase("idle");
    } finally {
      setStatus("");
    }
  };

  const cancelRecording = async () => {
    await handleRef.current?.cancel();
    handleRef.current = null;
    stopRange();
    setPhase("idle");
  };

  const busy = phase === "listen" || phase === "count" || phase === "proc";
  const meter = meterFraction(level.peakDb);
  const hold = meterFraction(level.holdDb);

  return (
    <Modal
      open
      onClose={busy || phase === "rec" ? () => {} : onClose}
      title={mode === "retake" ? t("重錄這句") : t("錄音")}
      icon={Mic}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={phase === "rec" ? () => void cancelRecording() : onClose} disabled={busy}>
            {phase === "rec" ? t("取消錄音") : t("關閉")}
          </Button>
          {phase === "rec" ? (
            <Button variant="primary" icon={Square} onClick={() => void stopRecording()} data-testid="record-stop">
              {t("停止")}
            </Button>
          ) : phase === "tooLong" && lastTake ? (
            <>
              <Button variant="secondary" onClick={() => void listenThenRecord()} data-testid="record-again">
                {t("重錄")}
              </Button>
              <Button variant="primary" onClick={() => void place(lastTake.takeId, lastTake.trim, false)} data-testid="record-place-anyway">
                {t("直接放上去")}
              </Button>
            </>
          ) : (
            <Button variant="primary" icon={Circle} onClick={() => void (mode === "retake" ? listenThenRecord() : startRecording())} disabled={busy || (mode === "retake" && !slot)} data-testid="record-start">
              {busy ? <Spinner size={13} /> : null}
              {mode === "retake" ? t("聽一次，然後錄") : t("開始錄音")}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4 text-sm">
        {mode === "retake" ? (
          <div className="text-fg/70">
            {slot ? (
              <>
                {t("要重錄的範圍")}：<span className="mono tabular-nums">{formatMs(slot.startMs, { millis: false })} – {formatMs(slot.endMs, { millis: false })}</span>（{(slotMs / 1000).toFixed(1)}s）
                <span className="block text-[11px] text-fg/45">{t("先播一次原句給你聽，倒數三秒後開始錄；講完不出聲 1.5 秒會自動停。新錄的會自動對回原位、蓋掉原句。")}</span>
              </>
            ) : (
              t("先在波形上選要重錄的那一段")
            )}
          </div>
        ) : (
          <div className="text-fg/70">{active ? t("錄一段新的，存在「{name}」旁邊並加進媒體清單。", { name: active.name }) : t("錄一段新的，錄完會問你存在哪裡。")}</div>
        )}
        {!simple && (
          <Field label={t("麥克風")}>
            <Select value={deviceId} onChange={(e) => setDeviceId(e.target.value)} disabled={phase !== "idle"}>
              {!devices.length && <option value="">{t("沒有找到麥克風")}</option>}
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className="space-y-1" data-testid="record-meter">
          <div className="h-2 rounded bg-inset relative overflow-hidden">
            <div className={`absolute inset-y-0 left-0 ${level.clipped ? "bg-rose-500" : "bg-emerald-500"}`} style={{ width: `${meter * 100}%` }} />
            <div className="absolute inset-y-0 w-0.5 bg-fg/70" style={{ left: `${hold * 100}%` }} />
          </div>
          <div className="flex justify-between text-[11px] text-fg/50 mono tabular-nums">
            <span>{level.peakDb > -100 ? `${level.peakDb.toFixed(1)} dBFS` : "—"}</span>
            <span>
              {phase === "rec" && <span className="text-rose-400 mr-1">●</span>}
              {phase === "count" ? String(count) : formatMs(elapsed, { millis: false })}
            </span>
          </div>
          {level.clipped && <div className="text-[11px] text-rose-400">{t("有削波：麥克風太大聲，把增益調低一點再錄")}</div>}
        </div>
        {phase === "listen" && <div className="text-xs text-fg/60">{t("播原句給你聽…")}</div>}
        {phase === "count" && <div className="text-2xl text-center mono">{count}</div>}
        {phase === "tooLong" && lastTake && (
          <div className="rounded-md border border-amber-500/40 px-3 py-2 text-xs text-amber-300">
            {t("新錄的比原句長很多（{take}s vs {slot}s）：不會硬拉伸。直接放上去會蓋到下一句，或者再錄一次。", {
              take: ((lastTake.trim.endMs - lastTake.trim.startMs) / 1000).toFixed(1),
              slot: (slotMs / 1000).toFixed(1),
            })}
          </div>
        )}
        {status && (
          <div className="flex items-center gap-2 text-xs text-fg/60">
            <Spinner size={12} />
            {status}
          </div>
        )}
      </div>
    </Modal>
  );
}
