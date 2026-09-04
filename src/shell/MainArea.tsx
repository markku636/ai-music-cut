import { useEffect, useMemo, useRef } from "react";
import { Music } from "lucide-react";
import { activeRanges } from "../analysis/edl/build";
import { isActiveState, type Candidate, type DecisionMap } from "../analysis/types";
import { EmptyState, Button } from "../ui/index";
import { useT } from "../i18n";
import { restoreAnalysis } from "../pipeline/analyze";
import { ensureLocalAnalysis } from "../pipeline/waveform";
import AudioPlayer from "../preview/AudioPlayer";
import TransportBar from "../preview/TransportBar";
import { useSkipPlayback } from "../preview/useSkipPlayback";
import { useDecisions } from "../store/decisions";
import { usePlayback } from "../store/playback";
import { selectActiveMedia, useProject } from "../store/project";
import { useTimeline } from "../store/timeline";
import { useTranscript } from "../store/transcript";
import SelectionBar from "../timeline/SelectionBar";
import { applyCandidateRange } from "../timeline/selectionActions";
import Timeline from "../timeline/Timeline";
import TranscriptEditor from "../transcript/TranscriptEditor";
import TranscriptPlaceholder from "../transcript/TranscriptPlaceholder";
import Splitter from "./Splitter";
import { useResizable } from "./useResizable";

const EMPTY_C: Candidate[] = [];
const EMPTY_D: DecisionMap = {};

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
  const selectedIds = useDecisions((s) => s.selectedIds);
  const select = useDecisions((s) => s.select);
  const decide = useDecisions((s) => s.decide);
  const toggleWordCut = useDecisions((s) => s.toggleWordCut);
  const seek = usePlayback((s) => s.seek);
  const selection = useTimeline((s) => s.selection);
  const setSelection = useTimeline((s) => s.setSelection);
  const anchorWord = useRef<number | null>(null);
  const timeline = useResizable({ storageKey: "aicut:timelineH", initial: 220, min: 140, max: () => window.innerHeight * 0.6, axis: "y" });

  const cuts = useMemo(() => activeRanges(candidates, decisions), [candidates, decisions]);
  useSkipPlayback(cuts);

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
              onRetry={() => void ensureLocalAnalysis(active.id).catch(() => {})}
              onOpenSettings={onOpenSettings}
            />
            <SelectionBar />
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
        </>
      )}
    </div>
  );
}
