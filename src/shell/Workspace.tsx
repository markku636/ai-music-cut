import { useEffect, useMemo, useRef, useState } from "react";
import { BookMarked, Check, Flag, ListTree, MoveHorizontal, Music, Play, Scissors, Slice, SquareDashed, Tags, Trash, TrendingDown, TrendingUp, Volume2, Wind, X, ZoomIn } from "lucide-react";
import type { AudioEffect } from "../analysis/effects";
import { detectBeats, MIN_BEAT_CONFIDENCE } from "../analysis/beats";
import { activeRanges } from "../analysis/edl/build";
import { mapSrcToOut } from "../analysis/edl/map";
import { DEFAULT_DUCK, DEFAULT_MUSIC, DEFAULT_SFX, LANE_LABEL, planDuck, voiceRegionsInOutput, type Overlay } from "../analysis/overlays";
import { BUILTIN_ROLES, overlayRole, roleLabel } from "../analysis/roles";
import type { SpeakerState } from "../analysis/speakers";
import { MARKER_KIND_LABEL, isActiveState, type Candidate, type DecisionMap, type Marker, type MarkerKind, type SplitPoint } from "../analysis/types";
import { openSettings } from "../commands/appActions";
import { selectionMenuItems } from "../commands/menuModel";
import { useT } from "../i18n";
import { restoreAnalysis } from "../pipeline/analyze";
import { edlFor } from "../pipeline/rules";
import { ensureLocalAnalysis } from "../pipeline/waveform";
import { playRange } from "../preview/playerRef";
import PrecisionTrim from "../preview/PrecisionTrim";
import SimpleTransport from "../preview/SimpleTransport";
import TransportBar from "../preview/TransportBar";
import { useEffectPreview } from "../preview/useEffectPreview";
import { useOverlayMonitor } from "../preview/useOverlayMonitor";
import { useShuttle } from "../preview/useShuttle";
import { useSkipPlayback } from "../preview/useSkipPlayback";
import { useDecisions } from "../store/decisions";
import { usePlayback } from "../store/playback";
import { selectActiveMedia, useProject } from "../store/project";
import { useTimeline } from "../store/timeline";
import { useTranscript } from "../store/transcript";
import { useUi, type UiMode } from "../store/ui";
import { formatMs } from "../time";
import OverviewStrip from "../timeline/OverviewStrip";
import SelectionBar from "../timeline/SelectionBar";
import Timeline, { type WaveMenuInfo } from "../timeline/Timeline";
import WaveContextMenu, { type MenuItem } from "../timeline/WaveContextMenu";
import { applyCandidateRange, removeEffect, updateEffectRange } from "../timeline/selectionActions";
import { bladeAt, removeSeamSplit, seamsOfEdl, setSeamPause, type SeamInfo } from "../timeline/trimActions";
import { toast, uiPrompt } from "../ui";
import Splitter from "./Splitter";
import { useResizable } from "./useResizable";

const EMPTY_C: Candidate[] = [];
const EMPTY_D: DecisionMap = {};
const EMPTY_E: AudioEffect[] = [];
const EMPTY_SPK: SpeakerState = { list: [], turns: [] };
const EMPTY_S: SplitPoint[] = [];
const EMPTY_MK: Marker[] = [];
const EMPTY_OV: Overlay[] = [];
/** 配樂音量的常用檔位（dB）。 */
const OVERLAY_GAINS = [0, -6, -12, -18, -24];
/** 段落之間補呼吸用的常見長度；0 = 拿掉留白，回到直接對接 */
const PAUSE_STEPS: number[] = [0, 200, 500, 1000];

/**
 * 波形工作區：傳輸列 + 時間軸 + 概覽條 + 四個右鍵選單 + 所有跟播放 / 剪輯有關的 hook。
 *
 * 簡易與專業兩個殼掛的是**同一個** Workspace，只是 `variant` 不同：
 * 簡易換成精簡傳輸列、沒有精準修剪器、選取列少幾顆、工具固定在「選取」。
 * 從 MainArea 抽出來就是為了讓兩個殼共用這一塊而不是複製一份。
 */
