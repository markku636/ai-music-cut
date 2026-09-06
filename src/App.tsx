import { useEffect, useMemo, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, errMessage } from "./api";
import { AUDIO_EXTENSIONS } from "./brand";
import { installToolBridge } from "./assistant/tools";
import HighlightDialog from "./dialogs/HighlightDialog";
import MusicDialog from "./dialogs/MusicDialog";
import AboutDialog from "./dialogs/AboutDialog";
import RenderDialog from "./dialogs/RenderDialog";
import SeparateDialog from "./dialogs/SeparateDialog";
import SettingsDialog, { type SettingsFocus } from "./dialogs/SettingsDialog";
import VerifyDialog from "./dialogs/VerifyDialog";
import ShortcutsHelp from "./dialogs/ShortcutsHelp";
import type { AudioEffect } from "./analysis/effects";
import { installHotkeys } from "./hotkeys";
import { useUi } from "./store/ui";
import { formatMs } from "./time";
import { bladeAtPlayhead, currentEdl, liftSelection, seamsOfEdl } from "./timeline/trimActions";
import { isSilentDirection, nextShuttle, shuttleLabel } from "./preview/shuttle";
import { runAnalyze } from "./pipeline/analyze";
import { runJudge } from "./pipeline/judge";
import { runVerify } from "./pipeline/verify";
import { enrichAnalysis } from "./pipeline/persist";
import { runRulesFor } from "./pipeline/rules";
import { getPlayer, isRangePlaying, playRange, seekTo, stopRange, togglePlay } from "./preview/playerRef";
import { useDecisions } from "./store/decisions";
import { useAssistant } from "./store/assistant";
import { useAssistantChat } from "./store/assistantChat";
import { usePlayback } from "./store/playback";
import { useTimeline } from "./store/timeline";
import { useVerify } from "./store/verify";
import { isActiveState } from "./analysis/types";
import { t } from "./i18n";
import { defaultProjectFileName } from "./project/format";
import MainArea from "./shell/MainArea";
import RightRail from "./shell/RightRail";
import SetupBanner from "./shell/SetupBanner";
import Sidebar from "./shell/Sidebar";
import Splitter from "./shell/Splitter";
import StatusBar from "./shell/StatusBar";
import Toolbar from "./shell/Toolbar";
import WorkflowStrip from "./shell/WorkflowStrip";
import { useResizable } from "./shell/useResizable";
import { clearSelection, cutSelection } from "./timeline/selectionActions";
import { selectActiveMedia, useProject } from "./store/project";
import { useSettings } from "./store/settings";
import { applyAppTheme, useTheme } from "./theme";
import { pickOpenFile, pickSaveFile, toast, UiHost } from "./ui";

/** 依時間順序選上一個 / 下一個候選並 seek。 */
/** 精準修剪器開著時在接縫之間跳；沒開就回 false 讓 [ ] 回到候選導覽。 */
function stepSeam(dir: 1 | -1): boolean {
  const focus = useTimeline.getState().focusSeamMs;
  if (focus == null) return false;
  const seams = seamsOfEdl(currentEdl());
  if (!seams.length) return false;
  let idx = 0;
  let best = Infinity;
  seams.forEach((s, i) => {
    const d = Math.abs(s.srcBeforeMs - focus);
    if (d < best) {
      best = d;
      idx = i;
    }
  });
  const next = seams[Math.max(0, Math.min(seams.length - 1, idx + dir))];
  if (next) {
    useTimeline.getState().setFocusSeam(next.srcBeforeMs);
    seekTo(Math.max(0, next.srcBeforeMs - 300));
  }
  return true;
}

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

/**
 * Space：有時間選取 → 播這段選取（可循環）；已經在播這段就停。
 * 舊版還要求「而且目前是暫停」，所以播到一半想重播選取只會變成暫停，很難用。
 */
function spaceKey() {
  const tl = useTimeline.getState();
  const p = getPlayer();
  if (tl.selection && p) {
    const pv = usePlayback.getState().preview;
    const onThisSelection =
      isRangePlaying() && !!pv && pv.startMs === tl.selection.startMs && pv.endMs === tl.selection.endMs;
    if (onThisSelection) stopRange();
    else playRange(tl.selection.startMs, tl.selection.endMs, { skip: false, loop: tl.loopSelection });
    return;
  }
  togglePlay();
}

/** Delete：有時間選取 → 剪掉選取；否則拒絕選取的候選。 */
function deleteKey() {
  if (useTimeline.getState().selection) {
    cutSelection();
    return;
  }
  decideSelected("rejected");
}

let devAutoOpened = false;

/** 最近專案（設定檔，最多 10 筆）。 */
function rememberRecent(path: string) {
  const st = useSettings.getState();
  const next = [path, ...st.s.recent_projects.filter((p) => p !== path)].slice(0, 10);
  void st.save({ recent_projects: next });
}

