// 審核模式的鍵盤層。刻意獨立於全域 hotkeys.ts：進審核模式時字母鍵的意思不一樣
// （A/R 是「決定並前進」而不是「決定」），而且要能整組操作。
//
// 兩個一定要沿用的細節：
//  1. effectiveKey —— 中文輸入法開著時 keydown 的 e.key 是 "Process"，
//     不從 e.code 還原的話「按 A 沒反應」，而且只有中文使用者會遇到。
//  2. 不能用 ui/Modal 包 —— 那個會把 body.dataset.modalCount 加一，全域鍵會全部讓路。
//     審核模式是「一個工作模式」不是「一個對話框」。

/** 與 hotkeys.ts 同一套：輸入法組字中時從實體鍵碼還原字元。 */
const CODE_KEY: Record<string, string> = {
  Space: " ",
  Escape: "Escape",
  Enter: "Enter",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
};

export function effectiveKey(e: KeyboardEvent): string {
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

export interface ReviewActions {
  /** 接受並前進。 */
  accept: () => void;
  /** 拒絕並前進。 */
  reject: () => void;
  /** 整組其餘未決一起接受 / 拒絕（Shift+A / Shift+R）。 */
  acceptGroup: () => void;
  rejectGroup: () => void;
  next: () => void;
  prev: () => void;
  /** 重播剪後（Space）／播原始（Shift+Space）。 */
  playCut: () => void;
  playSrc: () => void;
  /** 復原上一筆決定（U）。 */
  undo: () => void;
  /** 切換群組總覽（G）。 */
  toggleGroups: () => void;
  /** 離開審核模式。 */
  exit: () => void;
}

/** 掛上審核模式的鍵盤層；回傳解除函式。 */
export function installReviewHotkeys(a: ReviewActions): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (typingTarget(e)) return;
    // 對話框（設定 / 輸出）蓋在上面時讓路
    if (document.body.dataset.modalCount) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = effectiveKey(e).toLowerCase();
    const shift = e.shiftKey;
    const run = ((): (() => void) | null => {
      switch (k) {
        case "a":
          return shift ? a.acceptGroup : a.accept;
        case "r":
          return shift ? a.rejectGroup : a.reject;
        case "j":
        case "arrowdown":
          return a.next;
        case "k":
        case "arrowup":
          return a.prev;
        case " ":
          return shift ? a.playSrc : a.playCut;
        case "u":
          return a.undo;
        case "g":
          return a.toggleGroups;
        case "escape":
          return a.exit;
        default:
          return null;
      }
    })();
    if (!run) return;
    e.preventDefault();
    // 一定要擋下來：全域 hotkeys.ts 也掛在 window 上，Space 會被它當成「播放 / 暫停」，
    // A / R 會被當成「決定但不前進」，變成一次按鍵做兩件事。
    e.stopPropagation();
    run();
  };
  // capture：比全域 hotkeys.ts（bubble）先拿到
  window.addEventListener("keydown", onKey, true);
  return () => window.removeEventListener("keydown", onKey, true);
}
