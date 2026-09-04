import { Music } from "lucide-react";
import { EmptyState, Button } from "../ui/index";
import { useT } from "../i18n";
import AudioPlayer from "../preview/AudioPlayer";
import TransportBar from "../preview/TransportBar";
import { selectActiveMedia, useProject } from "../store/project";
import Splitter from "./Splitter";
import { useResizable } from "./useResizable";

export default function MainArea({ onOpen }: { onOpen: () => void }) {
  const t = useT();
  const active = useProject(selectActiveMedia);
  const timeline = useResizable({ storageKey: "aicut:timelineH", initial: 180, min: 100, max: () => window.innerHeight * 0.6, axis: "y" });

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
          <TransportBar durationMs={active.probe?.duration_ms ?? 0} />
          <div className="shrink-0 bg-well border-b border-fg/10 flex items-center justify-center text-xs text-fg/30" style={{ height: timeline.size }}>
            {t("時間軸（分析後顯示波形與候選區段）")}
          </div>
          <Splitter axis="y" onPointerDown={timeline.onPointerDown} />
          <div className="flex-1 min-h-0 overflow-auto p-4 text-sm text-fg/40 leading-relaxed">
            {t("逐字稿（分析後顯示）")}
          </div>
        </>
      )}
    </div>
  );
}
