import { seekBy, togglePlay } from "./preview/playerRef";
import { usePlayback } from "./store/playback";

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
  /** 時間軸工具：V 定位、S 選取；Esc 清除選取。 */
  toolSeek?: () => void;
  toolSelect?: () => void;
  escape?: () => void;
  /** Space：由 App 決定播選取或播放 / 暫停；未提供則播放 / 暫停。 */
  space?: () => void;
  zoomSelection?: () => void;
  selectAll?: () => void;
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

const RATES = [1, 1.25, 1.5, 2];

/** 全域鍵盤快捷鍵。對話框開啟（body.dataset.modalCount）或焦點在輸入框時讓路。 */
export function installHotkeys(h: HotkeyHandlers): () => void {
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
      case "v":
      case "V":
        h.toolSeek?.();
        return;
      case "s":
      case "S":
        h.toolSelect?.();
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
      case "j":
      case "J":
        seekBy(e.repeat ? -15000 : -5000);
        return;
      case "k":
      case "K":
        if (usePlayback.getState().playing) togglePlay();
        return;
      case "l":
      case "L": {
        const pb = usePlayback.getState();
        if (!pb.playing) togglePlay();
        else pb.setRate(RATES[(RATES.indexOf(pb.rate) + 1) % RATES.length] ?? 1);
        return;
      }
      case "ArrowLeft":
        e.preventDefault();
        seekBy(e.shiftKey ? -5000 : -1000);
        return;
      case "ArrowRight":
        e.preventDefault();
        seekBy(e.shiftKey ? 5000 : 1000);
        return;
      case "[":
        h.prevCandidate?.();
        return;
      case "]":
        h.nextCandidate?.();
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
        h.deleteSelection?.();
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
  return () => window.removeEventListener("keydown", onKey);
}
