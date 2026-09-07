import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { applyDocLang, readStoredLang, t, useLang } from "./i18n";
import { applyDensity, useUi } from "./store/ui";
import { invoke } from "@tauri-apps/api/core";

// 前端錯誤回報到 Rust stderr（tauri dev 終端看得到；非 Tauri 環境靜默）。
const report = (msg: string) => {
  try {
    void invoke("client_log", { msg }).catch(() => {});
  } catch {
    /* 非 Tauri 環境 */
  }
};
window.addEventListener("error", (e) => report(`[error] ${e.message} @${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => report(`[unhandledrejection] ${String((e as PromiseRejectionEvent).reason)}`));
// 自我托管字體（離線內嵌，不連 CDN）：Inter 作介面字、JetBrains Mono 作資料 / SQL 等寬字。
// 只內嵌 latin / latin-ext 子集（fonts.css），取代裸 import 的全語系 14 檔。
import "./fonts.css";
import "./styles.css";

// 全域錯誤邊界：任一渲染錯誤時顯示友善訊息與重載鈕，避免整頁白屏。
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="h-full flex items-center justify-center p-6">
          <div className="max-w-lg w-full bg-elevated border border-fg/10 rounded-lg p-6 space-y-3">
            <div className="text-red-300 font-medium">{t("發生未預期的錯誤")}</div>
            <pre className="text-xs text-fg/60 mono whitespace-pre-wrap break-all max-h-60 overflow-auto bg-inset rounded p-3">
              {this.state.error.message}
            </pre>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => this.setState({ error: null })}
                className="px-3 py-1.5 text-sm rounded border border-fg/15 hover:bg-fg/5"
              >
                {t("嘗試繼續")}
              </button>
              <button
                type="button"
                onClick={() => location.reload()}
                className="px-3 py-1.5 text-sm rounded bg-accent text-white hover:bg-accent/90"
              >
                {t("重新載入")}
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * React root 綁在 `globalThis` 上重用，**不是每次都 createRoot**。
 *
 * 熱更新時 Vite 會把整個 `main.tsx` 重跑一遍（只要失效傳播到進入點就會）。原本每跑一次
 * 就對同一個 `#root` 建一個新的 root —— React 不會取代舊的那棵，而是**再掛一棵上去**。
 * 於是改幾次程式碼之後畫面上其實疊了四份 App：四份 keydown listener（按一次鍵觸發四次）、
 * 四個 <audio>、四份 ticker 訂閱。看起來只是「怪怪的」，查起來會查很久。
 *
 * 正式打包只跑一次，所以這純粹是開發期的坑 —— 但它會讓開發期量到的每一個數字都是四倍。
 */
declare global {
  var __aicutRoot: ReactDOM.Root | undefined;
}

const render = () => {
  const el = document.getElementById("root")!;
  globalThis.__aicutRoot ??= ReactDOM.createRoot(el);
  globalThis.__aicutRoot.render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
};

// 語言啟動：zh-TW 是原文，catalog 恆空 → 同步渲染，不多付一個 tick、也不會先閃一次中文。
// 其餘語言必須先把譯文表載進來（vite dynamic import chunk）才首次繪製，否則會看到中文閃一下。
// 載入失敗（chunk 壞掉 / 離線）就照 identity fallback 渲染中文，總比白屏好。
// 開發時掛上 window.__aicut 自動化橋接（正式打包 tree-shake 掉）
if (import.meta.env.DEV) {
  void import("./devBridge").then((m) => m.installDevBridge());
}

// 介面密度：在首次繪製前套用，避免字級閃一下
applyDensity(useUi.getState().density);

const startLang = readStoredLang();
applyDocLang(startLang);
if (startLang === "zh-TW") render();
else void useLang.getState().setLang(startLang).catch(() => {}).then(render);
