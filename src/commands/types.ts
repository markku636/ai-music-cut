import type { LucideIcon } from "lucide-react";

/**
 * 指令註冊表的資料型別。
 *
 * 一個「使用者做得到的動作」只寫一次：工具列、右鍵、命令面板、快捷鍵說明、
 * 簡易模式面板都從同一張表長出來。之前是 22 個 boolean + 41 個 props + 一份手寫的
 * 快捷鍵表，每加一個功能要改五個地方，而且五個地方會慢慢對不上。
 */

export type CommandGroup = "file" | "edit" | "select" | "playback" | "effect" | "repair" | "tool" | "ai" | "view" | "help";

/** 能不能做；不能的話為什麼（zh key，畫面上會 t() 過）。 */
export type Enabled = { ok: true } | { ok: false; why: string };

/** 指令會出現在哪些表面。預設 ["menu", "palette"]。 */
export type Surface = "menu" | "palette" | "context" | "toolbar" | "simple";

export interface Command {
  /** 穩定 id，像 "file.open"、"repair.cleanup.quick"。 */
  id: string;
  /** 標題（zh key；顯示時 t(title, titleParams)）。 */
  title: string;
  titleParams?: Readonly<Record<string, string | number>>;
  group: CommandGroup;
  icon?: LucideIcon;
  /** 第一個用來顯示，全部都會比對。寫法："Ctrl+O"、"Shift+Delete"、"F1"、"Space"、"Alt+Shift+]"。 */
  shortcuts?: string[];
  /** 只列在說明裡、由手寫程式派發（JKL、方向鍵）。註冊表不會替它觸發。 */
  shortcutManual?: boolean;
  /** 對話框開著也要能按（F1、Ctrl+K）。 */
  global?: boolean;
  /** 命令面板的額外別名（"denoise"、"noise"…）。 */
  keywords?: string[];
  /** 選單分段；不同 section 之間畫分隔線。 */
  section?: string;
  order?: number;
  /** 「建議值」/「…開對話框」成對慣例：同一個 pairId，quick 排在 dialog 前面。 */
  pairId?: string;
  variant?: "quick" | "dialog";
  surfaces?: Surface[];
  /** 簡易模式看得到嗎（面板 / 右鍵 / 快捷鍵）。 */
  simple?: boolean;
  /** 簡易模式的白話標籤與一句說明（沒有就退回 title）。 */
  simpleLabel?: string;
  simpleHint?: string;
  /** 簡易面板的格位（1..8）；沒有的話不會出現在面板上。 */
  simpleOrder?: number;
  /** 勾選狀態（檢視選單的開關）。 */
  checked?: () => boolean;
  /** 工具列小圓點（未儲存）。 */
  badge?: () => boolean;
  /** 動態子選單（最近開啟）。 */
  children?: () => Command[];
  enabled: () => Enabled;
  run: () => void | Promise<void>;
}

export type RunSource = Surface | "hotkey" | "bridge" | "startcard";
