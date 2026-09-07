import { useEffect, type ComponentType } from "react";
import { selectActiveMedia, useProject } from "../store/project";
import { useDialogs, type DialogId } from "../store/dialogs";
import lazyOverlay from "../ui/lazyOverlay";

/**
 * 依 dialogs store 的堆疊掛載對話框。每個對話框各自 code-split（開了才抓 chunk）。
 *
 * `needs: "media"` 的對話框在 active media 消失時自動關掉 —— 以前是 JSX 裡 `{open && active && …}`，
 * 現在集中在這裡。
 */
type Needs = "none" | "media";

type HostProps = { mediaId: string | null; onClose: () => void } & Record<string, unknown>;
type AnyComp = ComponentType<HostProps>;

/** 各對話框的 props 形狀不同（有的 mediaId 是 string、有的沒有）；由 REG 的 needs 保證掛載時型別成立。 */
function dlg<P extends object>(load: () => Promise<{ default: ComponentType<P> }>): AnyComp {
  return lazyOverlay(load) as unknown as AnyComp;
}

const REG: Record<DialogId, { comp: AnyComp; needs: Needs }> = {
  settings: { comp: dlg(() => import("../dialogs/SettingsDialog")), needs: "none" },
  about: { comp: dlg(() => import("../dialogs/AboutDialog")), needs: "none" },
  shortcuts: { comp: dlg(() => import("../dialogs/ShortcutsHelp")), needs: "none" },
  palette: { comp: dlg(() => import("./CommandPalette")), needs: "none" },
  render: { comp: dlg(() => import("../dialogs/RenderDialog")), needs: "media" },
  verify: { comp: dlg(() => import("../dialogs/VerifyDialog")), needs: "media" },
  separate: { comp: dlg(() => import("../dialogs/SeparateDialog")), needs: "media" },
  sync: { comp: dlg(() => import("../dialogs/SyncDialog")), needs: "none" },
  highlight: { comp: dlg(() => import("../dialogs/HighlightDialog")), needs: "media" },
  music: { comp: dlg(() => import("../dialogs/MusicDialog")), needs: "none" },
  prompts: { comp: dlg(() => import("../dialogs/PromptsDialog")), needs: "none" },
  fillers: { comp: dlg(() => import("../dialogs/FillersDialog")), needs: "none" },
  takes: { comp: dlg(() => import("../dialogs/TakesDialog")), needs: "none" },
  templates: { comp: dlg(() => import("../dialogs/TemplateDialog")), needs: "none" },
  speakers: { comp: dlg(() => import("../dialogs/SpeakersDialog")), needs: "none" },
  captions: { comp: dlg(() => import("../dialogs/CaptionsDialog")), needs: "none" },
  splitExport: { comp: dlg(() => import("../dialogs/SplitExportDialog")), needs: "none" },
  bundle: { comp: dlg(() => import("../dialogs/BundleDialog")), needs: "none" },
  batch: { comp: dlg(() => import("../dialogs/BatchDialog")), needs: "none" },
  autoCut: { comp: dlg(() => import("../dialogs/AutoCutDialog")), needs: "media" },
  showNotes: { comp: dlg(() => import("../dialogs/ShowNotesDialog")), needs: "media" },
  cleanup: { comp: dlg(() => import("../dialogs/CleanupDialog")), needs: "media" },
  highlights: { comp: dlg(() => import("../dialogs/HighlightsDialog")), needs: "media" },
  style: { comp: dlg(() => import("../dialogs/StyleDialog")), needs: "media" },
  effect: { comp: dlg(() => import("../dialogs/EffectDialog")), needs: "media" },
  introOutro: { comp: dlg(() => import("../dialogs/IntroOutroDialog")), needs: "media" },
  convert: { comp: dlg(() => import("../dialogs/ConvertDialog")), needs: "none" },
  merge: { comp: dlg(() => import("../dialogs/MergeDialog")), needs: "none" },
};

export default function DialogHost() {
  const stack = useDialogs((s) => s.stack);
  const close = useDialogs((s) => s.close);
  const active = useProject(selectActiveMedia);
  const activeId = active?.id ?? null;

  useEffect(() => {
    if (activeId) return;
    for (const e of useDialogs.getState().stack) if (REG[e.id].needs === "media") close(e.id);
  }, [activeId, close]);

  return (
    <>
      {stack.map((e) => {
        const { comp: C, needs } = REG[e.id];
        if (needs === "media" && !activeId) return null;
        return <C key={e.key} mediaId={activeId} {...e.props} onClose={() => close(e.id)} />;
      })}
    </>
  );
}
