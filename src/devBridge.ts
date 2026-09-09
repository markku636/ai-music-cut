// 開發用的自動化橋接：把幾個 store 與播放 API 掛到 window.__aicut，
// 讓 CDP（WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222）能無視窗驅動與量測 UI 行為。
//
// 只在 `import.meta.env.DEV` 掛載 —— 正式打包時 main.tsx 的 if 會被 tree-shake 掉，window 上不會有任何東西。
// 這是 AICUT_DEV_* 煙霧鉤子的延伸：那些只能「開檔 / 跑分析」，這裡可以量到毫秒。
import { edlFor } from "./pipeline/rules";
import { buildRenderPlan, runRender } from "./pipeline/render";
import { buildBundle } from "./pipeline/bundle";
import { getPlayer, isRangePlaying, lastRangeStop, playRange, seekTo, stopRange, togglePlay } from "./preview/playerRef";
import { currentGain } from "./preview/previewGain";
import { tickCount, tickRunning } from "./preview/ticker";
import { useDecisions } from "./store/decisions";
import { usePlayback } from "./store/playback";
import { skimStatus, skimTo } from "./preview/skimPlayer";
import { useLang } from "./i18n";
import * as batch from "./pipeline/batch";
import * as lexicon from "./analysis/lexicon";
import * as roles from "./analysis/roles";
import * as exportPresets from "./analysis/exportPresets";
import * as preflight from "./analysis/preflight";
import * as keepOnly from "./analysis/keepOnly";
import * as stepDiff from "./analysis/stepDiff";
import * as correct from "./analysis/correct";
import * as meter from "./analysis/meter";
import * as hotwords from "./analysis/hotwords";
import * as textSearch from "./analysis/textSearch";
import * as roleMixLib from "./preview/roleMix";
import { useRoleMix } from "./store/roleMix";
import * as fillerStats from "./analysis/fillerStats";
import * as prompts from "./analysis/prompts";
import { useSettings } from "./store/settings";
import { useCleanup } from "./store/cleanup";
import { chunkedSource, setDevStubSource, startCapture } from "./recording/capture";
import { importIntoSelection } from "./commands/clipCommands";
import { useHighlights } from "./store/highlights";
import { useShowNotes } from "./store/showNotes";
import { useTranscript } from "./store/transcript";
import { useProject } from "./store/project";
import { useTimeline } from "./store/timeline";
import { useUi } from "./store/ui";
import { bladeAt, seamsOfEdl, setSeamPause, trimSeam, type SeamInfo } from "./timeline/trimActions";
import { liftSelection } from "./timeline/trimActions";
import { runCommand, useCommands } from "./commands/registry";
import { useDialogs } from "./store/dialogs";
import { useVerify } from "./store/verify";
import { useJobs } from "./store/jobs";

export interface DevBridge {
  playRange: typeof playRange;
  stopRange: typeof stopRange;
  togglePlay: typeof togglePlay;
  seekTo: typeof seekTo;
  isRangePlaying: typeof isRangePlaying;
  getPlayer: typeof getPlayer;
  playback: typeof usePlayback;
  timeline: typeof useTimeline;
  ui: typeof useUi;
  project: typeof useProject;
  decisions: typeof useDecisions;
  /** 播 startMs–endMs，回報實際停在哪裡（量「選取播放準時收尾」用）。 */
  measureRange: (startMs: number, endMs: number, opts?: { skip?: boolean }) => Promise<{
    startMs: number;
    endMs: number;
    stoppedAtMs: number;
    overshootMs: number;
    wallMs: number;
    frames: number;
  }>;
  ticker: () => { count: number; running: boolean; gain: number };
  lastRangeStop: typeof lastRangeStop;
  edlFor: typeof edlFor;
  buildBundle: typeof buildBundle;
  buildRenderPlan: typeof buildRenderPlan;
  runRender: typeof runRender;
  /** R10 剪輯工具組：刀片 / 修剪 / 提起 / 接縫清單（CDP 量測用）。 */
  bladeAt: typeof bladeAt;
  trimSeam: typeof trimSeam;
  liftSelection: typeof liftSelection;
  setSeamPause: typeof setSeamPause;
  skimStatus: typeof skimStatus;
  skimTo: typeof skimTo;
  cleanup: typeof useCleanup;
  recording: { startCapture: typeof startCapture; chunkedSource: typeof chunkedSource; setDevStubSource: typeof setDevStubSource };
  /** 把音檔放進選取區間（帶路徑就不開 OS 檔案選擇器，探針用）。 */
  importIntoSelection: typeof importIntoSelection;
  highlights: typeof useHighlights;
  showNotes: typeof useShowNotes;
  lang: typeof useLang;
  batch: typeof batch;
  lexicon: typeof lexicon;
  roles: typeof roles;
  exportPresets: typeof exportPresets;
  preflight: typeof preflight;
  keepOnly: typeof keepOnly;
  stepDiff: typeof stepDiff;
  correct: typeof correct;
  meter: typeof meter;
  hotwords: typeof hotwords;
  textSearch: typeof textSearch;
  roleMix: typeof useRoleMix;
  roleMixLib: typeof roleMixLib;
  previewGain: () => number;
  fillerStats: typeof fillerStats;
  prompts: typeof prompts;
  settings: typeof useSettings;
  transcript: typeof useTranscript;
  seams: () => SeamInfo[];
  /** 指令註冊表與對話框堆疊（R1 殼層）。 */
  commands: typeof useCommands;
  runCommand: typeof runCommand;
  dialogs: typeof useDialogs;
  verify: typeof useVerify;
  jobs: typeof useJobs;
}

