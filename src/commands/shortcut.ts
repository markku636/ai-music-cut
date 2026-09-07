/**
 * 快捷鍵的解析 / 比對 / 顯示。純函式，沒有 DOM 相依（KeyboardEvent 只用到幾個欄位）。
 *
 * 比對是**修飾鍵精確相等**：Shift+S 不會打到 S、Ctrl+Z 不會打到 Ctrl+Shift+Z。
 * 舊版 hotkeys.ts 用 `case "S"` 靠大小寫分辨 Shift，中文輸入法下 key 是 "Process"、
 * 從實體鍵推回來的一律是小寫，於是 Shift+S（滑聽）永遠不中。這裡改看 e.shiftKey。
 */

export interface Chord {
  /** 已正規化：字母小寫、"+" 視為 "="、Space 是 " "。 */
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

/** 中文輸入法開著時 keydown 的 key 是 "Process"，改由實體鍵 code 推回字元，讓字母快捷鍵照常運作。 */
const CODE_KEY: Record<string, string> = {
  Space: " ",
  Digit0: "0",
  Digit1: "1",
  Digit2: "2",
  Digit3: "3",
  Digit4: "4",
  Digit5: "5",
  Digit6: "6",
  Digit7: "7",
  Digit8: "8",
  Digit9: "9",
  Equal: "=",
  Minus: "-",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Escape: "Escape",
  Delete: "Delete",
  Backspace: "Backspace",
  Enter: "Enter",
  Tab: "Tab",
  Home: "Home",
  End: "End",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
};

type KeyLike = Pick<KeyboardEvent, "key" | "code" | "isComposing" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">;

export function effectiveKey(e: Pick<KeyboardEvent, "key" | "code" | "isComposing">): string {
  if (e.key !== "Process" && e.key !== "Unidentified" && !e.isComposing) return e.key;
  if (e.code.startsWith("Key") && e.code.length === 4) return e.code.slice(3).toLowerCase();
  return CODE_KEY[e.code] ?? e.key;
}

export function typingTarget(e: { target: EventTarget | null }): boolean {
  const el = e.target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!el.isContentEditable;
}

const KEY_ALIAS: Record<string, string> = {
  esc: "Escape",
  escape: "Escape",
  space: " ",
  del: "Delete",
  delete: "Delete",
  backspace: "Backspace",
  enter: "Enter",
  return: "Enter",
  tab: "Tab",
  home: "Home",
  end: "End",
  left: "ArrowLeft",
  right: "ArrowRight",
  up: "ArrowUp",
  down: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  plus: "=",
  "+": "=",
};

function normalizeKey(k: string): string {
  if (k === "+") return "=";
  if (k.length === 1) return k.toLowerCase();
  const alias = KEY_ALIAS[k.toLowerCase()];
  if (alias) return alias;
  // F1..F12 統一大寫 F
  if (/^f\d{1,2}$/i.test(k)) return k.toUpperCase();
  return k;
}

/** "Ctrl+Shift+Z" → Chord。修飾鍵不分大小寫；Cmd / Meta 視同 Ctrl（macOS）。 */
export function parseShortcut(s: string): Chord {
  const c: Chord = { key: "", ctrl: false, shift: false, alt: false };
  const parts = s.split("+").map((x) => x.trim());
  // "Ctrl++" 這種寫法會切出空字串：把它當成 "+"
  const tokens: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "" && i > 0 && i === parts.length - 1) tokens.push("+");
    else if (parts[i] !== "") tokens.push(parts[i]);
  }
  const keyTok = tokens.pop() ?? "";
  for (const m of tokens) {
    const l = m.toLowerCase();
    if (l === "ctrl" || l === "control" || l === "cmd" || l === "meta" || l === "command") c.ctrl = true;
    else if (l === "shift") c.shift = true;
    else if (l === "alt" || l === "option") c.alt = true;
  }
  c.key = normalizeKey(keyTok);
  return c;
}

export function chordOf(e: KeyLike): Chord {
  const raw = effectiveKey(e);
  return { key: normalizeKey(raw), ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey, alt: e.altKey };
}

export function sameChord(a: Chord, b: Chord): boolean {
  return a.key === b.key && a.ctrl === b.ctrl && a.shift === b.shift && a.alt === b.alt;
}

/** 當 Map 的鍵用。 */
export function chordKey(c: Chord): string {
  return `${c.ctrl ? "C-" : ""}${c.alt ? "A-" : ""}${c.shift ? "S-" : ""}${c.key}`;
}

const DISPLAY: Record<string, string> = {
  " ": "Space",
  Escape: "Esc",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Delete: "Delete",
  Backspace: "Backspace",
  "=": "=",
};

/** 顯示用："ctrl+shift+z" → "Ctrl+Shift+Z"。 */
export function formatShortcut(s: string): string {
  const c = parseShortcut(s);
  const parts: string[] = [];
  if (c.ctrl) parts.push("Ctrl");
  if (c.alt) parts.push("Alt");
  if (c.shift) parts.push("Shift");
  const k = DISPLAY[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key);
  parts.push(k);
  return parts.join("+");
}
