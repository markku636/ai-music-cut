import { create } from "zustand";
import { EMPTY_MIX, pruneMix, toggleMute, toggleSolo, type RoleMix } from "../preview/roleMix";

/**
 * 角色的獨奏 / 靜音（監聽用）。
 *
 * **刻意不進專案檔、不進 undo**：把「我剛剛在檢查音樂壓不壓過人聲」存成專案狀態，
 * 下次打開會變成一個很難查的「怎麼沒聲音」。它跟音量滑桿一樣是監聽用的，
 * 每次開檔都從全開始。
 */
interface RoleMixStore {
  mix: RoleMix;
  toggleMute: (role: string) => void;
  toggleSolo: (role: string) => void;
  reset: () => void;
  /** 丟掉已經不存在的角色（overlay 被刪掉時呼叫）。 */
  prune: (known: string[]) => void;
}

export const useRoleMix = create<RoleMixStore>((set, get) => ({
  mix: EMPTY_MIX,
  toggleMute: (role) => set({ mix: toggleMute(get().mix, role) }),
  toggleSolo: (role) => set({ mix: toggleSolo(get().mix, role) }),
  reset: () => set({ mix: EMPTY_MIX }),
  prune: (known) => {
    const next = pruneMix(get().mix, known);
    if (next !== get().mix) set({ mix: next });
  },
}));
