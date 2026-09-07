import {
  AudioLines,
  BookMarked,
  BrainCircuit,
  Captions,
  Check,
  ChevronsLeft,
  ChevronsRight,
  Clipboard,
  ClipboardPaste,
  Cog,
  Copy,
  Crop,
  Disc3,
  FileMusic,
  FilePlus,
  FileText,
  Flag,
  FolderOpen,
  History,
  Info,
  Keyboard,
  Languages,
  Layers,
  LayoutTemplate,
  Link2,
  ListChecks,
  ListTree,
  Magnet,
  MessageSquareOff,
  MicOff,
  Move,
  MoveHorizontal,
  Music,
  MousePointer2,
  Package,
  Palette,
  Play,
  Redo2,
  Repeat,
  Save,
  Scissors,
  ScrollText,
  Search,
  ShieldCheck,
  Share2,
  SkipBack,
  SkipForward,
  Slice,
  Sparkles,
  SquareDashed,
  Star,
  Undo2,
  Users,
  Volume2,
  VolumeX,
  WandSparkles,
  Zap,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { LANGUAGES, useLang } from "../i18n";
import { playRange, seekTo, togglePlaySelectionAware } from "../preview/playerRef";
import { useAssistant } from "../store/assistant";
import { useDecisions } from "../store/decisions";
import { openDialog, useDialogs } from "../store/dialogs";
import { usePlayback } from "../store/playback";
import { useProject } from "../store/project";
import { useSettings } from "../store/settings";
import { useTimeline } from "../store/timeline";
import { useUi, type Density, type RailTab } from "../store/ui";
import { useTheme } from "../theme";
import { THEMES } from "../themes";
import { useHighlights } from "../store/highlights";
import { keepOnlySelection } from "../timeline/selectionActions";
import { toast } from "../ui";
import { t } from "../i18n";
import * as A from "./appActions";
import { withUndoToast } from "./undoToast";
import { activeId, needsAnalysis, needsAnyMedia, needsClaude, needsHistory, needsMedia, needsNotAnalyzing, needsSelectedCandidate, needsSelection, needsTwoMedia } from "./guards";
import { OK } from "./registry";
import type { Command, Enabled } from "./types";

/**
 * 核心指令表：檔案 / 編輯 / 選取 / 播放 / 檢視 / 工具 / AI / 說明。
 *
 * 每一條的 title 是 zh key（會 t() 過），所以這個檔案在 scripts/check-i18n.mjs 的 TABLE_SOURCES 裡。
 * 快捷鍵寫在這裡就是唯一的一份：hotkeys.ts 派發、ShortcutsHelp 列表、tooltip 都從這裡讀。
 */

function both(...fs: (() => Enabled)[]): () => Enabled {
  return () => {
    for (const f of fs) {
      const r = f();
      if (!r.ok) return r;
    }
    return OK;
  };
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

const RAIL_TABS: { id: RailTab; title: string; icon: typeof ListChecks }[] = [
  { id: "decisions", title: "側欄：決策", icon: ListChecks },
  { id: "index", title: "側欄：索引", icon: ListTree },
  { id: "history", title: "側欄：歷史", icon: History },
  { id: "assistant", title: "側欄：AI 助手", icon: Sparkles },
  { id: "verify", title: "側欄：驗收", icon: ShieldCheck },
];

const DENSITIES: { id: Density; title: string }[] = [
  { id: "compact", title: "緊湊" },
  { id: "normal", title: "標準" },
  { id: "comfortable", title: "寬鬆" },
];

export const CORE_COMMANDS: Command[] = [
  // ---- 檔案 ----
  { id: "file.open", title: "開啟音檔", group: "file", section: "檔案", icon: FolderOpen, shortcuts: ["Ctrl+O"], surfaces: ["menu", "palette", "toolbar", "simple"], simple: true, keywords: ["open"], enabled: () => OK, run: () => A.openMedia() },
  {
    id: "file.recent",
    title: "最近開啟",
    group: "file",
    section: "檔案",
    icon: History,
    enabled: () => (useSettings.getState().s.recent_projects.length ? OK : { ok: false, why: "還沒有最近開啟的檔案" }),
    children: () =>
      useSettings.getState().s.recent_projects.map<Command>((p, i) => ({
        id: `file.recent.${i}`,
        title: baseName(p),
        group: "file",
        enabled: () => OK,
        run: () => A.openMedia(p),
      })),
    run: () => {},
  },
  { id: "file.new", title: "新專案", group: "file", section: "檔案", icon: FilePlus, enabled: () => OK, run: () => useProject.getState().newProject() },
  { id: "file.save", title: "儲存專案", group: "file", section: "檔案", icon: Save, shortcuts: ["Ctrl+S"], surfaces: ["menu", "palette", "toolbar"], badge: () => useProject.getState().dirty, enabled: () => OK, run: () => A.saveProject() },
  { id: "file.saveAs", title: "另存專案…", group: "file", section: "檔案", icon: Save, shortcuts: ["Ctrl+Shift+S"], enabled: () => OK, run: () => A.saveProject({ as: true }) },
  { id: "file.export", title: "輸出", group: "file", section: "輸出", icon: FileMusic, shortcuts: ["Ctrl+E"], surfaces: ["menu", "palette", "toolbar", "simple"], simple: true, simpleLabel: "輸出 mp3", simpleHint: "把剪好的結果存成 mp3 檔", simpleOrder: 8, keywords: ["export", "render"], enabled: needsMedia, run: () => A.openRender(null) },
  {
    id: "file.exportRange",
    title: "只輸出選取範圍…",
    group: "file",
    section: "輸出",
    icon: Share2,
    surfaces: ["menu", "palette", "context"],
    enabled: needsSelection,
    run: () => {
      const sel = useTimeline.getState().selection;
      if (sel) A.openRender({ startMs: sel.startMs, endMs: sel.endMs });
    },
  },
  {
    id: "export.leveling",
    title: "逐段音量平衡",
    group: "file",
    section: "輸出",
    icon: Volume2,
    surfaces: ["menu", "palette", "simple"],
    simple: true,
    simpleLabel: "音量弄整齊",
    simpleHint: "輸出時把每一段拉到一樣大聲（預設開）",
    simpleOrder: 3,
    checked: () => useProject.getState().leveling,
    enabled: needsMedia,
    run: () => {
      const p = useProject.getState();
      const next = !p.leveling;
      p.setLeveling(next);
      toast.info(next ? t("輸出時會逐段平衡音量") : t("輸出時不做逐段平衡"));
    },
  },
  { id: "file.splitExport", title: "依章節分割輸出（一次錄多集）", group: "file", section: "交付", icon: Scissors, enabled: needsMedia, run: () => openDialog("splitExport") },
  { id: "file.captions", title: "字幕與逐字稿（SRT / VTT / Markdown）", group: "file", section: "交付", icon: Captions, enabled: needsAnalysis, run: () => openDialog("captions") },
  { id: "file.bundle", title: "發布包（音檔＋字幕＋筆記＋章節）", group: "file", section: "交付", icon: Package, enabled: needsMedia, run: () => openDialog("bundle") },
  { id: "file.verify", title: "輸出驗收", group: "file", section: "交付", icon: ShieldCheck, enabled: needsMedia, run: () => A.openVerify() },

  // ---- 編輯 ----
  { id: "edit.undo", title: "復原", group: "edit", section: "歷史", icon: Undo2, shortcuts: ["Ctrl+Z"], surfaces: ["menu", "palette", "simple"], simple: true, enabled: () => needsHistory("undo"), run: () => useDecisions.getState().undo() },
  { id: "edit.redo", title: "重做", group: "edit", section: "歷史", icon: Redo2, shortcuts: ["Ctrl+Y", "Ctrl+Shift+Z"], simple: true, enabled: () => needsHistory("redo"), run: () => useDecisions.getState().redo() },
  {
    id: "edit.cut",
    title: "剪掉",
    group: "edit",
    section: "剪輯",
    icon: Scissors,
    shortcuts: ["Delete", "Backspace"],
    surfaces: ["menu", "palette", "context", "simple"],
    simple: true,
    simpleLabel: "剪掉選的這段",
    simpleHint: "先在波形上拖一段",
    simpleOrder: 4,
    keywords: ["cut", "delete"],
    // 有選取剪選取；沒有選取但選了候選 → 拒絕候選（Delete 的舊語意）
    enabled: () => (useTimeline.getState().selection || useDecisions.getState().selectedIds.length ? needsMedia() : { ok: false, why: "先在波形上拖一段" }),
    run: () => withUndoToast(t("已剪掉"), () => A.deleteKey()),
  },
  { id: "edit.lift", title: "提起（留白靜音，不關洞）", group: "edit", section: "剪輯", icon: VolumeX, shortcuts: ["Shift+Delete", "Shift+Backspace"], surfaces: ["menu", "palette", "context"], enabled: needsSelection, run: () => A.liftWithToast() },
  {
    id: "edit.keepOnly",
    title: "只保留（頭尾剪掉）",
    group: "edit",
    section: "剪輯",
    icon: Crop,
    surfaces: ["menu", "palette", "context", "simple"],
    simple: true,
    simpleLabel: "只留選的這段",
    simpleHint: "頭尾都剪掉，只留下拖選的",
    simpleOrder: 5,
    enabled: needsSelection,
    run: () => withUndoToast(t("只留下選的這段"), () => void keepOnlySelection()),
  },
  { id: "edit.blade", title: "在播放線切一刀", group: "edit", section: "剪輯", icon: Slice, shortcuts: ["B"], enabled: needsMedia, run: () => A.bladeToggle() },
  { id: "edit.cutClipboard", title: "剪下選取", group: "edit", section: "剪貼簿", icon: Clipboard, shortcuts: ["Ctrl+X"], enabled: needsSelection, run: () => A.cutToClipboard() },
  { id: "edit.copy", title: "複製選取", group: "edit", section: "剪貼簿", icon: Copy, shortcuts: ["Ctrl+C"], enabled: needsSelection, run: () => A.copyToClipboardAction() },
  { id: "edit.paste", title: "貼到播放線", group: "edit", section: "剪貼簿", icon: ClipboardPaste, shortcuts: ["Ctrl+V"], enabled: needsMedia, run: () => A.pasteAtPlayheadAction() },
  { id: "edit.move", title: "把選取搬到播放線（剪下 + 貼上）", group: "edit", section: "剪貼簿", icon: Move, shortcuts: ["Ctrl+Shift+V"], enabled: needsSelection, run: () => A.moveToPlayheadAction() },
  { id: "edit.marker", title: "在播放線下標記", group: "edit", section: "標記", icon: Flag, shortcuts: ["M"], enabled: needsMedia, run: () => A.addMarkerAtPlayhead("standard") },
  { id: "edit.chapter", title: "在播放線下章節", group: "edit", section: "標記", icon: BookMarked, shortcuts: ["Shift+M"], enabled: needsMedia, run: () => A.addMarkerAtPlayhead("chapter") },
  { id: "edit.todo", title: "在播放線下待辦", group: "edit", section: "標記", icon: Check, shortcuts: ["Alt+M"], enabled: needsMedia, run: () => A.addMarkerAtPlayhead("todo") },
  { id: "edit.accept", title: "接受選取的候選", group: "edit", section: "候選", icon: Check, shortcuts: ["A"], enabled: needsSelectedCandidate, run: () => A.decideSelected("accepted") },
  { id: "edit.reject", title: "拒絕選取的候選", group: "edit", section: "候選", icon: MessageSquareOff, shortcuts: ["R"], enabled: needsSelectedCandidate, run: () => A.decideSelected("rejected") },
  { id: "edit.previewCandidate", title: "預聽選取的候選", group: "edit", section: "候選", icon: Play, shortcuts: ["P"], enabled: needsSelectedCandidate, run: () => A.previewSelected() },
  { id: "edit.prevCandidate", title: "上一個候選", group: "edit", section: "候選", icon: ChevronsLeft, shortcuts: ["["], enabled: needsMedia, run: () => A.stepCandidate(-1) },
  { id: "edit.nextCandidate", title: "下一個候選", group: "edit", section: "候選", icon: ChevronsRight, shortcuts: ["]"], enabled: needsMedia, run: () => A.stepCandidate(1) },

  // ---- 選取 ----
  { id: "select.all", title: "全選", group: "select", section: "選取", icon: SquareDashed, shortcuts: ["Ctrl+A"], simple: true, enabled: needsMedia, run: () => A.selectAll() },
  { id: "select.clear", title: "清除選取", group: "select", section: "選取", icon: SquareDashed, shortcuts: ["Escape", "Alt+X"], surfaces: ["menu", "palette", "context"], simple: true, enabled: needsSelection, run: () => A.clearSelection() },
  { id: "select.zoom", title: "縮放到選取", group: "select", section: "選取", icon: ZoomIn, shortcuts: ["Z"], surfaces: ["menu", "palette", "context"], simple: true, enabled: needsSelection, run: () => useTimeline.getState().zoomToSelection() },
  { id: "select.markIn", title: "標入點", group: "select", section: "入出點", icon: SquareDashed, shortcuts: ["I"], enabled: needsMedia, run: () => A.markIn() },
  { id: "select.markOut", title: "標出點", group: "select", section: "入出點", icon: SquareDashed, shortcuts: ["O"], enabled: needsMedia, run: () => A.markOut() },
  { id: "select.gotoIn", title: "跳到入點", group: "select", section: "入出點", icon: SkipBack, shortcuts: ["Shift+I"], enabled: needsSelection, run: () => A.gotoIn() },
  { id: "select.gotoOut", title: "跳到出點", group: "select", section: "入出點", icon: SkipForward, shortcuts: ["Shift+O"], enabled: needsSelection, run: () => A.gotoOut() },
  { id: "select.prevMarker", title: "上一個標記", group: "select", section: "導覽", icon: Flag, shortcuts: ["Alt+["], enabled: needsMedia, run: () => A.stepMarker(-1) },
  { id: "select.nextMarker", title: "下一個標記", group: "select", section: "導覽", icon: Flag, shortcuts: ["Alt+]"], enabled: needsMedia, run: () => A.stepMarker(1) },
  { id: "select.prevSpeaker", title: "上一個換人處", group: "select", section: "導覽", icon: Users, shortcuts: ["Alt+Shift+["], enabled: needsMedia, run: () => A.stepSpeaker(-1) },
  { id: "select.nextSpeaker", title: "下一個換人處", group: "select", section: "導覽", icon: Users, shortcuts: ["Alt+Shift+]"], enabled: needsMedia, run: () => A.stepSpeaker(1) },
  { id: "select.find", title: "在逐字稿裡找字（找到可整集一次剪掉）", group: "select", section: "導覽", icon: Search, shortcuts: ["Ctrl+F"], keywords: ["find", "search"], enabled: needsAnalysis, run: () => useUi.getState().setTranscriptSearch(true) },
  {
    id: "select.highlight",
    title: "加進精華片段（之後可以串成一支預告）",
    group: "select",
    section: "精華",
    icon: Star,
    surfaces: ["menu", "palette", "context"],
    enabled: needsSelection,
    run: () => {
      const id = activeId();
      const sel = useTimeline.getState().selection;
      if (!id || !sel) return;
      useHighlights.getState().add(id, sel.startMs, sel.endMs);
      toast.success(t("已加進精華片段（共 {n} 段）").replace("{n}", String(useHighlights.getState().list(id).length)));
    },
  },

  // ---- 播放 ----
  { id: "playback.toggle", title: "播放 / 暫停", group: "playback", section: "播放", icon: Play, shortcuts: ["Space"], simple: true, enabled: needsMedia, run: () => togglePlaySelectionAware() },
  {
    id: "playback.playSelection",
    title: "播放選取",
    group: "playback",
    section: "播放",
    icon: Play,
    surfaces: ["palette", "context", "simple"],
    simple: true,
    simpleLabel: "播放這段",
    enabled: needsSelection,
    run: () => {
      const sel = useTimeline.getState().selection;
      if (sel) playRange(sel.startMs, sel.endMs, { skip: false, loop: useTimeline.getState().loopSelection });
    },
  },
  { id: "playback.loop", title: "循環播放", group: "playback", section: "播放", icon: Repeat, surfaces: ["menu", "palette", "context"], checked: () => useTimeline.getState().loopSelection, enabled: needsMedia, run: () => useTimeline.getState().toggleLoop() },
  { id: "playback.skip", title: "跳過剪掉的段落", group: "playback", section: "播放", icon: SkipForward, checked: () => usePlayback.getState().skipEnabled, enabled: needsMedia, run: () => usePlayback.getState().toggleSkip() },
  { id: "playback.home", title: "跳到開頭", group: "playback", section: "跳轉", icon: SkipBack, shortcuts: ["Home"], enabled: needsMedia, run: () => seekTo(0) },
  { id: "playback.end", title: "跳到結尾", group: "playback", section: "跳轉", icon: SkipForward, shortcuts: ["End"], enabled: needsMedia, run: () => seekTo(Number.MAX_SAFE_INTEGER) },
  { id: "playback.shuttle", title: "轉盤：倒退 / 停 / 前進", group: "playback", section: "跳轉", icon: MoveHorizontal, shortcuts: ["J", "K", "L"], shortcutManual: true, surfaces: [], enabled: needsMedia, run: () => {} },

  // ---- 檢視 ----
  { id: "view.toolSeek", title: "工具：定位", group: "view", section: "工具", icon: MousePointer2, shortcuts: ["V"], checked: () => useTimeline.getState().tool === "seek", enabled: () => OK, run: () => useTimeline.getState().setTool("seek") },
  { id: "view.toolSelect", title: "工具：選取", group: "view", section: "工具", icon: SquareDashed, shortcuts: ["S"], checked: () => useTimeline.getState().tool === "select", enabled: () => OK, run: () => useTimeline.getState().setTool("select") },
  { id: "view.toolTrim", title: "工具：修剪", group: "view", section: "工具", icon: MoveHorizontal, shortcuts: ["T"], checked: () => useTimeline.getState().tool === "trim", enabled: () => OK, run: () => useTimeline.getState().setTool("trim") },
  { id: "view.snap", title: "吸附", group: "view", section: "波形", icon: Magnet, shortcuts: ["N"], checked: () => useTimeline.getState().snap.enabled, enabled: () => OK, run: () => A.toggleSnapWithToast() },
  { id: "view.skim", title: "滑過波形就聽得到（skimming）開關", group: "view", section: "波形", icon: Volume2, shortcuts: ["Shift+S"], checked: () => useTimeline.getState().skim, enabled: () => OK, run: () => useTimeline.getState().toggleSkim() },
  { id: "view.beats", title: "顯示拍線", group: "view", section: "波形", icon: Music, checked: () => useTimeline.getState().showBeats, enabled: () => (useTimeline.getState().beatGrid ? OK : { ok: false, why: "這個檔案沒有偵測到拍子" }), run: () => useTimeline.getState().toggleBeats() },
  { id: "view.loudness", title: "顯示響度表", group: "view", section: "波形", icon: Volume2, checked: () => useTimeline.getState().showLoudness, enabled: () => OK, run: () => useTimeline.getState().toggleLoudness() },
  {
    id: "view.spectrogram",
    title: "波形 / 頻譜 / 疊合",
    group: "view",
    section: "波形",
    icon: AudioLines,
    keywords: ["spectrogram", "spectrum", "frequency"],
    checked: () => useTimeline.getState().viewMode !== "wave",
    enabled: needsMedia,
    run: () => useTimeline.getState().cycleViewMode(),
  },
  { id: "view.follow", title: "跟隨播放線：翻頁 / 置中 / 關", group: "view", section: "波形", icon: MoveHorizontal, enabled: () => OK, run: () => usePlayback.getState().cycleFollow() },
  { id: "view.zoomIn", title: "放大", group: "view", section: "縮放", icon: ZoomIn, shortcuts: ["Ctrl+=", "Ctrl+Shift+="], simple: true, enabled: needsMedia, run: () => useTimeline.getState().zoomBy(1.25) },
  { id: "view.zoomOut", title: "縮小", group: "view", section: "縮放", icon: ZoomOut, shortcuts: ["Ctrl+-"], simple: true, enabled: needsMedia, run: () => useTimeline.getState().zoomBy(0.8) },
  { id: "view.zoomFit", title: "整段適配", group: "view", section: "縮放", icon: ZoomOut, shortcuts: ["Ctrl+0"], simple: true, enabled: needsMedia, run: () => useTimeline.getState().fit() },
  ...RAIL_TABS.map<Command>((x) => ({
    id: `view.rail.${x.id}`,
    title: x.title,
    group: "view",
    section: "側欄",
    icon: x.icon,
    checked: () => useUi.getState().railOpen && useUi.getState().tab === x.id,
    enabled: () => OK,
    run: () => useUi.getState().toggleTab(x.id),
  })),
  { id: "view.railToggle", title: "收合側欄", group: "view", section: "側欄", icon: ChevronsRight, checked: () => !useUi.getState().railOpen, enabled: () => OK, run: () => useUi.getState().setRailOpen(!useUi.getState().railOpen) },
  {
    id: "view.mode.toggle",
    title: "切換簡易 / 專業模式",
    group: "view",
    section: "側欄",
    icon: LayoutTemplate,
    simple: true,
    keywords: ["simple", "pro", "mode"],
    checked: () => useUi.getState().mode === "pro",
    enabled: () => OK,
    run: () => useUi.getState().toggleMode(),
  },
  ...DENSITIES.map<Command>((d) => ({
    id: `view.density.${d.id}`,
    title: d.title,
    group: "view",
    section: "介面密度",
    checked: () => useUi.getState().density === d.id,
    enabled: () => OK,
    run: () => useUi.getState().setDensity(d.id),
  })),
  {
    id: "view.lang",
    title: "語言",
    group: "view",
    section: "外觀",
    icon: Languages,
    enabled: () => OK,
    children: () =>
      LANGUAGES.map<Command>((l) => ({
        id: `view.lang.${l.id}`,
        title: l.label,
        group: "view",
        checked: () => useLang.getState().lang === l.id,
        enabled: () => OK,
        run: () => void useLang.getState().setLang(l.id),
      })),
    run: () => {},
  },
  {
    id: "view.theme",
    title: "主題",
    group: "view",
    section: "外觀",
    icon: Palette,
    enabled: () => OK,
    children: () =>
      THEMES.map<Command>((th) => ({
        id: `view.theme.${th.id}`,
        title: th.label,
        group: "view",
        checked: () => useTheme.getState().themeId === th.id,
        enabled: () => OK,
        run: () => useTheme.getState().setThemeId(th.id),
      })),
    run: () => {},
  },

  // ---- 工具 ----
  { id: "tool.fillers", title: "贅字管理（依詞整群處理）", group: "tool", section: "這一集", icon: MessageSquareOff, enabled: () => OK, run: () => openDialog("fillers") },
  { id: "tool.takes", title: "替代 take（同一句講了好幾次）", group: "tool", section: "這一集", icon: Layers, enabled: needsAnalysis, run: () => openDialog("takes") },
  { id: "tool.speakers", title: "講者（誰講了多久 / 改名 / 手動指派）", group: "tool", section: "這一集", icon: Users, enabled: () => OK, run: () => openDialog("speakers") },
  { id: "tool.sync", title: "同步麥克風", group: "tool", section: "這一集", icon: Link2, enabled: needsTwoMedia, run: () => openDialog("sync") },
  { id: "tool.batch", title: "批次處理（多集一次跑完）", group: "tool", section: "跨集", icon: Layers, enabled: needsAnyMedia, run: () => openDialog("batch") },
  { id: "tool.templates", title: "專案範本（開場 / 片尾 / 目標響度）", group: "tool", section: "跨集", icon: LayoutTemplate, enabled: () => OK, run: () => openDialog("templates") },
  { id: "tool.prompts", title: "提示詞", group: "tool", section: "設定", icon: ScrollText, enabled: () => OK, run: () => openDialog("prompts") },
  { id: "tool.settings", title: "設定", group: "tool", section: "設定", icon: Cog, shortcuts: ["Ctrl+,"], keywords: ["settings", "preferences"], enabled: () => OK, run: () => A.openSettings() },

  // ---- AI ----
  { id: "ai.assistant", title: "AI 助手", group: "ai", section: "AI", icon: Sparkles, checked: () => useAssistant.getState().open, enabled: () => OK, run: () => useAssistant.getState().toggle() },
  { id: "ai.judge", title: "AI 判讀（剪輯＋審核）", group: "ai", section: "這一集", icon: BrainCircuit, enabled: both(needsAnalysis, needsClaude), run: () => A.judgeActive() },
  { id: "ai.autoCut", title: "一鍵智慧剪輯", group: "ai", section: "這一集", icon: Zap, surfaces: ["menu", "palette", "toolbar"], enabled: needsMedia, run: () => openDialog("autoCut") },
  {
    id: "ai.analyze",
    title: "分析",
    group: "ai",
    section: "這一集",
    icon: WandSparkles,
    surfaces: ["menu", "palette", "toolbar", "simple"],
    simple: true,
    simpleLabel: "自動剪掉贅字",
    simpleHint: "找出嗯、呃、重講並剪掉；逐字稿劃線＝已剪，雙擊可還原",
    simpleOrder: 1,
    keywords: ["analyze", "transcribe"],
    enabled: needsNotAnalyzing,
    run: () => {
      // 簡易模式再按一次不重跑：解釋劃線是什麼，別讓人以為壞了
      const st = useProject.getState();
      const m = st.media.find((x) => x.id === st.activeMediaId);
      if (useUi.getState().mode === "simple" && m?.analysis === "ready") {
        toast.info(t("已經剪過了：劃線的字就是剪掉的，雙擊可以還原"));
        return;
      }
      A.analyzeWithPreflight();
    },
  },
  { id: "ai.separate", title: "去人聲", group: "ai", section: "聲音", icon: MicOff, enabled: needsMedia, run: () => openDialog("separate") },
  { id: "ai.music", title: "AI 配樂", group: "ai", section: "聲音", icon: Disc3, enabled: () => OK, run: () => openDialog("music") },
  {
    id: "ai.music.introOutro",
    title: "加片頭 / 片尾音樂",
    group: "ai",
    section: "聲音",
    icon: Music,
    surfaces: ["menu", "palette", "simple"],
    simple: true,
    simpleLabel: "加片頭 / 片尾音樂",
    simpleHint: "選一個音樂檔，放到開頭或結尾，會自動在講話時變小聲",
    simpleOrder: 6,
    keywords: ["intro", "outro", "music", "bgm"],
    enabled: needsMedia,
    run: () => openDialog("introOutro"),
  },
  {
    id: "ai.style",
    title: "改成另一種曲風…",
    group: "ai",
    section: "聲音",
    icon: Palette,
    surfaces: ["palette", "context"],
    enabled: needsSelection,
    run: () => {
      const sel = useTimeline.getState().selection;
      if (sel) openDialog("style", { startMs: sel.startMs, endMs: sel.endMs });
    },
  },
  { id: "ai.highlight", title: "精華片段", group: "ai", section: "精華", icon: Zap, enabled: needsMedia, run: () => openDialog("highlight") },
  { id: "ai.highlights", title: "精華合輯（串成一支預告）", group: "ai", section: "精華", icon: Star, enabled: needsMedia, run: () => openDialog("highlights") },
  { id: "ai.showNotes", title: "節目筆記（摘要 / 章節 / 節錄）", group: "ai", section: "交付", icon: FileText, enabled: needsMedia, run: () => openDialog("showNotes") },

  // ---- 說明 ----
  {
    id: "help.palette",
    title: "搜尋指令",
    group: "help",
    section: "說明",
    icon: Search,
    shortcuts: ["Ctrl+K", "Ctrl+Shift+P"],
    global: true,
    keywords: ["palette", "command"],
    enabled: () => OK,
    run: () => {
      const d = useDialogs.getState();
      if (d.isOpen("palette")) d.close("palette");
      else d.open("palette");
    },
  },
  { id: "help.shortcuts", title: "快捷鍵", group: "help", section: "說明", icon: Keyboard, shortcuts: ["F1"], global: true, enabled: () => OK, run: () => openDialog("shortcuts") },
  { id: "help.about", title: "關於", group: "help", section: "說明", icon: Info, enabled: () => OK, run: () => openDialog("about") },
];