function isAudioPath(p: string): boolean {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return AUDIO_EXTENSIONS.includes(ext);
}

const EMPTY_FX: AudioEffect[] = [];

export default function App() {
  const active = useProject(selectActiveMedia);
  // 索引分頁要的接縫 / 效果。edlFor 直接讀 store，所以用這幾個當「該重算」的訊號。
  const railCands = useDecisions((s) => (active ? s.candidates[active.id] : undefined));
  const railDecs = useDecisions((s) => (active ? s.decisions[active.id] : undefined));
  const railSplits = useDecisions((s) => (active ? s.splits[active.id] : undefined));
  const railEffects = useDecisions((s) => (active ? s.effects[active.id] ?? EMPTY_FX : EMPTY_FX));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const railSeams = useMemo(() => seamsOfEdl(currentEdl()), [active?.id, railCands, railDecs, railSplits]);
  const dirty = useProject((s) => s.dirty);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsFocus, setSettingsFocus] = useState<SettingsFocus>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [renderOpen, setRenderOpen] = useState(false);
  const [separateOpen, setSeparateOpen] = useState(false);
  const [highlightOpen, setHighlightOpen] = useState(false);
  const [musicOpen, setMusicOpen] = useState(false);
  const [verifyFor, setVerifyFor] = useState<{ outPath: string | null; durationMs: number | null } | null>(null);
  const sidebar = useResizable({ storageKey: "aicut:sidebarW", initial: 272, min: 200, max: () => window.innerWidth * 0.4, axis: "x" });

  const openSettings = (focus: SettingsFocus = null) => {
    setSettingsFocus(focus);
    setSettingsOpen(true);
  };

  /** 所有「分析」入口共用的前置檢查：缺 ffmpeg / 金鑰時不轉檔不上傳，直接帶到該設定欄位。 */
  const analyzeWithPreflight = (mediaId?: string) => {
    const id = mediaId ?? useProject.getState().activeMediaId;
    if (!id) return;
    const st = useSettings.getState();
    if (st.ffmpeg && !st.ffmpeg.found) {
      toast.error(t("找不到 ffmpeg，先到設定指定路徑"));
      openSettings("ffmpeg");
      return;
    }
    if (st.key && !st.key.present) {
      toast.info(t("分析需要 ttls 金鑰，先貼上金鑰再開始"));
      openSettings("key");
      return;
    }
    void runAnalyze(id).catch(() => {});
  };

  // 啟動：套主題、載設定並探測工具狀態。
  useEffect(() => {
    applyAppTheme(useTheme.getState().themeId);
    void useSettings.getState().load();
    // React 已掛載 → 撤掉 index.html 的靜態骨架屏。
    document.getElementById("boot-splash")?.remove();
    // dev 煙霧測試：AICUT_DEV_OPEN=<音檔> [AICUT_DEV_ANALYZE=1 AICUT_DEV_REVIEW=1 …] npm run tauri dev
    void (async () => {
      if (devAutoOpened) return; // React StrictMode 會跑兩次 effect
      devAutoOpened = true;
      const p = await api.devEnv("AICUT_DEV_OPEN").catch(() => null);
      if (!p) return;
      await openMedia(p);
      if (await api.devEnv("AICUT_DEV_ANALYZE").catch(() => null)) {
        const id = useProject.getState().activeMediaId;
        if (!id) return;
        const log = (tag: string) => (e: unknown) => void api.clientLog(`[dev ${tag}] ${errMessage(e)}`).catch(() => {});
        await runAnalyze(id).catch(log("analyze"));
        if (await api.devEnv("AICUT_DEV_JUDGE").catch(() => null)) await runJudge(id).catch(log("judge"));
        if (await api.devEnv("AICUT_DEV_RENDER").catch(() => null)) {
          const m = selectActiveMedia(useProject.getState());
          if (m) {
            const { defaultOutPath, runRender } = await import("./pipeline/render");
            await runRender(id, { format: "mp3", outPath: defaultOutPath(m, "mp3", null), leveling: true, targetLufs: -16 }).catch(log("render"));
          }
        }
        if (await api.devEnv("AICUT_DEV_REVIEW").catch(() => null)) useDecisions.getState().setReviewing(true);
        const ask = await api.devEnv("AICUT_DEV_ASK").catch(() => null);
        if (ask) {
          useAssistant.getState().setOpen(true);
          void useAssistantChat.getState().send(ask);
        }
      }
    })();
  }, []);

  const openMedia = async (path?: string) => {
    try {
      const p = path ?? (await pickOpenFile([{ name: t("音訊"), extensions: AUDIO_EXTENSIONS }]));
      if (!p) return;
      if (p.endsWith(".aicut.json")) {
        await useProject.getState().loadFrom(p);
        rememberRecent(p);
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
      rememberRecent(target);
      toast.success(t("已儲存"));
    } catch (e) {
      toast.error(errMessage(e));
    }
  };

  // 自動儲存：專案已有路徑且 dirty → 2 秒後靜默存檔（含逐字稿 / 決策）。
  useEffect(() => {
    let timer: number | undefined;
    const un = useProject.subscribe((s, prev) => {
      if (!s.dirty || !s.path || (s.dirty === prev.dirty && s.path === prev.path)) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const st = useProject.getState();
        if (st.dirty && st.path) void st.saveTo(st.path, enrichAnalysis).catch(() => {});
      }, 2000);
    });
    return () => {
      un();
      window.clearTimeout(timer);
    };
  }, []);

  // MCP 工具橋：登記工具目錄並接工具呼叫。
  useEffect(() => {
    let un: (() => void) | undefined;
    installToolBridge()
      .then((f) => {
        un = f;
      })
      .catch(() => {});
    return () => un?.();
  }, []);

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
        space: spaceKey,
        // 精準修剪器開著的時候，[ ] 是在接縫之間跳；否則是上下一個候選
        prevCandidate: () => (stepSeam(-1) ? undefined : stepCandidate(-1)),
        nextCandidate: () => (stepSeam(1) ? undefined : stepCandidate(1)),
        accept: () => decideSelected("accepted"),
        reject: () => decideSelected("rejected"),
        deleteSelection: deleteKey,
        previewCandidate: () => previewSelected(),
        undo: () => useDecisions.getState().undo(),
        redo: () => useDecisions.getState().redo(),
        zoomIn: () => useTimeline.getState().zoomBy(1.25),
        zoomOut: () => useTimeline.getState().zoomBy(0.8),
        zoomFit: () => useTimeline.getState().fit(),
        zoomSelection: () => useTimeline.getState().zoomToSelection(),
        home: () => seekTo(0),
        end: () => seekTo(Number.MAX_SAFE_INTEGER),
        toolSeek: () => useTimeline.getState().setTool("seek"),
        toolSelect: () => useTimeline.getState().setTool("select"),
        toolTrim: () => useTimeline.getState().setTool("trim"),
        shuttle: (key, opts) => {
          const pb = usePlayback.getState();
          const next = nextShuttle(pb.shuttle, key, { slow: opts.slow });
          pb.setShuttle(next);
          // 只在「剛進入倒退」時說一次，不然每點一下都跳一個 toast
          if (isSilentDirection(next) && !isSilentDirection(pb.shuttle)) toast.info(t("{label}　倒退只移動播放線，沒有聲音", { label: shuttleLabel(next) }));
        },
        markIn: () => {
          const ms = usePlayback.getState().currentMs;
          // 只標了一端要說一聲，否則按了 I 畫面上什麼都沒有，看起來像壞掉
          if (!useTimeline.getState().markIn(ms)) toast.info(t("入點 {at}　再按 O 標出點", { at: formatMs(ms, { millis: true }) }));
        },
        markOut: () => {
          const ms = usePlayback.getState().currentMs;
          if (!useTimeline.getState().markOut(ms)) toast.info(t("出點 {at}　再按 I 標入點", { at: formatMs(ms, { millis: true }) }));
        },
        gotoIn: () => {
          const sel = useTimeline.getState().selection;
          if (sel) seekTo(sel.startMs);
        },
        gotoOut: () => {
          const sel = useTimeline.getState().selection;
          if (sel) seekTo(sel.endMs);
        },
        nudge: (ms) => seekTo(Math.max(0, usePlayback.getState().currentMs + ms)),
        addMarker: (chapter) => {
          const id = useProject.getState().activeMediaId;
          if (!id) return;
          const ms = usePlayback.getState().currentMs;
          useDecisions.getState().addMarker(id, ms, chapter ? "chapter" : "standard");
          // 章節要取名字才有用，直接把索引分頁叫出來
          if (chapter) useUi.getState().setTab("index");
          toast.info(chapter ? t("下了章節 {at}　到「索引」分頁取名字", { at: formatMs(ms, { millis: false }) }) : t("下了標記 {at}", { at: formatMs(ms, { millis: false }) }));
        },
        stepMarker: (dir) => {
          const id = useProject.getState().activeMediaId;
          if (!id) return;
          const list = (useDecisions.getState().markers[id] ?? []).slice().sort((a, b) => a.ms - b.ms);
          if (!list.length) return;
          const cur = usePlayback.getState().currentMs;
          const next = dir > 0 ? list.find((m) => m.ms > cur + 5) : [...list].reverse().find((m) => m.ms < cur - 5);
          if (next) seekTo(next.ms);
        },
        blade: () => {
          const r = bladeAtPlayhead();
          if (r === null) toast.info(t("這裡切不了：太靠近既有的接縫，或落在已剪掉的區段裡"));
          else toast.info(r ? t("切了一刀") : t("移除切點"));
        },
        toggleSnap: () => {
          useTimeline.getState().toggleSnap();
          toast.info(useTimeline.getState().snap.enabled ? t("吸附：開") : t("吸附：關"));
        },
        liftSelection: () => {
          if (!liftSelection()) toast.info(t("先選一段再提起"));
        },
        escape: () => clearSelection(),
        selectAll: () => {
          const m = selectActiveMedia(useProject.getState());
          if (m?.probe) useTimeline.getState().setSelection({ startMs: 0, endMs: m.probe.duration_ms });
        },
      }),
    [],
  );

  const rerunRules = () => {
    const id = useProject.getState().activeMediaId;
    if (id) runRulesFor(id, { label: t("調整激進度"), record: true });
  };

  const onJudge = () => active && void runJudge(active.id).catch((e) => toast.error(errMessage(e)));

  /** 開驗收報告：已有報告就直接看，否則對最近一次輸出跑一次。 */
  const openVerify = () => {
    const id = useProject.getState().activeMediaId;
    if (!id) return;
    const v = useVerify.getState();
    const last = v.lastOutput[id] ?? null;
    // durationMs 交給 runVerify 自己去 probe 成品；這裡不再塞「期望長度」進去（那會讓時長檢查失效）
    setVerifyFor({ outPath: last?.path ?? v.byMedia[id]?.outPath ?? null, durationMs: null });
    if (!v.byMedia[id] && last) void runVerify(id, { outPath: last.path }).catch(() => {});
  };

  /** 輸出完成 → 直接跑 ASR 驗收並開報告（人只要聽機器標出來的可疑處）。 */
  const startVerify = (outPath: string, durationMs: number | null) => {
    const id = useProject.getState().activeMediaId;
    if (!id) return;
    setVerifyFor({ outPath, durationMs });
    void runVerify(id, { outPath, outDurationMs: durationMs }).catch(() => {});
  };

  return (
    <div className="h-full flex flex-col">
      <Toolbar
        onOpen={() => void openMedia()}
        onAnalyze={() => analyzeWithPreflight()}
        canAnalyze={!!active && active.analysis !== "analyzing"}
        onJudge={onJudge}
        canJudge={!!active && active.analysis === "ready"}
        onRender={() => setRenderOpen(true)}
        canRender={!!active}
        onSeparate={() => setSeparateOpen(true)}
        canSeparate={!!active}
        onHighlight={() => setHighlightOpen(true)}
        canHighlight={!!active}
        onMusic={() => setMusicOpen(true)}
        onSave={() => void saveProject()}
        dirty={dirty}
        onHelp={() => setHelpOpen(true)}
        onAbout={() => setAboutOpen(true)}
        onSettings={() => openSettings()}
      />
      <WorkflowStrip
        onOpen={() => void openMedia()}
        onAnalyze={() => analyzeWithPreflight()}
        onJudge={onJudge}
        onRender={() => setRenderOpen(true)}
        onVerify={openVerify}
        onOpenSettings={openSettings}
      />
      <SetupBanner onOpenSettings={openSettings} />
      <div className="flex-1 flex min-h-0">
        <Sidebar width={sidebar.size} onOpen={() => void openMedia()} onAnalyze={(id) => analyzeWithPreflight(id)} onOpenSettings={openSettings} />
        <Splitter axis="x" onPointerDown={sidebar.onPointerDown} />
        <MainArea onOpen={() => void openMedia()} onAnalyze={() => analyzeWithPreflight()} onOpenSettings={openSettings} />
        <RightRail mediaId={active?.id ?? null} analysisState={active?.analysis ?? null} onRerunRules={rerunRules} onVerify={openVerify} seams={railSeams} effects={railEffects} />
      </div>
      <StatusBar onOpenSettings={openSettings} />
      <SettingsDialog open={settingsOpen} focus={settingsFocus} onClose={() => setSettingsOpen(false)} />
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
      {helpOpen && <ShortcutsHelp onClose={() => setHelpOpen(false)} />}
      {renderOpen && active && <RenderDialog mediaId={active.id} onClose={() => setRenderOpen(false)} onVerify={startVerify} />}
      {verifyFor && active && <VerifyDialog mediaId={active.id} outPath={verifyFor.outPath} outDurationMs={verifyFor.durationMs} onClose={() => setVerifyFor(null)} />}
      {separateOpen && active && <SeparateDialog mediaId={active.id} onClose={() => setSeparateOpen(false)} />}
      {highlightOpen && active && <HighlightDialog mediaId={active.id} onClose={() => setHighlightOpen(false)} />}
      {musicOpen && <MusicDialog onClose={() => setMusicOpen(false)} />}
      <UiHost />
    </div>
  );
}
