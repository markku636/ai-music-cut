import { useEffect, useMemo, useRef, useState } from "react";
import { BookMarked, Check, Crop, Flag, ListTree, MoveHorizontal, Music, Palette, Play, Repeat, Scissors, Slice, SquareDashed, Trash, TrendingDown, TrendingUp, Volume2, VolumeX, Wind, X, ZoomIn } from "lucide-react";
import type { AudioEffect } from "../analysis/effects";
import { detectBeats, MIN_BEAT_CONFIDENCE } from "../analysis/beats";
import { activeRanges } from "../analysis/edl/build";
import { DEFAULT_DUCK, DEFAULT_MUSIC, DEFAULT_SFX, LANE_LABEL, planDuck, voiceRegionsInOutput, type Overlay } from "../analysis/overlays";
import { mapSrcToOut } from "../analysis/edl/map";
import { MARKER_KIND_LABEL, isActiveState, type Candidate, type DecisionMap, type Marker, type MarkerKind, type SplitPoint } from "../analysis/types";
import { EmptyState, Button } from "../ui/index";
import { toast } from "../ui";
import { useT } from "../i18n";
import { restoreAnalysis } from "../pipeline/analyze";
import { edlFor } from "../pipeline/rules";
import { ensureLocalAnalysis } from "../pipeline/waveform";
import AudioPlayer from "../preview/AudioPlayer";
import { playRange } from "../preview/playerRef";
import { useEffectPreview } from "../preview/useEffectPreview";
import TransportBar from "../preview/TransportBar";
import PreviewBar from "../preview/PreviewBar";
import PrecisionTrim from "../preview/PrecisionTrim";
import { useSkipPlayback } from "../preview/useSkipPlayback";
import { useShuttle } from "../preview/useShuttle";
import { useOverlayMonitor } from "../preview/useOverlayMonitor";
import { useDecisions } from "../store/decisions";
import { usePlayback } from "../store/playback";
import { selectActiveMedia, useProject } from "../store/project";
import { useTimeline } from "../store/timeline";
import { useUi } from "../store/ui";
import { useTranscript } from "../store/transcript";
import SelectionBar from "../timeline/SelectionBar";
import { addEffectOnSelection, applyCandidateRange, clearSelection, cutSelection, keepOnlySelection, removeEffect, updateEffectRange } from "../timeline/selectionActions";
import Timeline, { type WaveMenuInfo } from "../timeline/Timeline";
import WaveContextMenu, { type MenuItem } from "../timeline/WaveContextMenu";
import { bladeAt, liftSelection, removeSeamSplit, seamsOfEdl, setSeamPause, type SeamInfo } from "../timeline/trimActions";
import { formatMs } from "../time";
import TranscriptEditor from "../transcript/TranscriptEditor";
import TranscriptPlaceholder from "../transcript/TranscriptPlaceholder";
import ReviewMode from "../decisions/ReviewMode";
import StyleDialog from "../dialogs/StyleDialog";
import Splitter from "./Splitter";
import { useResizable } from "./useResizable";

const EMPTY_C: Candidate[] = [];
const EMPTY_D: DecisionMap = {};
const EMPTY_E: AudioEffect[] = [];
const EMPTY_S: SplitPoint[] = [];
const EMPTY_MK: Marker[] = [];
const EMPTY_OV: Overlay[] = [];
/** 配樂音量的常用檔位（dB）。 */
const OVERLAY_GAINS = [0, -6, -12, -18, -24];
const GAIN_STEPS = [6, 3, -3, -6, -12];

export interface MainAreaProps {
  onOpen: () => void;
  onAnalyze: () => void;
  onOpenSettings: (focus?: "key" | "ffmpeg") => void;
  /** 只輸出選取的那一段（社群短片）。 */
  onExportRange?: (startMs: number, endMs: number) => void;
}

