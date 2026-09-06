import { seekBy, togglePlay } from "./preview/playerRef";

export interface HotkeyHandlers {
  openMedia: () => void;
  save: () => void;
  help: () => void;
  /** 下列在 M3+ 才接上；未提供則忽略。 */
  prevCandidate?: () => void;
  nextCandidate?: () => void;
  accept?: () => void;
  reject?: () => void;
  deleteSelection?: () => void;
  previewCandidate?: () => void;
  undo?: () => void;
  redo?: () => void;
  zoomIn?: () => void;
  zoomOut?: () => void;
  zoomFit?: () => void;
  home?: () => void;
  end?: () => void;
  /** 時間軸工具：V 定位、S 選取、T 修剪；Esc 清除選取。 */
  toolSeek?: () => void;
  toolSelect?: () => void;
  toolTrim?: () => void;
  /** B：在播放線切一刀（刀片）。 */
  blade?: () => void;
  /** N：吸附開關。 */
  toggleSnap?: () => void;
  /** Shift+Delete：提起（留白靜音，不關洞）。 */
  liftSelection?: () => void;
  /** J / K / L 轉盤。slow = 按住 K 的時候點的（0.5x）。 */
  shuttle?: (key: "J" | "K" | "L", opts: { slow: boolean }) => void;
  /** I / O 標入點 / 出點；Shift 版是跳到那裡。 */
  markIn?: () => void;
  markOut?: () => void;
  gotoIn?: () => void;
  gotoOut?: () => void;
  /** Alt+← / →：微調播放線（Shift 再細一級）。 */
  nudge?: (ms: number) => void;
  /** M：下標記；Shift+M：下章節（會寫進成品檔案）。 */
  addMarker?: (chapter: boolean) => void;
  /** Alt+[ / Alt+]：上 / 下一個標記。 */
  stepMarker?: (dir: 1 | -1) => void;
  escape?: () => void;
  /** Space：由 App 決定播選取或播放 / 暫停；未提供則播放 / 暫停。 */
  space?: () => void;
  zoomSelection?: () => void;
  selectAll?: () => void;
  /** Ctrl+F：在逐字稿裡找字（找到之後可以整集一次剪掉）。 */
  findText?: () => void;
}

/** 中文輸入法開著時 keydown 的 key 是 "Process"，改由實體鍵 code 推回字元，讓字母快捷鍵照常運作。 */
const CODE_KEY: Record<string, string> = {
  Space: " ",
  Digit0: "0",
  Equal: "=",
  Minus: "-",
  BracketLeft: "[",
  BracketRight: "]",
  Escape: "Escape",
  Delete: "Delete",
  Backspace: "Backspace",
  Home: "Home",
  End: "End",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
};
function effectiveKey(e: KeyboardEvent): string {
  if (e.key !== "Process" && e.key !== "Unidentified" && !e.isComposing) return e.key;
  if (e.code.startsWith("Key") && e.code.length === 4) return e.code.slice(3).toLowerCase();
  return CODE_KEY[e.code] ?? e.key;
}

function typingTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/** 全域鍵盤快捷鍵。對話框開啟（body.dataset.modalCount）或焦點在輸入框時讓路。 */
export function installHotkeys(h: HotkeyHandlers): () => void {
  // 按住 K 再點 J / L 是慢速 —— 需要知道 K 現在有沒有被壓著
  let kHeld = false;
  const onKeyUp = (e: KeyboardEvent) => {
    if (effectiveKey(e).toLowerCase() === "k") kHeld = false;
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "F1") {
      e.preventDefault();
      h.help();
      return;
    }
    if (document.body.dataset.modalCount) return;
    if (typingTarget(e)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = effectiveKey(e);
    if (k.toLowerCase() === "k" && !ctrl) kHeld = true;
    if (ctrl) {
      switch (k.toLowerCase()) {
        case "o":
          e.preventDefault();
          h.openMedia();
          return;
        case "s":
          e.preventDefault();
          h.save();
          return;
        case "z":
          e.preventDefault();
          if (e.shiftKey) h.redo?.();
          else h.undo?.();
          return;
        case "y":
          e.preventDefault();
          h.redo?.();
          return;
        case "=":
        case "+":
          e.preventDefault();
          h.zoomIn?.();
          return;
        case "-":
          e.preventDefault();
          h.zoomOut?.();
          return;
        case "0":
          e.preventDefault();
          h.zoomFit?.();
          return;
        case "a":
          e.preventDefault();
          h.selectAll?.();
          return;
        case "f":
          e.preventDefault();
          h.findText?.();
          return;
        default:
          return;
      }
    }
    switch (k) {
      case "Home":
        e.preventDefault();
        h.home?.();
        return;
      case "End":
        e.preventDefault();
        h.end?.();
        return;
      case "Escape":
        h.escape?.();
        return;
      case "x":
      case "X":
        // Alt+X：清掉入出點（跟 Esc 一樣，但不會關掉右鍵選單之類的東西）
        if (e.altKey) h.escape?.();
        return;
      case "v":
      case "V":
        h.toolSeek?.();
        return;
      case "s":
      case "S":
        h.toolSelect?.();
        return;
      case "t":
      case "T":
        h.toolTrim?.();
        return;
      case "b":
      case "B":
        h.blade?.();
        return;
      case "n":
      case "N":
        h.toggleSnap?.();
        return;
      case " ":
        e.preventDefault();
        if (h.space) h.space();
        else togglePlay();
        return;
      case "z":
      case "Z":
        h.zoomSelection?.();
        return;
      // 轉盤：按住不放不會一直加速（剪輯軟體的 JKL 是「點一下走一格」）
      case "j":
      case "J":
      case "k":
      case "K":
      case "l":
      case "L":
        if (e.repeat) return;
        h.shuttle?.(k.toUpperCase() as "J" | "K" | "L", { slow: kHeld && k.toLowerCase() !== "k" });
        return;
      case "i":
      case "I":
        if (e.shiftKey) h.gotoIn?.();
        else h.markIn?.();
        return;
      case "o":
      case "O":
        if (e.shiftKey) h.gotoOut?.();
        else h.markOut?.();
        return;
      case "ArrowLeft":
        e.preventDefault();
        // Alt = 微調（Shift 再細一級）；否則維持原本的 ∓1 / ∓5 秒
        if (e.altKey) h.nudge?.(e.shiftKey ? -1 : -10);
        else seekBy(e.shiftKey ? -5000 : -1000);
        return;
      case "ArrowRight":
        e.preventDefault();
        if (e.altKey) h.nudge?.(e.shiftKey ? 1 : 10);
        else seekBy(e.shiftKey ? 5000 : 1000);
        return;
      case "[":
        if (e.altKey) h.stepMarker?.(-1);
        else h.prevCandidate?.();
        return;
      case "]":
        if (e.altKey) h.stepMarker?.(1);
        else h.nextCandidate?.();
        return;
      case "m":
      case "M":
        h.addMarker?.(e.shiftKey);
        return;
      case "a":
      case "A":
        h.accept?.();
        return;
      case "r":
      case "R":
        h.reject?.();
        return;
      case "Delete":
      case "Backspace":
        // Shift = 提起（不關洞，只靜音），與剪掉的差別是後面整串不會往前跑
        if (e.shiftKey) h.liftSelection?.();
        else h.deleteSelection?.();
        return;
      case "p":
      case "P":
        h.previewCandidate?.();
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
