import { useEffect, useMemo } from "react";
import { Music } from "lucide-react";
import { activeRanges } from "../analysis/edl/build";
import type { Candidate, DecisionMap } from "../analysis/types";
import { EmptyState, Button } from "../ui/index";
import { useT } from "../i18n";
import { restoreAnalysis } from "../pipeline/analyze";
import AudioPlayer from "../preview/AudioPlayer";
import TransportBar from "../preview/TransportBar";
import { useSkipPlayback } from "../preview/useSkipPlayback";
import { useDecisions } from "../store/decisions";
import { usePlayback } from "../store/playback";
import { selectActiveMedia, useProject } from "../store/project";
import { useTranscript } from "../store/transcript";
import Timeline from "../timeline/Timeline";
import TranscriptEditor from "../transcript/TranscriptEditor";
import Splitter from "./Splitter";
import { useResizable } from "./useResizable";

const EMPTY_C: Candidate[] = [];
const EMPTY_D: DecisionMap = {};

export default function MainArea({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  const active = useProject(selectActiveMedia);
  const mediaId = active?.id ?? null;
  const transcript = useTranscript((s) => (mediaId ? s.byMedia[mediaId] ?? null : null));
  const local = useTranscript((s) => (mediaId ? s.local[mediaId] ?? null : null));
  const candidates = useDecisions((s) => (mediaId ? s.candidates[mediaId] ?? EMPTY_C : EMPTY_C));
  const decisions = useDecisions((s) => (mediaId ? s.decisions[mediaId] ?? EMPTY_D : EMPTY_D));
  const selectedIds = useDecisions((s) => s.selectedIds);
  const select = useDecisions((s) => s.select);
  const toggleWordCut = useDecisions((s) => s.toggleWordCut);
  const seek = usePlayback((s) => s.seek);
  const timeline = useResizable({ storageKey: "aicut:timelineH", initial: 180, min: 100, max: () => window.innerHeight * 0.6, axis: "y" });

  const cuts = useMemo(() => activeRanges(candidates, decisions), [candidates, decisions]);
  useSkipPlayback(cuts);

  // 切換媒體：若專案檔有分析記錄但 store 還沒有 → 還原。
  useEffect(() => {
    if (active && active.analysis === "ready") void restoreAnalysis(active.id);
  }, [active?.id, active?.analysis]); // eslint-disable-line react-hooks/exhaustive-deps

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
          <div className="shrink-0 bg-well border-b border-fg/10" style={{ height: timeline.size }}>
            <Timeline
              analysis={local}
              durationMs={active.probe?.duration_ms ?? 0}
              height={timeline.size}
              candidates={candidates}
              decisions={decisions}
              selectedIds={selectedIds}
              onSelect={(id) => select([id])}
            />
          </div>
          <Splitter axis="y" onPointerDown={timeline.onPointerDown} />
          <TranscriptEditor
            transcript={transcript}
            candidates={candidates}
            decisions={decisions}
            selectedIds={selectedIds}
            onWordClick={(wordId, cids) => {
              const w = transcript?.words[wordId];
              if (w) seek(w.startMs);
              select(cids.slice(0, 1));
            }}
            onWordToggle={(wordId) => {
              const w = transcript?.words[wordId];
              if (!w || !mediaId) return;
              const sid = transcript?.sentences.find((s) => s.wordIds.includes(wordId))?.id ?? -1;
              toggleWordCut(mediaId, wordId, w, sid);
            }}
          />
        </>
      )}
    </div>
  );
}
