import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Crop, Music, Palette, Play, Repeat, Scissors, SquareDashed, Trash, TrendingDown, TrendingUp, Volume2, VolumeX, X, ZoomIn } from "lucide-react";
import type { AudioEffect } from "../analysis/effects";
import { detectBeats, MIN_BEAT_CONFIDENCE } from "../analysis/beats";
import { activeRanges } from "../analysis/edl/build";
import { isActiveState, type Candidate, type DecisionMap } from "../analysis/types";
import { EmptyState, Button } from "../ui/index";
import { useT } from "../i18n";
import { restoreAnalysis } from "../pipeline/analyze";
import { edlFor } from "../pipeline/rules";
import { ensureLocalAnalysis } from "../pipeline/waveform";
import AudioPlayer from "../preview/AudioPlayer";
import { playRange } from "../preview/playerRef";
import { useEffectPreview } from "../preview/useEffectPreview";
import TransportBar from "../preview/TransportBar";
import PreviewBar from "../preview/PreviewBar";
import { useSkipPlayback } from "../preview/useSkipPlayback";
import { useDecisions } from "../store/decisions";
import { usePlayback } from "../store/playback";
import { selectActiveMedia, useProject } from "../store/project";
import { useTimeline } from "../store/timeline";
import { useTranscript } from "../store/transcript";
import SelectionBar from "../timeline/SelectionBar";
import { addEffectOnSelection, applyCandidateRange, clearSelection, cutSelection, keepOnlySelection, removeEffect, updateEffectRange } from "../timeline/selectionActions";
import Timeline, { type WaveMenuInfo } from "../timeline/Timeline";
import WaveContextMenu, { type MenuItem } from "../timeline/WaveContextMenu";
import TranscriptEditor from "../transcript/TranscriptEditor";
import TranscriptPlaceholder from "../transcript/TranscriptPlaceholder";
import ReviewMode from "../decisions/ReviewMode";
import StyleDialog from "../dialogs/StyleDialog";
import Splitter from "./Splitter";
import { useResizable } from "./useResizable";

const EMPTY_C: Candidate[] = [];
const EMPTY_D: DecisionMap = {};
const EMPTY_E: AudioEffect[] = [];
const GAIN_STEPS = [6, 3, -3, -6, -12];

export interface MainAreaProps {
  onOpen: () => void;
  onAnalyze: () => void;
  onOpenSettings: (focus?: "key" | "ffmpeg") => void;
}

export default function MainArea({ onOpen, onAnalyze, onOpenSettings }: MainAreaProps) {
  const t = useT();
  const active = useProject(selectActiveMedia);
  const mediaId = active?.id ?? null;
  const transcript = useTranscript((s) => (mediaId ? s.byMedia[mediaId] ?? null : null));
  const local = useTranscript((s) => (mediaId ? s.local[mediaId] ?? null : null));
  const candidates = useDecisions((s) => (mediaId ? s.candidates[mediaId] ?? EMPTY_C : EMPTY_C));
  const decisions = useDecisions((s) => (mediaId ? s.decisions[mediaId] ?? EMPTY_D : EMPTY_D));
  const effects = useDecisions((s) => (mediaId ? s.effects[mediaId] ?? EMPTY_E : EMPTY_E));
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
  const anchorWord = useRef<number | null>(null);
  const timeline = useResizable({ storageKey: "aicut:timelineH", initial: 220, min: 140, max: () => window.innerHeight * 0.6, axis: "y" });

  // 跳播與輸出必須看同一份剪除區。舊版跳播吃 activeRanges（原始候選直接合併），
  // 輸出吃 buildEdl（pad / 貼齊能量最低點 / 呼吸還原 / 守門降級），兩者差好幾十毫秒 ——
  // 使用者「試聽覺得沒問題」但成品不一樣，是最難查的那種 bug。
  // EDL 算不出來（還沒逐字稿 / 還沒探測）時才退回 activeRanges。
  // edlFor 從 store 直接讀（getState），所以 lint 看不出它依賴什麼；
  // 這些 dep 就是「該重算」的訊號，刻意留著。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const edl = useMemo(() => (mediaId ? edlFor(mediaId) : null), [mediaId, candidates, decisions, aggressiveness, local, transcript]);
  const cuts = useMemo(
    () => edl?.removals.map((r) => ({ startMs: r.startMs, endMs: r.endMs })) ?? activeRanges(candidates, decisions),
    [edl, candidates, decisions],
  );
  // 波形一好就算拍點（純 JS、5 ms 桶自相關；語音信心低會回 null → 不顯示網格）
  const setBeatGrid = useTimeline((s) => s.setBeatGrid);
  useEffect(() => {
    if (!local) {
      setBeatGrid(null);
      return;
    }
    const g = detectBeats(local);
    setBeatGrid(g.confidence >= MIN_BEAT_CONFIDENCE ? g : null);
  }, [local, setBeatGrid]);
  useSkipPlayback(cuts);
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
      { separator: true },
      { label: t("從開頭選到這裡"), icon: SquareDashed, onClick: () => setSelection({ startMs: 0, endMs: info.ms }) },
      { label: t("從這裡選到結尾"), icon: SquareDashed, onClick: () => setSelection({ startMs: info.ms, endMs: dur }) },
      { label: t("全選"), icon: SquareDashed, shortcut: "Ctrl+A", onClick: () => setSelection({ startMs: 0, endMs: dur }) },
      { separator: true },
      { label: t("整段適配"), icon: ZoomIn, shortcut: "Ctrl+0", onClick: fitZoom },
    ];
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
              onRetry={() => void ensureLocalAnalysis(active.id).catch(() => {})}
              onOpenSettings={onOpenSettings}
            />
            <SelectionBar onStyle={(s, e) => setStyleFor({ startMs: s, endMs: e })} />
            {menu && <WaveContextMenu x={menu.x} y={menu.y} items={menuItems(menu)} onClose={() => setMenu(null)} />}
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
