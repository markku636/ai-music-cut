import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { errMessage } from "./api";
import { AUDIO_EXTENSIONS } from "./brand";
import AboutDialog from "./dialogs/AboutDialog";
import SettingsDialog from "./dialogs/SettingsDialog";
import ShortcutsHelp from "./dialogs/ShortcutsHelp";
import { installHotkeys } from "./hotkeys";
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
      await st.saveTo(target);
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
      }),
    [],
  );

  const notYet = (what: string) => () => toast.info(t("{what}：下一階段實作", { what }));

  return (
    <div className="h-full flex flex-col">
      <Toolbar
        onOpen={() => void openMedia()}
        onAnalyze={notYet(t("分析"))}
        canAnalyze={!!active}
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
      </div>
      <StatusBar onOpenSettings={() => setSettingsOpen(true)} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
      {helpOpen && <ShortcutsHelp onClose={() => setHelpOpen(false)} />}
      <UiHost />
    </div>
  );
}
