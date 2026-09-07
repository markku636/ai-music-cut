import { seekBy } from "./preview/playerRef";
import { allCommands, runCommandObject, useCommands } from "./commands/registry";
import { chordKey, chordOf, effectiveKey, parseShortcut, typingTarget } from "./commands/shortcut";
import type { Command } from "./commands/types";

export interface HotkeyHandlers {
  /** J / K / L 轉盤。slow = 按住 K 的時候點的（0.5x）。 */
  shuttle: (key: "J" | "K" | "L", opts: { slow: boolean }) => void;
  /** Alt+← / →：微調播放線（Shift 再細一級）。 */
  nudge: (ms: number) => void;
  /** 簡易模式下只放行 cmd.simple 的指令；回 null 表示不限制。 */
  simpleOnly?: () => boolean;
}

/**
 * 全域鍵盤快捷鍵。
 *
 * 絕大多數鍵由指令註冊表派發（core.ts 的 `shortcuts`）：這裡只剩三種手寫的 ——
 * J/K/L（要記住 K 有沒有被按住、要忽略 auto-repeat）、方向鍵（auto-repeat 就是要的：按住捲動）、
 * 以及 `global` 指令（F1、Ctrl+K）要在「對話框開著就讓路」的檢查**之前**處理。
 *
 * 對話框開啟（body.dataset.modalCount）或焦點在輸入框時讓路。
 */
export function installHotkeys(h: HotkeyHandlers): () => void {
  // chord → 指令。註冊表一變就重建（version 變了才重建，不是每次按鍵）
  let map = new Map<string, Command>();
  let builtAt = -1;
  const ensureMap = () => {
    const v = useCommands.getState().version;
    if (v === builtAt) return;
    builtAt = v;
    map = new Map();
    for (const c of allCommands()) {
      if (c.shortcutManual) continue;
      for (const s of c.shortcuts ?? []) map.set(chordKey(parseShortcut(s)), c);
    }
  };

  // 按住 K 再點 J / L 是慢速 —— 需要知道 K 現在有沒有被壓著
  let kHeld = false;
  const onKeyUp = (e: KeyboardEvent) => {
    if (effectiveKey(e).toLowerCase() === "k") kHeld = false;
  };
  const onKey = (e: KeyboardEvent) => {
    ensureMap();
    const cmd = map.get(chordKey(chordOf(e)));
    if (cmd?.global) {
      e.preventDefault();
      void runCommandObject(cmd, "hotkey");
      return;
    }
    if (document.body.dataset.modalCount) return;
    if (typingTarget(e)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = effectiveKey(e);
    if (k.toLowerCase() === "k" && !ctrl && !e.altKey) kHeld = true;
    if (cmd) {
      if (h.simpleOnly?.() && !cmd.simple) return;
      e.preventDefault();
      void runCommandObject(cmd, "hotkey");
      return;
    }
    if (ctrl) return;
    switch (k) {
      // 轉盤：按住不放不會一直加速（剪輯軟體的 JKL 是「點一下走一格」）
      case "j":
      case "J":
      case "k":
      case "K":
      case "l":
      case "L":
        if (e.repeat || e.altKey) return;
        if (h.simpleOnly?.()) return;
        h.shuttle(k.toUpperCase() as "J" | "K" | "L", { slow: kHeld && k.toLowerCase() !== "k" });
        return;
      case "ArrowLeft":
        e.preventDefault();
        // Alt = 微調（Shift 再細一級）；否則維持原本的 ∓1 / ∓5 秒
        if (e.altKey) h.nudge(e.shiftKey ? -1 : -10);
        else seekBy(e.shiftKey ? -5000 : -1000);
        return;
      case "ArrowRight":
        e.preventDefault();
        if (e.altKey) h.nudge(e.shiftKey ? 1 : 10);
        else seekBy(e.shiftKey ? 5000 : 1000);
        return;
      default:
        return;
    }
  };
  window.addEventListener("keydown", onKey);
  window.addEventListener("keyup", onKeyUp);
  // 失焦時 keyup 收不到，K 會永遠卡在「按住」→ 之後每次 J / L 都變慢速
  const onBlur = () => {
    kHeld = false;
  };
  window.addEventListener("blur", onBlur);
  return () => {
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("blur", onBlur);
  };
}