export default function MainArea({ onOpen, onAnalyze, onOpenSettings, onExportRange }: MainAreaProps) {
  const t = useT();
  const active = useProject(selectActiveMedia);
  const mediaId = active?.id ?? null;
  const transcript = useTranscript((s) => (mediaId ? s.byMedia[mediaId] ?? null : null));
  const local = useTranscript((s) => (mediaId ? s.local[mediaId] ?? null : null));
  const candidates = useDecisions((s) => (mediaId ? s.candidates[mediaId] ?? EMPTY_C : EMPTY_C));
  const decisions = useDecisions((s) => (mediaId ? s.decisions[mediaId] ?? EMPTY_D : EMPTY_D));
  const effects = useDecisions((s) => (mediaId ? s.effects[mediaId] ?? EMPTY_E : EMPTY_E));
  const splits = useDecisions((s) => (mediaId ? s.splits[mediaId] ?? EMPTY_S : EMPTY_S));
  const selectedIds = useDecisions((s) => s.selectedIds);
  const aggressiveness = useProject((s) => s.aggressiveness);
  const select = useDecisions((s) => s.select);
  const removeCandidate = useDecisions((s) => s.removeCandidate);
  const [menu, setMenu] = useState<WaveMenuInfo | null>(null);
  const [styleFor, setStyleFor] = useState<{ startMs: number; endMs: number } | null>(null);
  const reviewing = useDecisions((s) => s.reviewing);
  const setReviewing = useDecisions((s) => s.setReviewing);
  const loopSel = useTimeline((s) => s.loopSelection);
  const toggleLoop = useTimeline((s) => s.toggleLoop);
  const zoomToSelection = useTimeline((s) => s.zoomToSelection);
  const fitZoom = useTimeline((s) => s.fit);
  const decide = useDecisions((s) => s.decide);
  const toggleWordCut = useDecisions((s) => s.toggleWordCut);
  const seek = usePlayback((s) => s.seek);
  const selection = useTimeline((s) => s.selection);
  const setSelection = useTimeline((s) => s.setSelection);
  const setFocusSeam = useTimeline((s) => s.setFocusSeam);
  const anchorWord = useRef<number | null>(null);
  const timeline = useResizable({ storageKey: "aicut:timelineH", initial: 220, min: 140, max: () => window.innerHeight * 0.6, axis: "y" });

  // 跳播與輸出必須看同一份剪除區。舊版跳播吃 activeRanges（原始候選直接合併），
  // 輸出吃 buildEdl（pad / 貼齊能量最低點 / 呼吸還原 / 守門降級），兩者差好幾十毫秒 ——
  // 使用者「試聽覺得沒問題」但成品不一樣，是最難查的那種 bug。
  // EDL 算不出來（還沒逐字稿 / 還沒探測）時才退回 activeRanges。
  // edlFor 從 store 直接讀（getState），所以 lint 看不出它依賴什麼；
  // 這些 dep 就是「該重算」的訊號，刻意留著。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const edl = useMemo(() => (mediaId ? edlFor(mediaId) : null), [mediaId, candidates, decisions, splits, aggressiveness, local, transcript]);
  const cuts = useMemo(
    () => edl?.removals.map((r) => ({ startMs: r.startMs, endMs: r.endMs })) ?? activeRanges(candidates, decisions),
    [edl, candidates, decisions],
  );
  const seams = useMemo(() => seamsOfEdl(edl), [edl]);
  // 段落之間補呼吸用的常見長度；0 = 拿掉留白，回到直接對接
  const PAUSE_STEPS: number[] = [0, 200, 500, 1000];
  const [seamMenu, setSeamMenu] = useState<{ seam: SeamInfo; x: number; y: number } | null>(null);
  const markers = useDecisions((s) => (mediaId ? s.markers[mediaId] ?? EMPTY_MK : EMPTY_MK));
  const updateMarker = useDecisions((s) => s.updateMarker);
  const removeMarker = useDecisions((s) => s.removeMarker);
  const addMarker = useDecisions((s) => s.addMarker);
  const [markerMenu, setMarkerMenu] = useState<{ marker: Marker; x: number; y: number } | null>(null);
  const overlays = useDecisions((s) => (mediaId ? s.overlays[mediaId] ?? EMPTY_OV : EMPTY_OV));
  const updateOverlay = useDecisions((s) => s.updateOverlay);
  const removeOverlay = useDecisions((s) => s.removeOverlay);
  const addOverlay = useDecisions((s) => s.addOverlay);
  const allMedia = useProject((s) => s.media);
  const [overlayMenu, setOverlayMenu] = useState<{ o: Overlay; x: number; y: number } | null>(null);
  // 可以拿來當配樂 / 音效的其他媒體（自己不能疊自己）
  const otherMedia = allMedia.filter((m) => m.id !== mediaId);
  // 吸附目標：接縫（EDL 的保留段邊界，含刀片切點）+ 句界 + 字界 + 頭尾。
  // 只在 EDL / 逐字稿變動時攤平一次，拖曳過程中直接用。
  const setSnapSources = useTimeline((s) => s.setSnapSources);
  useEffect(() => {
    const seams: number[] = [];
    for (const k of edl?.keeps ?? []) {
      seams.push(k.srcStartMs);
      seams.push(k.srcEndMs);
    }
    setSnapSources({
      seams,
      markers: markers.map((m) => m.ms),
      sentences: transcript?.sentences ?? [],
      words: transcript?.words ?? [],
      durationMs: active?.probe?.duration_ms ?? transcript?.durationMs ?? 0,
    });
  }, [edl, transcript, markers, active?.probe?.duration_ms, setSnapSources]);

  // 波形一好就算拍點（純 JS、5 ms 桶自相關；語音信心低會回 null → 不顯示網格）
  const setBeatGrid = useTimeline((s) => s.setBeatGrid);
  useEffect(() => {
    if (!local) {
      setBeatGrid(null);
      return;
    }
    // 有逐字稿＝這是說話，不是音樂。講話的節奏會讓自相關算出一個「像樣」的 BPM
    // （這個 34 秒的 podcast 就算出 139.5 BPM，信心 0.59），但拍線畫在人聲波形上
    // 只是噪音 —— 使用者要看的是字在哪裡，不是想像中的小節線。
    const isSpeech = (transcript?.words.length ?? 0) > 0;
    const g = detectBeats(local);
    setBeatGrid(!isSpeech && g.confidence >= MIN_BEAT_CONFIDENCE ? g : null);
  }, [local, transcript, setBeatGrid]);
  useSkipPlayback(cuts);
  useShuttle();
  useOverlayMonitor(overlays, edl);
  useEffectPreview(effects);

  // 開檔 / 切換媒體：波形立刻算（只需 ffmpeg；快取命中幾乎即時）。失敗留在 job 裡由 placeholder 顯示。
  useEffect(() => {
    if (active?.probe && !local) void ensureLocalAnalysis(active.id).catch(() => {});
  }, [active?.id, active?.probe, local]);

  // 切換媒體：若專案檔有分析記錄但 store 還沒有 → 還原；清掉上一個媒體的選取。
  useEffect(() => {
    if (active && active.analysis === "ready") void restoreAnalysis(active.id);
    setSelection(null);
    anchorWord.current = null;
  }, [active?.id, active?.analysis]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 右鍵選單內容：依游標下是候選 / 效果 / 有無選取決定。 */
  const menuItems = (info: WaveMenuInfo): MenuItem[] => {
    const dur = active?.probe?.duration_ms ?? 0;
    const c = info.candidateId ? candidates.find((x) => x.id === info.candidateId) : undefined;
    if (c && mediaId) {
      const st = decisions[c.id]?.state;
      return [
        { label: `${c.reason}`, disabled: true },
        { separator: true },
        { label: t("預聽（前後各 1 秒）"), icon: Play, shortcut: "P", onClick: () => playRange(c.startMs - 1000, c.endMs + 1000, { skip: isActiveState(st) }) },
        { label: t("剪掉"), icon: Check, shortcut: "A", checked: isActiveState(st), onClick: () => decide(mediaId, [c.id], "accepted") },
        { label: t("不剪（保留）"), icon: X, shortcut: "R", checked: st === "rejected", onClick: () => decide(mediaId, [c.id], "rejected") },
        { label: t("選取這段範圍"), icon: SquareDashed, onClick: () => setSelection({ startMs: c.startMs, endMs: c.endMs }) },
        { separator: true },
        { label: t("移除這個候選"), icon: Trash, danger: true, disabled: c.source !== "user", onClick: () => removeCandidate(mediaId, c.id) },
      ];
    }
    const fx = info.effectId ? effects.find((x) => x.id === info.effectId) : undefined;
    if (fx) {
      return [
        { label: t("選取這段範圍"), icon: SquareDashed, onClick: () => setSelection({ startMs: fx.startMs, endMs: fx.endMs }) },
        { label: t("移除效果"), icon: Trash, danger: true, onClick: () => removeEffect(fx.id) },
      ];
    }
    if (selection) {
      return [
        { label: t("播放選取"), icon: Play, shortcut: "Space", onClick: () => playRange(selection.startMs, selection.endMs, { skip: false, loop: loopSel }) },
        { label: t("循環播放"), icon: Repeat, checked: loopSel, onClick: toggleLoop },
        { separator: true },
        { label: t("剪掉"), icon: Scissors, shortcut: "Delete", danger: true, onClick: () => void cutSelection() },
        { label: t("提起（留白靜音，不關洞）"), icon: VolumeX, shortcut: "Shift+Delete", onClick: () => void liftSelection() },
        { label: t("只保留（頭尾剪掉）"), icon: Crop, onClick: () => void keepOnlySelection() },
        { separator: true },
        { label: t("改成另一種曲風…"), icon: Palette, onClick: () => setStyleFor({ startMs: selection.startMs, endMs: selection.endMs }) },
        { separator: true },
        { label: t("靜音"), icon: VolumeX, onClick: () => addEffectOnSelection("mute") },
        { label: t("淡入"), icon: TrendingUp, onClick: () => addEffectOnSelection("fade_in") },
        { label: t("淡出"), icon: TrendingDown, onClick: () => addEffectOnSelection("fade_out") },
        ...GAIN_STEPS.map<MenuItem>((db) => ({ label: t("增益 {db} dB", { db: db > 0 ? `+${db}` : db }), icon: Volume2, onClick: () => addEffectOnSelection("gain", db) })),
        { separator: true },
        { label: t("縮放到選取"), icon: ZoomIn, shortcut: "Z", onClick: zoomToSelection },
        { label: t("清除選取"), icon: X, shortcut: "Esc", onClick: clearSelection },
      ];
    }
    return [
      { label: t("從這裡播放"), icon: Play, onClick: () => { seek(info.ms); playRange(info.ms, dur, { skip: true }); } },
      { label: t("在這裡切一刀"), icon: Slice, shortcut: "B", onClick: () => void bladeAt(info.ms) },
      { label: t("在這裡下標記"), icon: Flag, shortcut: "M", onClick: () => mediaId && addMarker(mediaId, info.ms, "standard") },
      { label: t("在這裡下章節"), icon: BookMarked, shortcut: "Shift+M", onClick: () => mediaId && addMarker(mediaId, info.ms, "chapter") },
      ...(otherMedia.length
        ? [
            { separator: true } as MenuItem,
            ...otherMedia.slice(0, 6).map<MenuItem>((m) => ({
              label: t("在這裡放配樂：{name}", { name: m.name }),
              icon: Music,
              onClick: () => placeOverlay(m.id, "music", info.ms),
            })),
            ...otherMedia.slice(0, 6).map<MenuItem>((m) => ({
              label: t("在這裡放音效：{name}", { name: m.name }),
              icon: Volume2,
              onClick: () => placeOverlay(m.id, "sfx", info.ms),
            })),
          ]
        : []),
      { separator: true },
      { label: t("從開頭選到這裡"), icon: SquareDashed, onClick: () => setSelection({ startMs: 0, endMs: info.ms }) },
      { label: t("從這裡選到結尾"), icon: SquareDashed, onClick: () => setSelection({ startMs: info.ms, endMs: dur }) },
      { label: t("全選"), icon: SquareDashed, shortcut: "Ctrl+A", onClick: () => setSelection({ startMs: 0, endMs: dur }) },
      { separator: true },
      { label: t("整段適配"), icon: ZoomIn, shortcut: "Ctrl+0", onClick: fitZoom },
    ];
  };

  const markerMenuItems = (m: Marker): MenuItem[] => [
    { label: `${MARKER_KIND_LABEL[m.kind]}　${formatMs(m.ms, { millis: true })}${m.title ? "　" + m.title : ""}`, disabled: true },
    { separator: true },
    { label: t("跳到這裡"), icon: Play, onClick: () => seek(m.ms) },
    { label: t("在索引改標題…"), icon: ListTree, onClick: () => useUi.getState().setTab("index") },
    { separator: true },
    ...(["standard", "chapter", "todo"] as MarkerKind[]).map<MenuItem>((k) => ({
      label: t("改成{kind}", { kind: MARKER_KIND_LABEL[k] }),
      checked: m.kind === k,
      onClick: () => mediaId && updateMarker(mediaId, m.id, { kind: k }),
    })),
    { separator: true },
    { label: t("移除標記"), icon: Trash, danger: true, onClick: () => mediaId && removeMarker(mediaId, m.id) },
  ];

  /** 目前 EDL 下的人聲區間（成品時間）—— 自動閃避要用。 */
  const voiceOut = () => {
    if (!edl) return [];
    const vad = transcript?.vad ?? [];
    // 沒有逐字稿時退回「保留段就是人聲」：粗，但總比什麼都不閃避好
    const regions = vad.length ? vad : edl.keeps.map((k) => ({ startMs: k.srcStartMs, endMs: k.srcEndMs }));
    return voiceRegionsInOutput(regions, edl.keeps);
  };

  const overlayMenuItems = (o: Overlay): MenuItem[] => {
    const len = Math.max(0, o.srcOutMs - o.srcInMs);
    return [
      { label: `${LANE_LABEL[o.lane]}　${allMedia.find((m) => m.id === o.mediaId)?.name ?? o.mediaId}`, disabled: true },
      { separator: true },
      { label: t("試聽這一段"), icon: Play, onClick: () => playRange(o.outStartMs, o.outStartMs + len, { skip: true }) },
      { separator: true },
      ...OVERLAY_GAINS.map<MenuItem>((db) => ({
        label: t("音量 {db} dB", { db: db > 0 ? `+${db}` : db }),
        icon: Volume2,
        checked: o.gainDb === db,
        onClick: () => mediaId && updateOverlay(mediaId, o.id, { gainDb: db }, "配樂音量"),
      })),
      { separator: true },
      {
        label: o.points?.length ? t("重算人聲閃避") : t("讓配樂在人聲下自動閃避"),
        icon: TrendingDown,
        onClick: () => {
          if (!mediaId) return;
          const pts = planDuck(voiceOut(), o, DEFAULT_DUCK);
          if (!pts.length) {
            toast.info(t("這一段底下沒有人聲，不需要閃避"));
            return;
          }
          updateOverlay(mediaId, o.id, { points: pts }, "自動閃避");
          toast.success(t("已加上 {n} 個閃避控制點（{db} dB）", { n: pts.length, db: DEFAULT_DUCK.depthDb }));
        },
      },
      ...(o.points?.length
        ? [{ label: t("拿掉閃避（整段固定音量）"), icon: TrendingUp, onClick: () => mediaId && updateOverlay(mediaId, o.id, { points: [] }, "拿掉閃避") } as MenuItem]
        : []),
      { separator: true },
      { label: t("移除這段配樂"), icon: Trash, danger: true, onClick: () => mediaId && removeOverlay(mediaId, o.id) },
    ];
  };

  /** 把某個媒體放到配樂 / 音效軌上（起點＝目前播放位置換算成成品時間）。 */
  const placeOverlay = (srcMediaId: string, lane: "music" | "sfx", atSrcMs: number) => {
    if (!mediaId) return;
    const src = allMedia.find((m) => m.id === srcMediaId);
    if (!src?.probe) return;
    const outStartMs = edl ? mapSrcToOut(edl.keeps, atSrcMs) : atSrcMs;
    const preset = lane === "music" ? DEFAULT_MUSIC : DEFAULT_SFX;
    addOverlay(mediaId, {
      lane,
      mediaId: srcMediaId,
      srcInMs: 0,
      srcOutMs: src.probe.duration_ms,
      outStartMs: Math.max(0, Math.round(outStartMs)),
      ...preset,
    });
    toast.success(t("已加入{lane}：{name}", { lane: LANE_LABEL[lane], name: src.name }));
  };

  const seamMenuItems = (s: SeamInfo): MenuItem[] => {
    const around = () => playRange(Math.max(0, s.srcBeforeMs - 1200), s.srcAfterMs + 1200, { skip: true });
    const items: MenuItem[] = [
      { label: s.splitId ? t("切點 {at}", { at: formatMs(s.srcBeforeMs, { millis: true }) }) : t("接縫 {at}", { at: formatMs(s.srcBeforeMs, { millis: true }) }), disabled: true },
      { separator: true },
      { label: t("巡這個接縫（前後各 1.2 秒）"), icon: Play, onClick: around },
      { label: t("選取這個接縫附近"), icon: SquareDashed, onClick: () => setSelection({ startMs: Math.max(0, s.srcBeforeMs - 600), endMs: s.srcAfterMs + 600 }) },
      { label: t("在這裡精準修剪…"), icon: MoveHorizontal, onClick: () => setFocusSeam(s.srcBeforeMs) },
    ];
    if (s.splitId) {
      items.push(
        { separator: true },
        ...PAUSE_STEPS.map<MenuItem>((ms) => ({
          label: ms === 0 ? t("不留白（直接對接）") : t("插入留白 {ms} ms", { ms }),
          icon: ms === 0 ? Scissors : Wind,
          checked: Math.round(s.gapMs) === ms,
          onClick: () => setSeamPause(s.afterKeepId, ms),
        })),
        { separator: true },
        { label: t("移除切點"), icon: Trash, danger: true, onClick: () => removeSeamSplit(s.afterKeepId) },
      );
    }
    return items;
  };

  const toggleCandidate = (id: string) => {
    if (!mediaId) return;
    const st = decisions[id]?.state;
    decide(mediaId, [id], isActiveState(st) ? "rejected" : "accepted", { label: isActiveState(st) ? "還原" : "剪除" });
  };

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-app">
      <AudioPlayer path={active?.path ?? null} />
      {!active ? (
        <EmptyState
          icon={Music}
          title={t("尚未開啟任何音檔")}
          hint={t("把 mp3 / wav / m4a 拖進來，或按上方「開啟音檔」。")}
          action={<Button variant="primary" onClick={onOpen}>{t("開啟音檔")}</Button>}
          className="flex-1"
        />
      ) : (
        <>
          <TransportBar durationMs={active.probe?.duration_ms ?? 0} cuts={cuts} />
          <PrecisionTrim seams={seams} analysis={local} transcript={transcript ?? null} />
          <div className="relative shrink-0 bg-well border-b border-fg/10" style={{ height: timeline.size }}>
            <Timeline
              mediaId={mediaId}
              analysis={local}
              durationMs={active.probe?.duration_ms ?? 0}
              height={timeline.size}
              candidates={candidates}
              decisions={decisions}
              selectedIds={selectedIds}
              onSelect={(id) => select([id])}
              onToggle={toggleCandidate}
              onRangeChange={applyCandidateRange}
              effects={effects}
              onEffectChange={updateEffectRange}
              onContextMenu={setMenu}
              seams={seams}
              onSeamMenu={(seam, x, y) => setSeamMenu({ seam, x, y })}
              markers={markers}
              onMarkerMove={(id, ms) => mediaId && updateMarker(mediaId, id, { ms })}
              onMarkerMenu={(marker, x, y) => setMarkerMenu({ marker, x, y })}
              edl={edl}
              overlays={overlays}
              mediaNameOf={(id) => allMedia.find((m) => m.id === id)?.name ?? id}
              onOverlayChange={(id, patch, label) => mediaId && updateOverlay(mediaId, id, patch, label)}
              onOverlayMenu={(o, x, y) => setOverlayMenu({ o, x, y })}
              onRetry={() => void ensureLocalAnalysis(active.id).catch(() => {})}
              onOpenSettings={onOpenSettings}
            />
            <SelectionBar onStyle={(s, e) => setStyleFor({ startMs: s, endMs: e })} onExportRange={(s, e) => onExportRange?.(s, e)} />
            {menu && <WaveContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={() => setMenu(null)} />}
            {seamMenu && <WaveContextMenu x={seamMenu.x} y={seamMenu.y} items={seamMenuItems(seamMenu.seam)} onClose={() => setSeamMenu(null)} />}
            {markerMenu && <WaveContextMenu x={markerMenu.x} y={markerMenu.y} items={markerMenuItems(markerMenu.marker)} onClose={() => setMarkerMenu(null)} />}
            {overlayMenu && <WaveContextMenu x={overlayMenu.x} y={overlayMenu.y} items={overlayMenuItems(overlayMenu.o)} onClose={() => setOverlayMenu(null)} />}
            {styleFor && mediaId && <StyleDialog mediaId={mediaId} startMs={styleFor.startMs} endMs={styleFor.endMs} onClose={() => setStyleFor(null)} />}
          </div>
          <Splitter axis="y" onPointerDown={timeline.onPointerDown} />
          {transcript ? (
            <TranscriptEditor
              transcript={transcript}
              candidates={candidates}
              decisions={decisions}
              selectedIds={selectedIds}
              selection={selection}
              onWordClick={(wordId, cids, shift) => {
                const w = transcript.words[wordId];
                if (!w) return;
                if (shift && anchorWord.current != null && transcript.words[anchorWord.current]) {
                  const a = transcript.words[anchorWord.current];
                  setSelection({ startMs: Math.min(a.startMs, w.startMs), endMs: Math.max(a.endMs, w.endMs) });
                  return;
                }
                anchorWord.current = wordId;
                seek(w.startMs);
                select(cids.slice(0, 1));
              }}
              onWordToggle={(wordId) => {
                const w = transcript.words[wordId];
                if (!w || !mediaId) return;
                const sid = transcript.sentences.find((s) => s.wordIds.includes(wordId))?.id ?? -1;
                toggleWordCut(mediaId, wordId, w, sid);
              }}
              onSentenceSelect={(s) => setSelection({ startMs: s.startMs, endMs: s.endMs })}
            />
          ) : (
            <TranscriptPlaceholder mediaId={mediaId} onAnalyze={onAnalyze} onOpenSettings={onOpenSettings} />
          )}
          {mediaId && transcript && !reviewing && <PreviewBar mediaId={mediaId} />}
          {reviewing && mediaId && <ReviewMode mediaId={mediaId} onExit={() => setReviewing(false)} />}
        </>
      )}
    </div>
  );
}
