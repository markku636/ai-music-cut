// 播放期間所有的每幀工作共用這一條 requestAnimationFrame：跳播、效果增益、範圍收尾、
// store 回寫、播放線繪製。以前是五個地方各開各的 rAF，順序由掛載順序決定 ——
// 繪製若排在跳播前面，那一幀畫出來的線就落在剪除區裡，看起來像「線卡住又突然跳走」。
//
// priority 小的先跑（見 TICK_PRIORITY）；沒有訂閱者時迴圈自動停掉，暫停時不燒 CPU。

export const TICK_PRIORITY = {
  /** 跳播：先把游標挪出剪除區，後面的人才看得到正確位置。 */
  skip: 0,
  /** 效果預聽增益。 */
  effects: 10,
  /** 範圍播放（選取 / 預聽）的收尾與循環。 */
  range: 20,
  /** 回寫 playback store（會觸發 React render）。 */
  store: 30,
  /** 畫播放線 —— 一定是最後一個，才畫得到這一幀的最終位置。 */
  draw: 40,
} as const;

export type TickFn = () => void;

interface Entry {
  fn: TickFn;
  priority: number;
  seq: number;
}

let entries: Entry[] = [];
let handle: number | null = null;
let seq = 0;

/** 可替換的排程器（vitest 是 node 環境，沒有 rAF）。 */
let request: (cb: () => void) => number = (cb) => requestAnimationFrame(cb);
let cancel: (h: number) => void = (h) => cancelAnimationFrame(h);

function frame() {
  handle = null;
  // 先排下一幀再跑；某個 subscriber 丟例外也不會讓整條迴圈死掉。
  if (entries.length) handle = request(frame);
  const list = entries;
  for (let i = 0; i < list.length; i++) {
    try {
      list[i].fn();
    } catch {
      // 單一 subscriber 出錯不影響其他人
    }
  }
}

/**
 * 訂閱每幀回呼，回傳退訂函式。priority 相同時依訂閱順序。
 * 回呼裡請直接讀 `<audio>.currentTime`（不要讀 store），否則會慢一幀。
 */
export function subscribeTick(fn: TickFn, priority: number): () => void {
  const e: Entry = { fn, priority, seq: seq++ };
  entries = [...entries, e].sort((a, b) => a.priority - b.priority || a.seq - b.seq);
  if (handle === null) handle = request(frame);
  return () => {
    if (!entries.includes(e)) return;
    entries = entries.filter((x) => x !== e);
    if (!entries.length && handle !== null) {
      cancel(handle);
      handle = null;
    }
  };
}

/** 目前訂閱數（測試 / 除錯）。 */
export function tickCount(): number {
  return entries.length;
}

/** 迴圈是否還活著（測試用：退訂完應該要停）。 */
export function tickRunning(): boolean {
  return handle !== null;
}

/** 測試用：換掉排程器並清空訂閱。 */
export function __setScheduler(r: (cb: () => void) => number, c: (h: number) => void) {
  if (handle !== null) cancel(handle);
  entries = [];
  handle = null;
  seq = 0;
  request = r;
  cancel = c;
}
