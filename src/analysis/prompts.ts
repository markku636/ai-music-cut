import { EDITOR_SYSTEM_PROMPT, REVIEWER_SYSTEM_PROMPT } from "./llm/prompt";

/**
 * 提示詞登錄：這個 App 送給 LLM 的每一段「人格設定」都在這裡列名。
 *
 * 為什麼要集中：原本五段提示詞寫死在四個不同的檔案裡（判讀、審核、節目筆記、助手、
 * 還有 Rust 的 MCP instructions）。想調一句話得先找到它在哪、改完還要重新編譯 ——
 * 而提示詞正是最需要反覆試的東西。**改不動的提示詞等於不能調的產品。**
 *
 * 設計上的三個決定：
 *
 * 1. **只存被改過的那幾條**（override），不是把全部存進設定檔。
 *    全存的話，之後改進了預設提示詞，舊使用者永遠拿不到新版本 ——
 *    他們的設定檔會把舊的凍在那裡，而且完全無感。
 * 2. **每一條都要說「誰在用」**。使用者要調的是行為，不是字串；
 *    不講清楚改了會影響哪一條流程，等於叫人盲改。
 * 3. **語言指示不放進提示詞本文**。那是執行期依節目 / 介面語言接上去的
 *    （見 `analysis/lang.ts`），寫進本文的話使用者一改就把多語系弄壞了。
 */

export type PromptId = "editor" | "reviewer" | "shownotes" | "assistant";

export interface PromptSpec {
  id: PromptId;
  /** 給人看的名字。 */
  label: string;
  /** 這條提示詞在哪一段流程生效。 */
  usedBy: string;
  /** 改壞了會怎樣 —— 讓人知道風險再動手。 */
  caution: string;
  /** 內建預設。 */
  default: string;
}

/** 節目筆記的系統提示（本體很短，語言指示是執行期接上去的）。 */
export const SHOWNOTES_SYSTEM_DEFAULT = "你是 podcast 製作人。只輸出符合 schema 的 JSON，不要加任何說明文字。";

/**
 * AI 助手的系統提示。
 *
 * 本來寫在 `store/assistantChat.ts`，搬過來是因為 store 不該是提示詞的家 ——
 * 放在那裡會逼出「用一個可變的 let 反向登記」這種寫法來避開循環 import。
 */
export const ASSISTANT_SYSTEM_DEFAULT = `你是 AI Podcast Cut（podcast 剪輯工具）內建的剪輯助手。使用者正在編輯一集錄音，畫面上有逐字稿、波形時間軸、「候選」清單（贅字 / 口吃 / 重講 / 長停頓 / 含糊 / 雜音），以及配樂 / 音效軌。
先看再動手：get_project_summary 看整體，list_candidates / get_transcript 看內容，list_seams 看已經剪出哪些接縫，list_overlays / list_media 看配樂。

你能做的事分四類：
· **決策**：set_decisions（接受 / 拒絕候選）、add_cut、set_aggressiveness。
· **剪輯手法**：blade_at 切一刀、trim_seam 修剪接縫（ripple 會改變成品長度、roll 不會）、insert_pause 在切點補呼吸、set_selection + lift_selection（提起＝靜音但不關洞）、add_effect。
· **標記與章節**：add_marker、set_chapters（章節會寫進成品檔案，標題要具體、≤ 14 字）。
· **配樂**：place_overlay 放配樂 / 音效（位置用**成品時間**）、duck_overlay 讓它在人聲下自動閃避、update_overlay 調音量與長度。多軌錄音用 sync_mics 對齊。

原則：
1. 自然順暢為最高原則——不是把贅字全剪掉。句首的「然後 / 那 / 好」常是節奏，重複只留最後一次，講到一半重講就剪前一次。
2. unclear / rambling / off_topic / redo 這類語意判斷，除非使用者明確要求，否則設為 pending 讓使用者決定，並說明理由。
3. 使用者手動決定過的候選（origin=user）不要覆寫，除非使用者明說。
4. **要拿掉雜音但保留節奏就用 lift_selection（提起），不要用 add_cut** —— 剪掉會讓後面整串往前跑，配樂與影片對點就歪了。
5. afterKeepId **只在下一次修剪前有效**（保留段會重新編號），連續修剪請每一步重新呼叫 list_seams。
6. 每次動手後用一兩句話總結改了什麼（幾筆、剪掉幾秒）；不確定就先問。
7. 回覆用繁體中文、精簡；時間用 mm:ss。`;

export function promptSpecs(): PromptSpec[] {
  return [
    {
      id: "editor",
      label: "剪輯師（AI 判讀）",
      usedBy: "AI 判讀的第一輪：逐段看候選，決定剪 / 建議 / 不剪。",
      caution: "改鬆了會剪掉不該剪的內容；改緊了 AI 判讀等於沒作用。",
      default: EDITOR_SYSTEM_PROMPT,
    },
    {
      id: "reviewer",
      label: "審核（第二雙耳朵）",
      usedBy: "AI 判讀的第二輪：只挑出「剪了會壞」的那幾筆推翻，其餘放行。",
      caution: "審核的職責是**只找剪壞的**。要它一起提新的剪點，兩個角色就沒有互相制衡了。",
      default: REVIEWER_SYSTEM_PROMPT,
    },
    {
      id: "shownotes",
      label: "節目筆記",
      usedBy: "節目筆記：摘要、章節、節錄、關鍵字。",
      caution: "必須維持「只輸出符合 schema 的 JSON」，否則解析會失敗。輸出語言不要寫死在這裡 —— 那是跟著節目語言自動接上去的。",
      default: SHOWNOTES_SYSTEM_DEFAULT,
    },
    {
      id: "assistant",
      label: "AI 助手",
      usedBy: "側邊的對話助手：用自然語言指揮剪輯（走 MCP 工具迴圈）。",
      caution: "工具清單與用法寫在這裡。刪掉某段說明不會讓工具消失，只會讓助手不知道有那個工具可用。",
      default: ASSISTANT_SYSTEM_DEFAULT,
    },
  ];
}

/** 取某一條提示詞的預設值。 */
export function promptDefault(id: PromptId): string {
  return promptSpecs().find((p) => p.id === id)?.default ?? "";
}

/**
 * 目前實際會送出去的那一份：使用者改過就用他的，否則用預設。
 *
 * 空字串（含只有空白）視同沒改 —— 把提示詞清空多半是誤刪，
 * 真的送一份空的系統提示出去，模型會退回它自己的通用人格，行為會突然變得很陌生。
 */
export function resolvePrompt(id: PromptId, overrides?: Record<string, string>): string {
  const map = overrides ?? readOverrides();
  const v = map[id];
  return v && v.trim() ? v : promptDefault(id);
}

/** 這一條有沒有被改過（UI 標「已修改」用）。 */
export function isOverridden(id: PromptId, overrides?: Record<string, string>): boolean {
  const v = (overrides ?? readOverrides())[id];
  return !!v && v.trim() !== "" && v !== promptDefault(id);
}

/**
 * 目前生效的覆寫表。
 *
 * 由設定 store 在載入與存檔時單向推進來（`setPromptOverrides`），這支模組**不反向去讀設定** ——
 * 提示詞的解析是純函式，測試不必為了測一句字串就把 Tauri 的設定層拖進來。
 */
let overridesNow: Record<string, string> = {};

/** 設定載入 / 變更時呼叫。 */
export function setPromptOverrides(m: Record<string, string> | null | undefined): void {
  overridesNow = m ?? {};
}

export function promptOverrides(): Record<string, string> {
  return overridesNow;
}

function readOverrides(): Record<string, string> {
  return overridesNow;
}
