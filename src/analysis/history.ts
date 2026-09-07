// 歷史記錄：把 undo 堆疊攤成一份「做過什麼」的清單。
//
// 為什麼需要：這個 App 的每一次改動本來就存成帶標籤的快照（past / future），
// 但只能一步一步倒退。「一鍵粗剪」一次做六件事、批次一次跑好幾集之後，
// 想退回其中第三步得按六次 Ctrl+Z，而且按的過程中根本看不出退到哪了。
// Audition / Premiere / Photoshop 都有這面板，理由完全一樣。
//
// 這裡只放攤平與定位的算術。堆疊怎麼存是 store 的事，但「第幾列對應第幾步」
// 錯一格就會跳到相鄰的狀態 —— 那種錯誤在畫面上看起來像「少退了一步」，很難查。

/** 一次改動。`at` 是發生時間（epoch ms），給畫面顯示先後用。 */
export interface HistoryStep {
  label: string;
  at: number;
}

export interface HistoryRow {
  /** 0 = 初始狀態；1..N = 第 n 次改動之後的狀態。 */
  index: number;
  label: string;
  /** index 0 沒有時間。 */
  at: number | null;
  /** 這一列就是目前的狀態。 */
  current: boolean;
  /** 這一列在目前狀態之後（＝已經被復原、可以重做）。 */
  undone: boolean;
}

/**
 * past / future 攤成畫面上的列。
 *
 * **future 是反的**：復原時把 patch 推到 future 的尾巴，重做時再從尾巴取回來，
 * 所以「下一個可重做的動作」在 `future[length-1]`。攤平時要反轉，
 * 不然清單的順序會跟實際的時間順序相反。
 */
export function historyRows(past: HistoryStep[], future: HistoryStep[]): HistoryRow[] {
  const all = [...past, ...[...future].reverse()];
  const cur = past.length;
  const rows: HistoryRow[] = [{ index: 0, label: "", at: null, current: cur === 0, undone: cur < 0 }];
  all.forEach((s, i) => {
    const index = i + 1;
    rows.push({ index, label: s.label, at: s.at, current: index === cur, undone: index > cur });
  });
  return rows;
}

/** 目前停在第幾列（＝已套用幾次改動）。 */
export function currentIndex(past: HistoryStep[]): number {
  return past.length;
}

/**
 * 從目前位置跳到 `target` 需要做幾次 undo / redo。
 * 超出範圍會被夾住 —— 清單上點得到的列一定在範圍內，但 API 是公開的。
 */
export function stepsTo(past: HistoryStep[], future: HistoryStep[], target: number): { undo: number; redo: number } {
  const total = past.length + future.length;
  const t = Math.min(total, Math.max(0, Math.round(target)));
  const cur = past.length;
  return t < cur ? { undo: cur - t, redo: 0 } : { undo: 0, redo: t - cur };
}

/** 同一秒內的連續改動會很多，畫面上只給「幾分幾秒前」這種相對時間就夠。 */
export function relativeTime(at: number, nowMs: number): string {
  const s = Math.max(0, Math.round((nowMs - at) / 1000));
  if (s < 5) return "剛剛";
  if (s < 60) return `${s} 秒前`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分前`;
  return `${Math.floor(m / 60)} 小時前`;
}
