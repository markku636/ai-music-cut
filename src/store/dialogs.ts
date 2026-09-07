import { create } from "zustand";
import type { ReelRange } from "../analysis/reel";

/**
 * 對話框開合狀態。不持久化、不進 undo、不進專案檔 —— 關掉 App 就沒了。
 *
 * 以前是 App.tsx 裡 22 個 useState boolean 加上 Toolbar 的 41 個 props：
 * 每個對話框都要在三個地方登記（state、開啟 callback、JSX）。
 * 這裡改成「id + props 的堆疊」，開對話框的人（指令、按鈕、別的對話框）只要 `open("cleanup")`，
 * 掛載交給 DialogHost。
 */

export type SettingsFocus = "key" | "ffmpeg" | null;

export type DialogId =
  | "settings"
  | "about"
  | "shortcuts"
  | "palette"
  | "render"
  | "verify"
  | "separate"
  | "sync"
  | "highlight"
  | "music"
  | "prompts"
  | "fillers"
  | "takes"
  | "templates"
  | "speakers"
  | "captions"
  | "splitExport"
  | "bundle"
  | "batch"
  | "autoCut"
  | "showNotes"
  | "cleanup"
  | "highlights"
  | "style"
  | "effect"
  | "introOutro"
  | "convert"
  | "merge";

/** 有參數的對話框；沒列在這裡的就是沒有參數。 */
export interface DialogPropMap {
  settings: { focus?: SettingsFocus };
  convert: { paths?: string[] };
  render: { range?: { startMs: number; endMs: number } | null; reel?: ReelRange[] | null; reelBed?: string | null };
  verify: { outPath: string | null; outDurationMs: number | null };
  style: { startMs: number; endMs: number };
  effect: { specId: string; initial?: Record<string, number | string | boolean>; range?: { startMs: number; endMs: number } | null };
  palette: { query?: string };
}

export type DialogProps<K extends DialogId> = K extends keyof DialogPropMap ? DialogPropMap[K] : Record<string, never>;

export interface DialogEntry {
  id: DialogId;
  props: Record<string, unknown>;
  /** 每次 open 都遞增：重開 = 重新掛載（狀態歸零），和以前 `{open && <X/>}` 的行為一樣。 */
  key: number;
}

interface DialogsStore {
  stack: DialogEntry[];
  open: <K extends DialogId>(id: K, props?: DialogProps<K>) => void;
  close: (id: DialogId) => void;
  closeTop: () => void;
  closeAll: () => void;
  isOpen: (id: DialogId) => boolean;
}

let seq = 1;

export const useDialogs = create<DialogsStore>((set, get) => ({
  stack: [],
  open: (id, props) => {
    set((s) => {
      const rest = s.stack.filter((e) => e.id !== id);
      const prev = s.stack.find((e) => e.id === id);
      // 已經開著：換 props、移到最上層，但保留 key（不重掛，使用者填一半的東西不會消失）
      const entry: DialogEntry = { id, props: (props ?? {}) as Record<string, unknown>, key: prev ? prev.key : seq++ };
      return { stack: [...rest, entry] };
    });
  },
  close: (id) => set((s) => (s.stack.some((e) => e.id === id) ? { stack: s.stack.filter((e) => e.id !== id) } : s)),
  closeTop: () => set((s) => ({ stack: s.stack.slice(0, -1) })),
  closeAll: () => set({ stack: [] }),
  isOpen: (id) => get().stack.some((e) => e.id === id),
}));

/** 給指令 / 非 React 程式碼用的捷徑。 */
export function openDialog<K extends DialogId>(id: K, props?: DialogProps<K>): void {
  useDialogs.getState().open(id, props);
}

export function closeDialog(id: DialogId): void {
  useDialogs.getState().close(id);
}
