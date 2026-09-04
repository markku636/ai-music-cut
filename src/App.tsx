import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, errMessage } from "./api";
import { AUDIO_EXTENSIONS } from "./brand";
import DecisionPanel from "./decisions/DecisionPanel";
import AboutDialog from "./dialogs/AboutDialog";
import SettingsDialog from "./dialogs/SettingsDialog";
import ShortcutsHelp from "./dialogs/ShortcutsHelp";
import { installHotkeys } from "./hotkeys";
import { runAnalyze } from "./pipeline/analyze";
import { enrichAnalysis } from "./pipeline/persist";
import { runRulesFor } from "./pipeline/rules";
import { playRange } from "./preview/playerRef";
import { useDecisions } from "./store/decisions";
import { usePlayback } from "./store/playback";
import { isActiveState } from "./analysis/types";
import { t } from "./i18n";
import { defaultProjectFileName } from "./project/format";
import MainArea from "./shell/MainArea";
import Sidebar from "./shell/Sidebar";
import Splitter from "./shell/Splitter";
import StatusBar from "./shell/StatusBar";
import Toolbar from "./shell/Toolbar";
import { useResizable } from "./shell/useResizable";
import { selectActiveMedia, useProject } from "./store/project";
import { useSettings } from "./store/settings";
import { applyAppTheme, useTheme } from "./theme";
import { pickOpenFile, pickSaveFile, toast, UiHost } from "./ui";

/** 依時間順序選上一個 / 下一個候選並 seek。 */
function stepCandidate(dir: 1 | -1) {
  const id = useProject.getState().activeMediaId;
  if (!id) return;
  const d = useDecisions.getState();
  const list = d.candidates[id] ?? [];
  if (!list.length) return;
  const cur = list.findIndex((c) => d.selectedIds.includes(c.id));
  let next: number;
  if (cur < 0) {
    const now = usePlayback.getState().currentMs;
    next = dir > 0 ? list.findIndex((c) => c.startMs > now) : list.length - 1;
    if (next < 0) next = 0;
  } else next = Math.max(0, Math.min(list.length - 1, cur + dir));
  const c = list[next];
  d.select([c.id]);
  usePlayback.getState().seek(Math.max(0, c.startMs - 300));
  document.querySelector(`[data-cid="${CSS.escape(c.id)}"]`)?.scrollIntoView({ block: "nearest" });
}

function decideSelected(state: "accepted" | "rejected") {
  const id = useProject.getState().activeMediaId;
  const d = useDecisions.getState();
  if (!id || !d.selectedIds.length) return;
  d.decide(id, d.selectedIds, state);
}

function previewSelected() {
  const id = useProject.getState().activeMediaId;
  const d = useDecisions.getState();
  if (!id || !d.selectedIds.length) return;
  const c = (d.candidates[id] ?? []).find((x) => x.id === d.selectedIds[0]);
  if (!c) return;
  playRange(c.startMs - 1000, c.endMs + 1000, { skip: isActiveState(d.decisions[id]?.[c.id]?.state) });
}

let devAutoOpened = false;

function isAudioPath(p: string): boolean {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_EXTENSIONS.includes(ext);
}

