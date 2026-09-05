// 共卡自救：50.57 那張卡同時給 TTS 聲音池、ACE-Step 音樂、faster-whisper 用，
// 誰先佔滿誰贏 → 轉寫常被 WhisperNoVram 擋下。伺服器有 /v1/gpu/release 可以停音樂服務讓位，
// 這裡把「偵測到顯存不足 → 自動釋放 → 重試一次」包成一個 helper，UI 只要照常呼叫就好。
import { api, errMessage } from "../api";
import { t } from "../i18n";
import { toast } from "../ui";

/** 這個錯誤是不是「顯存不夠」造成的。 */
export function isVramError(e: unknown): boolean {
  const s = errMessage(e);
  return /WhisperNoVram|顯存|視訊記憶體|out of memory|OutOfMemoryError|VRAM/i.test(s);
}

/**
 * 跑 fn；若因顯存不足失敗，呼叫 /v1/gpu/release 停掉音樂服務後重試一次。
 * onNote 用來把「正在釋放記憶體」寫進工作列的步驟文字。
 */
export async function withVramRetry<T>(fn: () => Promise<T>, onNote?: (msg: string) => void): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isVramError(e)) throw e;
    onNote?.(t("GPU 顯存不足，正在請伺服器釋放…"));
    let freed = 0;
    try {
      const r = await api.ttlsGpuRelease("stop");
      freed = Math.round(r.freed_mb);
    } catch (releaseErr) {
      // 釋放本身失敗 → 把原始錯誤丟回去（更有用）
      void releaseErr;
      throw e;
    }
    if (freed <= 0) throw e;
    toast.info(t("已釋放 {mb} MB 顯存（暫停音樂服務），重試中…", { mb: freed }));
    onNote?.(t("已釋放 {mb} MB，重試中…", { mb: freed }));
    return fn();
  }
}
