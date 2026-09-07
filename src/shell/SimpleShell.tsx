import { APP_NAME } from "../brand";
import { runCommand } from "../commands/registry";
import { useT } from "../i18n";
import { selectActiveMedia, useProject } from "../store/project";
import ModeToggle from "./ModeToggle";
import SetupBanner from "./SetupBanner";
import SimplePanel from "./SimplePanel";
import StartScreen from "./StartScreen";
import StatusBar from "./StatusBar";
import TranscriptArea from "./TranscriptArea";
import WorkflowStrip from "./WorkflowStrip";
import Workspace from "./Workspace";

/**
 * 簡易模式的殼：小標題列 · 三步流程列 · [波形 + 逐字稿 | 你可以做的事] · 精簡狀態列。
 * 沒有工具列、沒有媒體清單、沒有右側五個分頁 —— 小白第一眼看到的東西要少。
 */
export default function SimpleShell() {
  const t = useT();
  const active = useProject(selectActiveMedia);
  return (
    <>
      <div className="h-10 shrink-0 bg-bar border-b border-fg/10 flex items-center px-3 gap-3 shadow-e1">
        <div className="font-semibold text-fg/90 flex items-baseline gap-1.5">
          <span>{APP_NAME}</span>
          <button
            type="button"
            onClick={() => void runCommand("help.about", "toolbar")}
            title={t("版本 {version}", { version: __APP_VERSION__ })}
            className="text-[11px] font-normal text-fg/40 tabular-nums hover:text-fg/70 hover:underline focus-visible:outline-2 focus-visible:outline-accent/60 rounded"
          >
            v{__APP_VERSION__}
          </button>
        </div>
        {active && <span className="text-xs text-fg/50 truncate min-w-0">{active.name}</span>}
        <div className="ml-auto flex items-center gap-2">
          <ModeToggle />
        </div>
      </div>
      <WorkflowStrip variant="simple" />
      <SetupBanner />
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 min-w-0 min-h-0 flex flex-col bg-app">
          {!active ? (
            <StartScreen variant="simple" />
          ) : (
            <>
              <Workspace variant="simple" />
              <TranscriptArea variant="simple" />
            </>
          )}
        </div>
        {active && <SimplePanel />}
      </div>
      <StatusBar variant="simple" />
    </>
  );
}