export default function App() {
  const active = useProject(selectActiveMedia);
  const dirty = useProject((s) => s.dirty);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const sidebar = useResizable({ storageKey: "aicut:sidebarW", initial: 272, min: 200, max: () => window.innerWidth * 0.4, axis: "x" });

  // 啟動：套主題、載設定並探測工具狀態。
  useEffect(() => {
    applyAppTheme(useTheme.getState().themeId);
    void useSettings.getState().load();
    // React 已掛載 → 撤掉 index.html 的靜態骨架屏。
    document.getElementById("boot-splash")?.remove();
    // dev 煙霧測試：AICUT_DEV_OPEN=<音檔> [AICUT_DEV_ANALYZE=1] npm run tauri dev
    void (async () => {
      if (devAutoOpened) return; // React StrictMode 會跑兩次 effect
      devAutoOpened = true;
      const p = await api.devEnv("AICUT_DEV_OPEN").catch(() => null);
      if (!p) return;
      await openMedia(p);
      if (await api.devEnv("AICUT_DEV_ANALYZE").catch(() => null)) {
        const id = useProject.getState().activeMediaId;
        if (id) void runAnalyze(id).catch(() => {});
      }
    })();
  }, []);

  const openMedia = async (path?: string) => {
    try {
      const p = path ?? (await pickOpenFile([{ name: t("音訊"), extensions: AUDIO_EXTENSIONS }]));
      if (!p) return;
      if (p.endsWith(".aicut.json")) {
        await useProject.getState().loadFrom(p);
        toast.success(t("已載入專案"));
        return;
      }
      await useProject.getState().openMedia(p);
    } catch (e) {
      toast.error(errMessage(e));
    }
  };

  const saveProject = async () => {
    const st = useProject.getState();
    try {
      let target = st.path;
      if (!target) {
        const name = defaultProjectFileName(selectActiveMedia(st)?.name ?? null);
        target = await pickSaveFile(name, [{ name: "AI Music Cut 專案", extensions: ["json"] }]);
        if (!target) return;
      }
      await st.saveTo(target, enrichAnalysis);
      toast.success(t("已儲存"));
    } catch (e) {
      toast.error(errMessage(e));
    }
  };

  // 拖放音檔 / 專案檔。
  useEffect(() => {
    let un: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((ev) => {
        if (ev.payload.type !== "drop") return;
        for (const p of ev.payload.paths) {
          if (isAudioPath(p) || p.endsWith(".aicut.json")) void openMedia(p);
        }
      })
      .then((f) => {
        un = f;
      })
      .catch(() => {});
    return () => un?.();
  }, []);

  useEffect(
    () =>
      installHotkeys({
        openMedia: () => void openMedia(),
        save: () => void saveProject(),
        help: () => setHelpOpen((v) => !v),
        prevCandidate: () => stepCandidate(-1),
        nextCandidate: () => stepCandidate(1),
        accept: () => decideSelected("accepted"),
        reject: () => decideSelected("rejected"),
        deleteSelection: () => decideSelected("rejected"),
        previewCandidate: () => previewSelected(),
        undo: () => useDecisions.getState().undo(),
        redo: () => useDecisions.getState().redo(),
      }),
    [],
  );

  const rerunRules = () => {
    const id = useProject.getState().activeMediaId;
    if (id) runRulesFor(id, { label: t("調整激進度"), record: true });
  };

  const notYet = (what: string) => () => toast.info(t("{what}：下一階段實作", { what }));

  return (
    <div className="h-full flex flex-col">
      <Toolbar
        onOpen={() => void openMedia()}
        onAnalyze={() => active && void runAnalyze(active.id).catch(() => {})}
        canAnalyze={!!active && active.analysis !== "analyzing"}
        onJudge={notYet(t("AI 判讀"))}
        canJudge={!!active && active.analysis === "ready"}
        onRender={notYet(t("輸出"))}
        canRender={!!active && active.analysis === "ready"}
        onSave={() => void saveProject()}
        dirty={dirty}
        onHelp={() => setHelpOpen(true)}
        onAbout={() => setAboutOpen(true)}
        onSettings={() => setSettingsOpen(true)}
      />
      <div className="flex-1 flex min-h-0">
        <Sidebar width={sidebar.size} onOpen={() => void openMedia()} />
        <Splitter axis="x" onPointerDown={sidebar.onPointerDown} />
        <MainArea onOpen={() => void openMedia()} />
        <DecisionPanel mediaId={active?.id ?? null} onRerunRules={rerunRules} />
      </div>
      <StatusBar onOpenSettings={() => setSettingsOpen(true)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
      {helpOpen && <ShortcutsHelp onClose={() => setHelpOpen(false)} />}
      <UiHost />
    </div>
  );
}
