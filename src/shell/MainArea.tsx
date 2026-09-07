import ReviewMode from "../decisions/ReviewMode";
import PreviewBar from "../preview/PreviewBar";
import { useDecisions } from "../store/decisions";
import { selectActiveMedia, useProject } from "../store/project";
import { useTranscript } from "../store/transcript";
import StartScreen from "./StartScreen";
import TranscriptArea from "./TranscriptArea";
import Workspace from "./Workspace";

/**
 * 專業模式的中央區：波形工作區 + 逐字稿 + 預覽列 / 審核模式。
 * 波形與逐字稿本體都在 Workspace / TranscriptArea（簡易模式也掛同一份）。
 */
export default function MainArea() {
  const active = useProject(selectActiveMedia);
  const mediaId = active?.id ?? null;
  const hasTranscript = useTranscript((s) => (mediaId ? !!s.byMedia[mediaId] : false));
  const reviewing = useDecisions((s) => s.reviewing);
  const setReviewing = useDecisions((s) => s.setReviewing);

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-app">
      {!active ? (
        <StartScreen variant="pro" />
      ) : (
        <>
          <Workspace variant="pro" />
          <TranscriptArea variant="pro" />
          {mediaId && hasTranscript && !reviewing && <PreviewBar mediaId={mediaId} />}
          {reviewing && mediaId && <ReviewMode mediaId={mediaId} onExit={() => setReviewing(false)} />}
        </>
      )}
    </div>
  );
}
