// 麥克風打不開時要說人話。
//
// `getUserMedia` 失敗時丟的是 `DOMException`，`name` 是 W3C 定好的那幾個。
// 直接把它印出來的話，第一次用「重錄這句」的人看到的是
// `NotAllowedError: Permission denied` —— 那句話沒有告訴他要做什麼。
//
// 每一種都對應到一個**具體的下一步**：去哪裡開權限、插上麥克風、關掉佔用它的程式。
// 認不出來的回 `unknown`，呼叫端就退回原始訊息 —— 不要把不認識的錯誤吞成一句
// 籠統的話，那會讓真正的問題查不出來。
//
// 訊息本身放在 UI 那一層寫成字面字串：check-i18n 只掃得到字面的翻譯呼叫，
// 寫在這裡的話三個語系會靜靜地少掉這幾句。

/** 這幾個名字是 W3C `getUserMedia` 定義的，不是自己編的。 */
export type MicErrorKind = "denied" | "notFound" | "busy" | "unsupported" | "unknown";

export function micErrorKind(e: unknown): MicErrorKind {
  const name = typeof e === "object" && e !== null && "name" in e ? String((e as { name: unknown }).name) : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "OverconstrainedError":
      return "notFound";
    case "NotReadableError":
    case "AbortError":
      return "busy";
    case "TypeError":
      return "unsupported";
    default:
      return "unknown";
  }
}