export function installDevBridge() {
  const measureRange: DevBridge["measureRange"] = (startMs, endMs, opts) =>
    new Promise((resolve) => {
      const el = getPlayer();
      if (!el) throw new Error("no player");
      const t0 = performance.now();
      let frames = 0;
      const count = () => {
        frames++;
        if (isRangePlaying()) requestAnimationFrame(count);
      };
      playRange(startMs, endMs, {
        skip: opts?.skip === true,
        onEnd: () => {
          const stoppedAtMs = el.currentTime * 1000;
          resolve({
            startMs,
            endMs,
            stoppedAtMs,
            overshootMs: stoppedAtMs - endMs,
            wallMs: performance.now() - t0,
            frames,
          });
        },
      });
      requestAnimationFrame(count);
    });

  (window as unknown as { __aicut: DevBridge }).__aicut = {
    playRange,
    stopRange,
    togglePlay,
    seekTo,
    isRangePlaying,
    getPlayer,
    playback: usePlayback,
    timeline: useTimeline,
    ui: useUi,
    project: useProject,
    decisions: useDecisions,
    measureRange,
    ticker: () => ({ count: tickCount(), running: tickRunning(), gain: currentGain() }),
    lastRangeStop,
    edlFor,
    buildRenderPlan,
    runRender,
    // 交付那一包也要能從這裡跑：它讀的是 store，動態 import 會拿到另一組 store 實例
    buildBundle,
    bladeAt,
    trimSeam,
    liftSelection,
    setSeamPause,
    // skim 的狀態一定要從**這裡**讀。手動 import("/src/preview/skimPlayer.ts") 會拿到
    // 另一個模組實例（Vite 給 App 的是帶 ?t= 的 HMR 網址），模組層的 srcPath / el 不共用，
    // 量起來永遠是「沒有音源」。
    skimStatus,
    skimTo,
    // 這幾個 store 一定要從**這裡**拿。自動化腳本手動 import("/src/store/x.ts") 會拿到
    // 另一個模組實例（熱更新之後 App 用的是帶 ?t= 的網址），寫進去的值 App 根本讀不到 ——
    // 量出來像是功能壞了，其實是在對一個平行世界說話。
    cleanup: useCleanup,
    recording: { startCapture, chunkedSource, setDevStubSource },
    importIntoSelection,
    highlights: useHighlights,
    showNotes: useShowNotes,
    lang: useLang,
    batch,
    lexicon,
    roles,
    exportPresets,
    preflight,
    keepOnly,
    stepDiff,
    correct,
    meter,
    hotwords,
    textSearch,
    roleMix: useRoleMix,
    roleMixLib,
    previewGain: currentGain,
    fillerStats,
    prompts,
    settings: useSettings,
    transcript: useTranscript,
    seams: () => {
      const id = useProject.getState().activeMediaId;
      return id ? seamsOfEdl(edlFor(id)) : [];
    },
    commands: useCommands,
    runCommand,
    dialogs: useDialogs,
    verify: useVerify,
    jobs: useJobs,
  };
}
