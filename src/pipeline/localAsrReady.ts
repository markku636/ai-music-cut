// 本機辨識裝好了沒 —— 分析與驗收共用同一道門。
//
// 沒裝的話 sidecar 會以結束碼 2 退出，使用者看到的是一則錯誤訊息，
// 而安裝面板在「設定 → 逐字稿」裡。第一次用的人按下去就撞牆，還得自己去找那個面板。
//
// 這件事有**兩個**入口：簡易模式的第一顆按鈕「自動剪掉贅字」（`analyze.ts`），
// 以及輸出完成之後的「用 ASR 驗收」（`verify.ts`）。v0.117 只修了前者，
// 後者照樣丟結束碼 —— 所以這道門搬到共用的地方，兩邊都走它。

import { api, type LocalAsrStatus } from "../api";

/**
 * 本機辨識還沒裝好。
 *
 * 這不是「失敗」，是「還沒準備好」—— 呼叫端要把工作標成取消而不是錯誤，
 * 檔案也不要留下錯誤狀態。
 */
export class LocalAsrNotReady extends Error {
  constructor(readonly status: LocalAsrStatus) {
    super("local-asr-not-ready");
    this.name = "LocalAsrNotReady";
  }
}

/**
 * 殼層注入「還沒裝好時要開什麼」。
 *
 * pipeline 這一層不直接認得 UI —— 直接 import 對話框的話，測試載這個檔就會把
 * 半個 App 拖進來，而且 pipeline 與 UI 的相依方向就反了。
 */
let handler: ((s: LocalAsrStatus) => void) | null = null;
export function setLocalAsrNotReadyHandler(fn: ((s: LocalAsrStatus) => void) | null): void {
  handler = fn;
}

/** 讓殼層知道「還沒裝好」發生了（把安裝面板打開）。 */
export function notifyLocalAsrNotReady(s: LocalAsrStatus): void {
  handler?.(s);
}

/**
 * 轉寫之前先問一次。偵測本身失敗（指令不在、逾時）時**不擋** ——
 * 寧可讓它往下跑、拿到真正的錯誤，也不要因為偵測壞掉就說「你沒裝」。
 */
export async function ensureLocalAsrReady(): Promise<void> {
  const st = await api.localAsrDetect().catch(() => null);
  if (st && (!st.python || !st.faster_whisper)) throw new LocalAsrNotReady(st);
}

/** 工作列要顯示的步驟與說明（分析與驗收共用同一句）。 */
export function localAsrNotReadyJob(s: LocalAsrStatus): { step: string; message: string } {
  return s.python
    ? { step: "還沒裝語音辨識", message: s.install_hint }
    : { step: "還沒裝 Python", message: "需要 Python 3.9 以上；App 不會替你裝 Python" };
}
