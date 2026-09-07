import { t } from "../i18n";
import { useDecisions } from "../store/decisions";
import { toast } from "../ui";

/**
 * 做一件會改剪輯的事，然後 toast 一句話 + 一顆「復原」。
 *
 * 小白不知道 Ctrl+Z；每個破壞性的動作後面都跟一顆復原鈕，做錯了立刻按得到。
 * 復原時要確認歷史頂端還是自己這一筆 —— 之後又做了別的事，按下去只會退最後一步，
 * 那不是使用者以為的那一筆，所以改成提示他用「復原」一步一步退。
 */
export async function withUndoToast(text: string, apply: () => void | Promise<void>, undo?: () => void): Promise<void> {
  const before = useDecisions.getState().past.length;
  await apply();
  const after = useDecisions.getState().past.length;
  if (undo) {
    toast.undo(text, undo);
    return;
  }
  if (after <= before) return; // 沒有留下歷史（什麼都沒做），不要給一顆會誤傷別的操作的復原鈕
  toast.undo(text, () => {
    const d = useDecisions.getState();
    if (d.past.length === after) d.undo();
    else toast.info(t("後面還有別的修改，請用「復原」一步一步退回"));
  });
}