export default function Workspace({ variant }: { variant: UiMode }) {
  const t = useT();
  const simple = variant === "simple";
  const active = useProject(selectActiveMedia);
  const mediaId = active?.id ?? null;
  const transcript = useTranscript((s) => (mediaId ? s.byMedia[mediaId] ?? null : null));
  const local = useTranscript((s) => (mediaId ? s.local[mediaId] ?? null : null));
  const candidates = useDecisions((s) => (mediaId ? s.candidates[mediaId] ?? EMPTY_C : EMPTY_C));
  const decisions = useDecisions((s) => (mediaId ? s.decisions[mediaId] ?? EMPTY_D : EMPTY_D));
  const effects = useDecisions((s) => (mediaId ? s.effects[mediaId] ?? EMPTY_E : EMPTY_E));
  const splits = useDecisions((s) => (mediaId ? s.splits[mediaId] ?? EMPTY_S : EMPTY_S));
  const speakers = useDecisions((s) => (mediaId ? s.speakers[mediaId] ?? EMPTY_SPK : EMPTY_SPK));
  const selectedIds = useDecisions((s) => s.selectedIds);
  const aggressiveness = useProject((s) => s.aggressiveness);
  const select = useDecisions((s) => s.select);
  const removeCandidate = useDecisions((s) => s.removeCandidate);
  const [menu, setMenu] = useState<WaveMenuInfo | null>(null);
  const fitZoom = useTimeline((s) => s.fit);
  const uiMode = useUi((s) => s.mode);
  const decide = useDecisions((s) => s.decide);
  const seek = usePlayback((s) => s.seek);
  const selection = useTimeline((s) => s.selection);
  const setSelection = useTimeline((s) => s.setSelection);
  const setFocusSeam = useTimeline((s) => s.setFocusSeam);
  const timeline = useResizable({ storageKey: "aicut:timelineH", initial: 220, min: 140, max: () => window.innerHeight * 0.6, axis: "y" });

  // 簡易模式：工具固定在「選取」（定位 / 修剪是專業的東西，小白不該誤切過去）
  useEffect(() => {
    if (simple) useTimeline.getState().setTool("select");
  }, [simple]);

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
  const profile = useUi((s) => s.profile);
  useEffect(() => {
    if (!local) {
      setBeatGrid(null);
      return;
    }
    // 有逐字稿＝這是說話，不是音樂。講話的節奏會讓自相關算出一個「像樣」的 BPM
    // （這個 34 秒的 podcast 就算出 139.5 BPM，信心 0.59），但拍線畫在人聲波形上
    // 只是噪音 —— 使用者要看的是字在哪裡，不是想像中的小節線。
    // 開始畫面選了「剪 Podcast」也算說話：分析還沒跑之前逐字稿是空的，只靠它會誤判。
    const isSpeech = (transcript?.words.length ?? 0) > 0 || profile === "podcast";
    const g = detectBeats(local);
    setBeatGrid(!isSpeech && g.confidence >= MIN_BEAT_CONFIDENCE ? g : null);
  }, [local, transcript, profile, setBeatGrid]);
  useSkipPlayback(cuts);
  useShuttle();
  useOverlayMonitor(overlays, edl);
  useEffectPreview(effects);

  // 開檔 / 切換媒體：波形立刻算（只需 ffmpeg；快取命中幾乎即時）。失敗留在 job 裡由 placeholder 顯示。
  useEffect(() => {
    if (active?.probe && !local) void ensureLocalAnalysis(active.id).catch(() => {});
  }, [active?.id, active?.probe, local]);

  // 切換媒體：若專案檔有分析記錄但 store 還沒有 → 還原；清掉上一個媒體的選取。
  //
  // **選取只在真的換檔案時才清**，不能跟著 `analysis` 狀態變化一起清。
  // 這個 effect 的相依包含 analysis（還原分析要等它變 "ready"），但分析狀態在同一個檔案上
  // 也會轉換（開檔算波形、重跑規則…）。跟著清的話，使用者選好一段、期間分析剛好跑完，
  // 選取就無聲無息不見了。人通常選完馬上就動作所以很難察覺；**AI 助手是隔著好幾秒的
  // 工具往返，中招率接近 100%** —— 實測地端 claude 連續三次 set_selection → lift_selection
  // 都拿到「沒有選取」，最後放棄那項任務。
  const lastMediaId = useRef<string | null>(null);
  useEffect(() => {
    if (active && active.analysis === "ready") void restoreAnalysis(active.id);
    if (active?.id !== lastMediaId.current) {
      lastMediaId.current = active?.id ?? null;
      setSelection(null);
    }
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
    // 有選取：效果 ▸ / 修復 ▸ 從指令註冊表長出來（簡易模式是平的七格）
    if (selection) return selectionMenuItems({ mode: uiMode });
    if (simple) {
      return [
        { label: t("從這裡播放"), icon: Play, onClick: () => { seek(info.ms); playRange(info.ms, dur, { skip: true }); } },
        { separator: true },
        { label: t("從開頭選到這裡"), icon: SquareDashed, onClick: () => setSelection({ startMs: 0, endMs: info.ms }) },
        { label: t("從這裡選到結尾"), icon: SquareDashed, onClick: () => setSelection({ startMs: info.ms, endMs: dur }) },
        { label: t("全選"), icon: SquareDashed, onClick: () => setSelection({ startMs: 0, endMs: dur }) },
      ];
    }
    return [
      { label: t("從這裡播放"), icon: Play, onClick: () => { seek(info.ms); playRange(info.ms, dur, { skip: true }); } },
      { label: t("在這裡切一刀"), icon: Slice, shortcut: "B", onClick: () => void bladeAt(info.ms) },
      { label: t("在這裡下標記"), icon: Flag, shortcut: "M", onClick: () => mediaId && addMarker(mediaId, info.ms, "standard") },
      { label: t("在這裡下章節"), icon: BookMarked, shortcut: "Shift+M", onClick: () => mediaId && addMarker(mediaId, info.ms, "chapter") },
      { label: t("在這裡下待辦"), icon: Check, shortcut: "Alt+M", onClick: () => mediaId && addMarker(mediaId, info.ms, "todo") },
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
      { label: `${t(roleLabel(overlayRole(o)))}　${allMedia.find((m) => m.id === o.mediaId)?.name ?? o.mediaId}`, disabled: true },
      { separator: true },
      { label: t("試聽這一段"), icon: Play, onClick: () => playRange(o.outStartMs, o.outStartMs + len, { skip: true }) },
      { separator: true },
      // 角色決定分軌輸出時它會落在哪一個檔案 —— 拿到成品的人要換掉的通常正是廣告那一段
      ...BUILTIN_ROLES.filter((r) => r.lane === o.lane).map<MenuItem>((r) => ({
        label: t("角色：{name}", { name: t(r.label) }),
        icon: Tags,
        checked: overlayRole(o) === r.id,
        onClick: () => mediaId && updateOverlay(mediaId, o.id, { role: r.id }, "設定角色"),
      })),
      {
        label: t("角色：自訂…"),
        icon: Tags,
        onClick: () => {
          if (!mediaId) return;
          void uiPrompt(t("角色名稱（分軌輸出的檔名會用它）"), { defaultValue: overlayRole(o) }).then((name) => {
            if (name == null) return;
            updateOverlay(mediaId, o.id, { role: name.trim() || undefined }, "設定角色");
          });
        },
      },
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
      ...(simple ? [] : [{ label: t("在這裡精準修剪…"), icon: MoveHorizontal, onClick: () => setFocusSeam(s.srcBeforeMs) } as MenuItem]),
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

  if (!active) return null;
  const durationMs = active.probe?.duration_ms ?? 0;

  return (
    <>
      {simple ? <SimpleTransport durationMs={durationMs} cuts={cuts} /> : <TransportBar durationMs={durationMs} cuts={cuts} />}
      {!simple && <PrecisionTrim seams={seams} analysis={local} transcript={transcript ?? null} />}
      <div className="relative shrink-0 bg-well border-b border-fg/10" style={{ height: timeline.size }} data-testid="timeline-box">
        <Timeline
          mediaId={mediaId}
          analysis={local}
          durationMs={durationMs}
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
          speakerTurns={speakers.turns}
          speakers={speakers.list}
          onMarkerMove={(id, ms) => mediaId && updateMarker(mediaId, id, { ms })}
          onMarkerMenu={(marker, x, y) => setMarkerMenu({ marker, x, y })}
          edl={edl}
          overlays={overlays}
          mediaNameOf={(id) => allMedia.find((m) => m.id === id)?.name ?? id}
          onOverlayChange={(id, patch, label) => mediaId && updateOverlay(mediaId, id, patch, label)}
          onOverlayMenu={(o, x, y) => setOverlayMenu({ o, x, y })}
          onRetry={() => void ensureLocalAnalysis(active.id).catch(() => {})}
          onOpenSettings={(focus) => openSettings(focus ?? null)}
        />
        <SelectionBar variant={variant} />
        {menu && <WaveContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={() => setMenu(null)} />}
        {seamMenu && <WaveContextMenu x={seamMenu.x} y={seamMenu.y} items={seamMenuItems(seamMenu.seam)} onClose={() => setSeamMenu(null)} />}
        {markerMenu && <WaveContextMenu x={markerMenu.x} y={markerMenu.y} items={markerMenuItems(markerMenu.marker)} onClose={() => setMarkerMenu(null)} />}
        {overlayMenu && <WaveContextMenu x={overlayMenu.x} y={overlayMenu.y} items={overlayMenuItems(overlayMenu.o)} onClose={() => setOverlayMenu(null)} />}
      </div>
      <OverviewStrip mediaId={mediaId} durationMs={durationMs} />
      <Splitter axis="y" onPointerDown={timeline.onPointerDown} />
    </>
  );
}
