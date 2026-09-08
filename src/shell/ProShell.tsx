import { useMemo } from "react";
import type { AudioEffect } from "../analysis/effects";
import { useDecisions } from "../store/decisions";
import { selectActiveMedia, useProject } from "../store/project";
import { currentEdl, seamsOfEdl } from "../timeline/trimActions";
import MainArea from "./MainArea";
import RightRail from "./RightRail";
import SetupBanner from "./SetupBanner";
import Sidebar from "./Sidebar";
import Splitter from "./Splitter";
import StatusBar from "./StatusBar";
import MenuBar from "./MenuBar";
import Toolbar from "./Toolbar";
import WorkflowStrip from "./WorkflowStrip";
import { useResizable } from "./useResizable";

const EMPTY_FX: AudioEffect[] = [];

/** 專業模式的殼：工具列 · 流程列 · [媒體 | 波形 + 逐字稿 | 右側欄] · 狀態列。 */
export default function ProShell() {
  const active = useProject(selectActiveMedia);
  // 索引分頁要的接縫 / 效果。edlFor 直接讀 store，所以用這幾個當「該重算」的訊號。
  const railCands = useDecisions((s) => (active ? s.candidates[active.id] : undefined));
  const railDecs = useDecisions((s) => (active ? s.decisions[active.id] : undefined));
  const railSplits = useDecisions((s) => (active ? s.splits[active.id] : undefined));
  const railEffects = useDecisions((s) => (active ? s.effects[active.id] ?? EMPTY_FX : EMPTY_FX));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const railSeams = useMemo(() => seamsOfEdl(currentEdl()), [active?.id, railCands, railDecs, railSplits]);
  const sidebar = useResizable({ storageKey: "aicut:sidebarW", initial: 272, min: 200, max: () => window.innerWidth * 0.4, axis: "x" });

  return (
    <>
      <MenuBar />
      <Toolbar />
      <WorkflowStrip />
      <SetupBanner />
      <div className="flex-1 flex min-h-0">
        <Sidebar width={sidebar.size} />
        <Splitter axis="x" onPointerDown={sidebar.onPointerDown} />
        <MainArea />
        <RightRail mediaId={active?.id ?? null} analysisState={active?.analysis ?? null} seams={railSeams} effects={railEffects} />
      </div>
      <StatusBar />
    </>
  );
}
