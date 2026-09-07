import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { api, errMessage } from "./api";
import { installToolBridge } from "./assistant/tools";
import { installCommands } from "./commands";
import * as A from "./commands/appActions";
import { installHotkeys } from "./hotkeys";
import { runAnalyze } from "./pipeline/analyze";
import { runJudge } from "./pipeline/judge";
import { enrichAnalysis } from "./pipeline/persist";
import AudioPlayer from "./preview/AudioPlayer";
import DialogHost from "./shell/DialogHost";
import ProShell from "./shell/ProShell";
import SimpleShell from "./shell/SimpleShell";
import { useAssistant } from "./store/assistant";
import { useAssistantChat } from "./store/assistantChat";
import { useDecisions } from "./store/decisions";
import { defaultAggressiveness, selectActiveMedia, useProject } from "./store/project";
import { useSettings } from "./store/settings";
import { useUi } from "./store/ui";
import { applyAppTheme, useTheme } from "./theme";
import { UiHost } from "./ui";

let devAutoOpened = false;

/** 開場畫面至少待這麼久（毫秒），動畫才看得完；淡出另外算。 */
const SPLASH_MIN_MS = 780;
const SPLASH_FADE_MS = 300;

function hideBootSplash(): void {
  const el = document.getElementById("boot-splash");
  if (!el || el.classList.contains("done")) return; // StrictMode 會跑兩次
  const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  const wait = reduced ? 0 : Math.max(0, SPLASH_MIN_MS - performance.now());
  window.setTimeout(() => {
    el.classList.add("done");
    window.setTimeout(() => el.remove(), SPLASH_FADE_MS);
  }, wait);
}

/**
 * App 根：啟動效果 + 選一個殼。所有「動作」在 commands/（指令註冊表），所有對話框在 DialogHost。
 * 簡易 / 專業是同一套指令、同一個 Workspace 的兩種組合（SimpleShell / ProShell）。
 */
export default function App() {
  const active = useProject(selectActiveMedia);
  const mode = useUi((s) => s.mode);

  // 指令註冊表 + 反應性訂閱（冪等，StrictMode 跑兩次沒關係）
  useEffect(() => installCommands(), []);

  // 啟動：套主題、載設定並探測工具狀態。
  useEffect(() => {
    applyAppTheme(useTheme.getState().themeId);
    void useSettings.getState().load().then(() => {
      // 設定載完才套「預設激進度」：store 的初始值是在模組載入時決定的，那時設定還沒進來。
      // 只在還沒開任何東西的時候套 —— 已經載入的專案有自己存的值，不能被設定蓋掉。
      const p = useProject.getState();
      if (!p.path && p.media.length === 0) p.setAggressiveness(defaultAggressiveness());
    });
    // React 已掛載 → 撤掉 index.html 的開場畫面。
    // 直接 remove() 的話，開場動畫在快的機器上只會閃一下就不見（等於白做），
    // 所以從網頁開始算至少讓它待滿 SPLASH_MIN_MS 再淡出；減少動態偏好時不等。
    hideBootSplash();
    // dev 煙霧測試：AICUT_DEV_OPEN=<音檔> [AICUT_DEV_ANALYZE=1 AICUT_DEV_REVIEW=1 …] npm run tauri dev
    void (async () => {
      if (devAutoOpened) return; // React StrictMode 會跑兩次 effect
      devAutoOpened = true;
      const p = await api.devEnv("AICUT_DEV_OPEN").catch(() => null);
      if (!p) return;
      await A.openMedia(p);
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
  //
  // `cancelled` 不是可有可無的防禦，是這裡的**正確性條件**：
  // installToolBridge 是非同步的，而 StrictMode 在 dev 會 mount → unmount → mount。
  // 第一次的 cleanup 跑在 promise 解決之前，那時 `un` 還是 undefined，於是**什麼都沒拆**；
  // 兩次註冊都留下來，之後每一個 MCP 工具呼叫都會被執行**兩次**。
  //
  // 冪等的工具看不出來（所以這個 bug 藏了很久），但 lift_selection 這種會「消耗」狀態的
  // 就會炸：第一次成功並清掉選取，第二次找不到選取而丟例外，兩個結果在 Rust 那邊搶同一個
  // oneshot —— 實測 claude 連續三次收到「目前沒有選取」，但靜音效果其實每次都做出來了。
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    installToolBridge()
      .then((f) => {
        if (cancelled) f(); // 已經卸載了：立刻拆掉，不要留下沒人管的監聽
        else un = f;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      un?.();
    };
  }, []);

  // 拖放音檔 / 專案檔。
  useEffect(() => {
    let un: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((ev) => {
        const ui = useUi.getState();
        if (ev.payload.type === "enter" || ev.payload.type === "over") {
          if (!ui.dragOver) ui.setDragOver(true);
          return;
        }
        ui.setDragOver(false);
        if (ev.payload.type !== "drop") return;
        for (const p of ev.payload.paths) {
          if (A.isAudioPath(p) || p.endsWith(".aicut.json")) void A.openMedia(p);
        }
      })
      .then((f) => {
        un = f;
      })
      .catch(() => {});
    return () => un?.();
  }, []);

  // 快捷鍵：絕大多數由指令註冊表派發；只有 JKL 與方向鍵手寫。簡易模式只放行 simple 指令。
  useEffect(() => installHotkeys({ shuttle: A.shuttle, nudge: A.nudge, simpleOnly: () => useUi.getState().mode === "simple" }), []);

  return (
    <div className="h-full flex flex-col">
      <AudioPlayer path={active?.path ?? null} />
      {mode === "simple" ? <SimpleShell /> : <ProShell />}
      <DialogHost />
      <UiHost />
    </div>
  );
}
