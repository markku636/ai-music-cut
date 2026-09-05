// 開發用的自動化橋接：把幾個 store 與播放 API 掛到 window.__aicut，
// 讓 CDP（WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222）能無視窗驅動與量測 UI 行為。
//
// 只在 `import.meta.env.DEV` 掛載 —— 正式打包時 main.tsx 的 if 會被 tree-shake 掉，window 上不會有任何東西。
// 這是 AICUT_DEV_* 煙霧鉤子的延伸：那些只能「開檔 / 跑分析」，這裡可以量到毫秒。
import { edlFor } from "./pipeline/rules";
import { buildRenderPlan, runRender } from "./pipeline/render";
import { getPlayer, isRangePlaying, lastRangeStop, playRange, seekTo, stopRange, togglePlay } from "./preview/playerRef";
import { currentGain } from "./preview/previewGain";
import { tickCount, tickRunning } from "./preview/ticker";
import { useDecisions } from "./store/decisions";
import { usePlayback } from "./store/playback";
import { useProject } from "./store/project";
import { useTimeline } from "./store/timeline";

export interface DevBridge {
  playRange: typeof playRange;
  stopRange: typeof stopRange;
  togglePlay: typeof togglePlay;
  seekTo: typeof seekTo;
  isRangePlaying: typeof isRangePlaying;
  getPlayer: typeof getPlayer;
  playback: typeof usePlayback;
  timeline: typeof useTimeline;
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
  buildRenderPlan: typeof buildRenderPlan;
  runRender: typeof runRender;
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
    project: useProject,
    decisions: useDecisions,
    measureRange,
    ticker: () => ({ count: tickCount(), running: tickRunning(), gain: currentGain() }),
    lastRangeStop,
    edlFor,
    buildRenderPlan,
    runRender,
  };
}
