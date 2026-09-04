import { create } from "zustand";

const OPEN_KEY = "aicut:assistantOpen";

interface AssistantUiStore {
  open: boolean;
  toggle: () => void;
  setOpen: (v: boolean) => void;
}

/** AI 助手面板的開合狀態（聊天內容在 assistant/ 模組自己的 store）。 */
export const useAssistant = create<AssistantUiStore>((set, get) => ({
  open: (() => {
    try {
      return localStorage.getItem(OPEN_KEY) === "1";
    } catch {
      return false;
    }
  })(),
  toggle: () => get().setOpen(!get().open),
  setOpen: (v) => {
    try {
      localStorage.setItem(OPEN_KEY, v ? "1" : "0");
    } catch {
      /* ignore */
    }
    set({ open: v });
  },
}));
